import { describe, expect, it } from "vitest";
import {
  binaryMatchesProvider,
  collapseDuplicateBinds,
  descendantsOf,
  matchAgentRoots,
  parseDockerPs,
  parseLsofSockets,
  parseNetstatListeners,
} from "../services.server";
import {
  classifyRelevance,
  executableName,
  friendlyName,
  httpUrlFor,
  normalizeAgents,
  parseLsofAddress,
  parseNetstatAddress,
  portKey,
  scopeOf,
} from "../services.shared";
import type { RawProcess } from "../processes.server";

/** Captured verbatim from this machine. */
const NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.49165        *.*                    LISTEN
tcp4       0      0  127.0.0.1.6767         *.*                    LISTEN
tcp4       0      0  *.3620                 *.*                    LISTEN
tcp46      0      0  *.3111                 *.*                    LISTEN
tcp6       0      0  ::1.15432              *.*                    LISTEN
tcp4       0      0  192.168.68.73.52943    35.190.80.1.443        ESTABLISHED
udp46      0      0  *.57348                *.*
udp4       0      0  192.168.68.73.63569    142.251.9.84.443
`;

const LSOF = `p690
crapportd
f11
n*:49258
f12
n*:49258
p703
cControlCenter
f10
n*:7000
p15031
copencode
f10
n127.0.0.1:49165
`;

describe("parseNetstatListeners", () => {
  it("keeps only TCP sockets in LISTEN", () => {
    const tcp = parseNetstatListeners(NETSTAT).filter((row) => row.protocol === "tcp");
    expect(tcp.map((row) => row.port).sort((a, b) => a - b)).toEqual([3111, 3620, 6767, 15432, 49165]);
  });

  it("excludes established connections", () => {
    expect(parseNetstatListeners(NETSTAT).some((row) => row.port === 52943)).toBe(false);
  });

  it("keeps bound UDP sockets but not connected ones", () => {
    const udp = parseNetstatListeners(NETSTAT).filter((row) => row.protocol === "udp");
    expect(udp.map((row) => row.port)).toEqual([57348]);
  });

  it("keeps IPv6 addresses intact", () => {
    expect(parseNetstatListeners(NETSTAT).find((row) => row.port === 15432)?.address).toBe("::1");
  });

  it("ignores the header lines", () => {
    expect(parseNetstatListeners("Active Internet connections\nProto Recv-Q Send-Q\n")).toEqual([]);
  });
});

describe("parseLsofSockets", () => {
  it("carries the process across the field stream", () => {
    const sockets = parseLsofSockets(LSOF, "tcp");
    expect(sockets.find((socket) => socket.port === 7000)?.command).toBe("ControlCenter");
    expect(sockets.find((socket) => socket.port === 49165)?.pid).toBe(15031);
  });

  it("keeps full command names, which the default output truncates to nine characters", () => {
    expect(parseLsofSockets(LSOF, "tcp")[0].command).toBe("rapportd");
  });

  it("skips established connections", () => {
    expect(parseLsofSockets("p1\ncfoo\nn127.0.0.1:80->1.2.3.4:9\n", "tcp")).toEqual([]);
  });
});

describe("address parsing", () => {
  it("splits netstat's dot-separated port", () => {
    expect(parseNetstatAddress("127.0.0.1.49165")).toEqual({ address: "127.0.0.1", port: 49165 });
    expect(parseNetstatAddress("*.3620")).toEqual({ address: "*", port: 3620 });
  });

  it("splits lsof's colon-separated port and unwraps IPv6 brackets", () => {
    expect(parseLsofAddress("[::1]:15432")).toEqual({ address: "::1", port: 15432 });
  });

  it("gives both parsers the same key for the same socket", () => {
    const fromNetstat = parseNetstatAddress("::1.15432")!;
    const fromLsof = parseLsofAddress("[::1]:15432")!;
    expect(portKey("tcp", fromNetstat.address, fromNetstat.port)).toBe(
      portKey("tcp", fromLsof.address, fromLsof.port),
    );
  });
});

describe("scopeOf", () => {
  it("treats a wildcard bind as reachable", () => {
    expect(scopeOf("*")).toBe("public");
    expect(scopeOf("0.0.0.0")).toBe("public");
    expect(scopeOf("::")).toBe("public");
  });

  it("treats loopback as local", () => {
    expect(scopeOf("127.0.0.1")).toBe("local");
    expect(scopeOf("::1")).toBe("local");
  });

  it("treats a specific interface address as neither", () => {
    expect(scopeOf("192.168.68.73")).toBe("lan");
  });
});

describe("parseDockerPs", () => {
  it("reads the published port, not the container port", () => {
    const containers = parseDockerPs(
      "hl-search-pg\tpostgres:16\t0.0.0.0:5653->5432/tcp, [::]:5653->5432/tcp\n",
    );
    expect(containers[0].ports).toEqual([5653]);
  });

  it("handles a container with no published ports", () => {
    expect(parseDockerPs("worker\tbusybox\t\n")[0].ports).toEqual([]);
  });

  it("ignores blank lines", () => {
    expect(parseDockerPs("\n\n")).toEqual([]);
  });
});

describe("descendantsOf", () => {
  // The real tree observed on this machine: an agent with three MCP servers.
  const table: RawProcess[] = [
    { pid: 45907, ppid: 1, cpuPercent: 0, memoryBytes: 0, command: "Paseo Daemon" },
    { pid: 13959, ppid: 45907, cpuPercent: 0, memoryBytes: 0, command: "/Users/x/.local/bin/claude" },
    { pid: 14349, ppid: 13959, cpuPercent: 0, memoryBytes: 0, command: "npm exec @playwright/mcp@latest" },
    { pid: 14375, ppid: 13959, cpuPercent: 0, memoryBytes: 0, command: "npm exec chrome-devtools-mcp" },
    { pid: 99999, ppid: 14349, cpuPercent: 0, memoryBytes: 0, command: "node" },
    { pid: 15031, ppid: 45907, cpuPercent: 0, memoryBytes: 0, command: "/Users/x/.opencode/bin/opencode" },
  ];

  it("finds the whole subtree, not just direct children", () => {
    expect(descendantsOf(13959, table).map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([
      14349, 14375, 99999,
    ]);
  });

  it("excludes the root itself", () => {
    expect(descendantsOf(13959, table).some((entry) => entry.pid === 13959)).toBe(false);
  });

  it("does not leak into a sibling agent's subtree", () => {
    expect(descendantsOf(15031, table)).toEqual([]);
  });

  it("terminates on a cycle", () => {
    const cyclic: RawProcess[] = [
      { pid: 1, ppid: 2, cpuPercent: 0, memoryBytes: 0, command: "a" },
      { pid: 2, ppid: 1, cpuPercent: 0, memoryBytes: 0, command: "b" },
    ];
    expect(descendantsOf(1, cyclic).map((entry) => entry.pid)).toEqual([2]);
  });
});

describe("binaryMatchesProvider", () => {
  it("rejects the real false positives on this machine", () => {
    // A substring test reports every one of these as an agent.
    expect(binaryMatchesProvider("ampdevicediscoveryagent", "amp")).toBe(false);
    expect(binaryMatchesProvider("cursoruiviewservice", "cursor")).toBe(false);
    expect(binaryMatchesProvider("campo", "amp")).toBe(false);
  });

  it("accepts an exact binary", () => {
    expect(binaryMatchesProvider("claude", "claude")).toBe(true);
    expect(binaryMatchesProvider("opencode", "opencode")).toBe(true);
  });

  it("accepts a suffixed binary at a word boundary", () => {
    expect(binaryMatchesProvider("gemini-cli", "gemini")).toBe(true);
  });

  it("rejects an empty provider", () => {
    expect(binaryMatchesProvider("anything", "")).toBe(false);
  });
});

describe("matchAgentRoots", () => {
  const children = [
    { pid: 13959, ppid: 45907, cpuPercent: 0, memoryBytes: 0, command: "/Users/x/.local/bin/claude", cwd: "/work/a" },
    { pid: 67616, ppid: 45907, cpuPercent: 0, memoryBytes: 0, command: "/Users/x/.local/bin/claude", cwd: "/work/b" },
    { pid: 15031, ppid: 45907, cpuPercent: 0, memoryBytes: 0, command: "/Users/x/.opencode/bin/opencode", cwd: "/work/c" },
    { pid: 17527, ppid: 45907, cpuPercent: 0, memoryBytes: 0, command: "/Users/x/esbuild", cwd: "/work/a" },
    { pid: 45908, ppid: 45907, cpuPercent: 0, memoryBytes: 0, command: "node", cwd: "/work/a" },
  ];
  const agents = [
    { id: "a1", provider: "claude", cwd: "/work/b", title: "Second" },
    { id: "a2", provider: "claude", cwd: "/work/a", title: "First" },
    { id: "a3", provider: "opencode", cwd: "/work/c", title: "Third" },
  ];

  it("uses cwd to tell two agents of the same provider apart", () => {
    const roots = matchAgentRoots(children, agents, new Set());
    expect(roots.find((root) => root.pid === 13959)?.title).toBe("First");
    expect(roots.find((root) => root.pid === 67616)?.title).toBe("Second");
  });

  it("leaves Paseo's own helpers out", () => {
    const roots = matchAgentRoots(children, agents, new Set());
    expect(roots.some((root) => root.pid === 17527)).toBe(false);
    expect(roots.some((root) => root.pid === 45908)).toBe(false);
  });

  it("never claims one agent twice", () => {
    const ids = matchAgentRoots(children, agents, new Set()).map((root) => root.title);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("honours the exclusion set, which is how the plugin skips itself", () => {
    expect(matchAgentRoots(children, agents, new Set([13959])).some((r) => r.pid === 13959)).toBe(false);
  });

  it("reports nothing when the daemon has no agents", () => {
    expect(matchAgentRoots(children, [], new Set())).toEqual([]);
  });
});

describe("normalizeAgents", () => {
  it("reads the daemon's documented shape", () => {
    const agents = normalizeAgents({
      agents: [{ id: "1", provider: "claude", cwd: "/w", title: "T", status: "running" }],
    });
    expect(agents).toEqual([
      { id: "1", provider: "claude", cwd: "/w", title: "T", status: "running" },
    ]);
  });

  it("survives a bare array, in case the SDK returns one", () => {
    expect(normalizeAgents([{ id: "1", provider: "codex", cwd: "", title: "", status: "" }])).toHaveLength(1);
  });

  it("reduces a provider/model selection to the binary name", () => {
    expect(normalizeAgents([{ id: "1", provider: "codex/gpt-5.5" }])[0].provider).toBe("codex");
  });

  it("drops entries with no provider rather than inventing one", () => {
    expect(normalizeAgents([{ id: "1" }, { id: "2", provider: "claude" }])).toHaveLength(1);
  });

  it("returns nothing for an unexpected shape instead of throwing", () => {
    expect(normalizeAgents(null)).toEqual([]);
    expect(normalizeAgents("nope")).toEqual([]);
  });
});

describe("friendlyName", () => {
  it("names binaries it recognises", () => {
    expect(friendlyName("/usr/local/bin/postgres")).toBe("PostgreSQL");
    expect(friendlyName("com.docker.backend")).toBe("Docker");
  });

  it("falls back to the real command rather than inventing a service", () => {
    expect(friendlyName("/opt/homebrew/bin/some-daemon")).toBe("some-daemon");
  });
});

describe("httpUrlFor", () => {
  it("offers a loopback URL for a local TCP port", () => {
    expect(httpUrlFor({ protocol: "tcp", scope: "local", port: 3000 })).toBe("http://127.0.0.1:3000");
  });

  it("does not offer to open UDP", () => {
    expect(httpUrlFor({ protocol: "udp", scope: "public", port: 41641 })).toBeNull();
  });

  it("does not guess a URL for a port bound to one interface", () => {
    expect(httpUrlFor({ protocol: "tcp", scope: "lan", port: 8080 })).toBeNull();
  });
});

describe("classifyRelevance", () => {
  const home = "/Users/dev";
  const classify = (command: string, extra: Partial<Parameters<typeof classifyRelevance>[0]> = {}) =>
    classifyRelevance({ kind: "process", command, owner: "you", home, ...extra });

  it("hides the macOS services observed listening on this machine", () => {
    // AirPlay on 5000/7000, Remote Desktop on 3283, Handoff on an ephemeral port.
    expect(classify("/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter")).toBe("system");
    expect(classify("/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/MacOS/ARDAgent")).toBe("system");
    expect(classify("/usr/libexec/rapportd")).toBe("system");
  });

  it("keeps the development runtimes observed listening on this machine", () => {
    expect(classify("/Users/dev/dev/analytics-tool/.venv/bin/python")).toBe("dev");
    expect(classify("../../.venv/bin/python")).toBe("dev");
    expect(classify("/Users/dev/.opencode/bin/opencode")).toBe("dev");
    expect(classify("next-server (v16.3.1)")).toBe("dev");
    expect(classify("kubectl")).toBe("dev");
    expect(classify("bun")).toBe("dev");
    expect(classify("Paseo Daemon")).toBe("dev");
  });

  it("keeps Docker even though it lives in /Applications", () => {
    expect(classify("/Applications/Docker.app/Contents/MacOS/com.docker.backend")).toBe("dev");
  });

  it("keeps anything attributed to an agent or a container, whatever it is called", () => {
    expect(classify("/System/Library/weird", { kind: "agent" })).toBe("dev");
    expect(classify("anything", { kind: "agent-child" })).toBe("dev");
    expect(classify("anything", { kind: "docker" })).toBe("dev");
  });

  it("treats a socket it cannot inspect as system rather than claiming it", () => {
    expect(classify("", { owner: "other", kind: null })).toBe("system");
  });

  it("keeps a self-built binary under the home directory", () => {
    expect(classify("/Users/dev/dev/myproject/target/release/myserver")).toBe("dev");
  });

  it("excludes per-user daemons that live in the home Library tree", () => {
    expect(classify("/Users/dev/Library/Application Support/Foo/foo-helper")).toBe("system");
  });

  it("does not classify by port number, which cannot separate these cases", () => {
    // 7000 is AirPlay here; a dev server on 7000 would still be dev.
    expect(classify("/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter")).toBe("system");
    expect(classify("/Users/dev/dev/api/server")).toBe("dev");
  });
});

describe("executableName", () => {
  it("strips a version suffix", () => {
    expect(executableName("next-server (v16.3.1)")).toBe("next-server");
  });

  it("reduces a path to its basename", () => {
    expect(executableName("/Users/x/.venv/bin/python")).toBe("python");
  });

  it("handles a relative path", () => {
    expect(executableName("../../.venv/bin/python")).toBe("python");
  });

  it("leaves a spaced command name alone", () => {
    expect(executableName("Paseo Daemon")).toBe("Paseo Daemon");
  });
});

describe("collapseDuplicateBinds", () => {
  const row = (over: Partial<Parameters<typeof collapseDuplicateBinds>[0][number]> = {}) => ({
    protocol: "tcp",
    port: 15432,
    pid: 12431,
    address: "127.0.0.1",
    scope: "local" as const,
    ...over,
  });

  it("merges the IPv4 and IPv6 halves of one port-forward", () => {
    const rows = [row(), row({ address: "::1" })];
    expect(collapseDuplicateBinds(rows)).toHaveLength(1);
  });

  it("prefers IPv4 when both binds are equally reachable", () => {
    expect(collapseDuplicateBinds([row({ address: "::1" }), row()])[0].address).toBe("127.0.0.1");
  });

  it("keeps the widest bind, because that is what decides reachability", () => {
    const rows = [row(), row({ address: "*", scope: "public" })];
    expect(collapseDuplicateBinds(rows)[0].scope).toBe("public");
  });

  it("keeps two processes on the same port apart", () => {
    expect(collapseDuplicateBinds([row(), row({ pid: 999 })])).toHaveLength(2);
  });

  it("does not merge sockets with no visible owner, since nothing links them", () => {
    const rows = [row({ pid: null, address: "127.0.0.1" }), row({ pid: null, address: "::1" })];
    expect(collapseDuplicateBinds(rows)).toHaveLength(2);
  });

  it("keeps different ports of the same process", () => {
    expect(collapseDuplicateBinds([row(), row({ port: 19090 })])).toHaveLength(2);
  });
});

describe("normalizeAgents, CLI shape", () => {
  it("expands the tilde path the Paseo CLI prints", () => {
    const [agent] = normalizeAgents(
      [{ id: "1", provider: "claude/claude-opus-5", cwd: "~/dev/paseo-plugins", name: "Work" }],
      "/Users/dev",
    );
    expect(agent.cwd).toBe("/Users/dev/dev/paseo-plugins");
  });

  it("leaves an absolute path alone, which is what the SDK returns", () => {
    expect(normalizeAgents([{ id: "1", provider: "claude", cwd: "/abs/path" }], "/home")[0].cwd).toBe("/abs/path");
  });

  it("reads the CLI's `name` when there is no `title`", () => {
    expect(normalizeAgents([{ id: "1", provider: "claude", name: "Work" }])[0].title).toBe("Work");
  });
});
