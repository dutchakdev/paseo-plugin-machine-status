import { describe, expect, it } from "vitest";
import { envAgentRoots, groupCpu, listAgents, ownersByPid, parseAgentIds, type AgentRef } from "../server/attribution";
import type { RawProcess } from "../server/processes";
import { summarizeOwners } from "../shared/attribution";

/**
 * `ps -wwE -o pid=,command= -p …` on an M1 Pro, 2026-11-08. The environment is
 * trimmed to three harmless keys and arguments are dropped: the real lines carry
 * every exported secret, and `--mcp-config` JSON. Spacing, order and the shape
 * of each line are as captured; the home directory is renamed.
 */
const PS_ENV = `  145 /Users/dev/.cache/frida/frida-a715bf0edbfbc6a65347026a38337c6e/frida-helper LANG=en_US.UTF-8 SHELL=/bin/zsh PASEO_AGENT_ID=573fb05d-46e3-4113-ab05-0a8db067c278
23231 Paseo Daemon
24020 /Users/dev/.nvm/versions/node/v22.23.0/bin/node SHELL=/bin/bash LANG=en_US.UTF-8 PASEO_AGENT_ID=605ce3bf-1213-4302-a5d8-091ccc0a3893
33228 node SHELL=/bin/bash LANG=en_US.UTF-8 PASEO_AGENT_ID=a233f5cd-7a21-4009-b793-fc54854cce11
53542 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
`;

const CLAUDE = "a233f5cd-7a21-4009-b793-fc54854cce11";
const OPENCODE = "573fb05d-46e3-4113-ab05-0a8db067c278";
/** A closed kimi agent whose terminal once restarted the daemon: every plugin host inherited its id. */
const KIMI = "605ce3bf-1213-4302-a5d8-091ccc0a3893";

const agents: AgentRef[] = [
  { id: CLAUDE, provider: "claude", title: "Fix the load pill", cwd: "/Users/dev/dev/paseo-plugins" },
  { id: OPENCODE, provider: "opencode", title: "", cwd: "/Users/dev/dev/hand-computer" },
  { id: KIMI, provider: "kimi", title: "Old kimi chat", cwd: "/Users/dev" },
];

const proc = (pid: number, ppid: number, cpuPercent: number, command: string): RawProcess => ({
  pid,
  ppid,
  cpuPercent,
  memoryBytes: 0,
  command,
});

/** The daemon's neighbourhood as it stood: supervisor → daemon → plugin hosts and agents. */
const table: RawProcess[] = [
  proc(1, 0, 0.1, "/sbin/launchd"),
  proc(17365, 1, 0, "Paseo Supervisor"),
  proc(23231, 17365, 43.1, "Paseo Daemon"),
  proc(24020, 23231, 1.2, "/Users/dev/.nvm/versions/node/v22.23.0/bin/node"), // plugin host
  proc(24099, 24020, 0.4, "/usr/bin/vm_stat"), // a plugin's own command
  proc(33228, 23231, 2.0, "node"), // claude-launcher
  proc(33293, 33228, 4.3, "/Users/dev/.local/bin/claude"),
  proc(36937, 33293, 81.1, "/Applications/SolidCraft.app/Contents/MacOS/solidcraft-cli"),
  proc(145, 1, 0, "/Users/dev/.cache/frida/frida-a715bf0edbfbc6a65347026a38337c6e/frida-helper"),
  proc(53542, 1, 99.1, "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"),
  proc(80369, 1, 16.4, "/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine"),
  proc(3635, 1, 16.1, "/Users/dev/dev/hand-computer/.venv/bin/python"),
];

describe("parseAgentIds", () => {
  const ids = parseAgentIds(PS_ENV);

  it("keeps the agent id from each environment and nothing else", () => {
    expect(ids.get(33228)).toBe(CLAUDE);
    expect(ids.get(145)).toBe(OPENCODE);
    expect([...ids.values()].some((value) => value.includes("UTF-8"))).toBe(false);
  });

  it("has no entry for a process whose environment ps could not show", () => {
    expect(ids.has(23231)).toBe(false);
    expect(ids.has(53542)).toBe(false);
  });

  it("takes the last occurrence, since the environment follows the arguments", () => {
    const line = `  900 sh -c echo PASEO_AGENT_ID=${KIMI} PASEO_AGENT_ID=${CLAUDE}\n`;
    expect(parseAgentIds(line).get(900)).toBe(CLAUDE);
  });

  it("ignores a variable whose name merely ends the same way", () => {
    expect(parseAgentIds(`  901 node OLD_PASEO_AGENT_ID=${CLAUDE}\n`).has(901)).toBe(false);
  });
});

describe("ownersByPid", () => {
  const owners = ownersByPid({
    table,
    envIds: parseAgentIds(PS_ENV),
    agents,
    inheritedId: KIMI,
  });

  it("gives an agent the processes below it, whatever they are called", () => {
    expect(owners.get(33228)?.id).toBe(CLAUDE);
    expect(owners.get(36937)?.id).toBe(CLAUDE);
  });

  it("follows an agent's id to a process that left the tree", () => {
    // frida-helper was reparented to launchd 78 days ago; its environment still names the agent.
    expect(owners.get(145)?.id).toBe(OPENCODE);
  });

  it("does not take the id every plugin host inherited as evidence", () => {
    expect(owners.has(24020)).toBe(false);
    expect(owners.has(24099)).toBe(false);
  });

  it("ignores an id that names no agent Paseo knows", () => {
    const stray = ownersByPid({ table, envIds: new Map([[3635, "not-an-agent"]]), agents, inheritedId: null });
    expect(stray.has(3635)).toBe(false);
  });

  it("uses provider-and-cwd roots where the environment says nothing", () => {
    const fallback = ownersByPid({
      table,
      envIds: new Map(),
      agents,
      inheritedId: null,
      fallbackRoots: new Map([[33293, CLAUDE]]),
    });
    expect(fallback.get(36937)?.id).toBe(CLAUDE);
    expect(fallback.has(33228)).toBe(false);
  });

  it("terminates on a parent cycle", () => {
    const cyclic = [proc(10, 11, 1, "a"), proc(11, 10, 1, "b")];
    expect(ownersByPid({ table: cyclic, envIds: new Map(), agents, inheritedId: null }).size).toBe(0);
  });
});

describe("envAgentRoots", () => {
  it("finds the daemon children an agent runs as, by id rather than binary name", () => {
    const children = table.filter((entry) => entry.ppid === 23231);
    const roots = envAgentRoots(children, parseAgentIds(PS_ENV), agents, KIMI);
    // The launcher is called "node", which provider matching cannot pair with "claude".
    expect(roots.map((root) => [root.pid, root.provider, root.title])).toEqual([[33228, "claude", "Fix the load pill"]]);
  });
});

describe("groupCpu", () => {
  const owners = ownersByPid({ table, envIds: parseAgentIds(PS_ENV), agents, inheritedId: KIMI });
  const groups = groupCpu(table, owners, { daemonPid: 23231, selfPid: 24020 });
  const group = (id: string) => groups.find((entry) => entry.id === id)!;

  it("adds up each agent's processes, including what it started", () => {
    expect(group(CLAUDE)).toMatchObject({ kind: "agent", label: "Fix the load pill", processCount: 3 });
    expect(group(CLAUDE).cpuPercent).toBeCloseTo(2 + 4.3 + 81.1);
  });

  it("names the heaviest processes inside a group", () => {
    expect(group(CLAUDE).top[0]).toMatchObject({ pid: 36937, name: "solidcraft-cli" });
  });

  it("falls back to the provider when an agent has no title", () => {
    expect(group(OPENCODE).label).toBe("opencode agent");
  });

  it("counts Paseo's own processes apart from its agents", () => {
    // Daemon, supervisor and the plugin host with its vm_stat.
    expect(group("paseo").cpuPercent).toBeCloseTo(43.1 + 1.2 + 0.4);
    expect(group("paseo").kind).toBe("paseo");
  });

  it("files macOS components by where their binary lives", () => {
    expect(group("system").cpuPercent).toBeCloseTo(0.1 + 99.1 + 16.4);
  });

  it("leaves the rest as other processes, without guessing whose they are", () => {
    expect(group("other").cpuPercent).toBeCloseTo(16.1);
    expect(group("other").top[0].name).toBe("python");
  });

  it("puts agents first, heaviest first, then Paseo, macOS and the rest", () => {
    expect(groups.map((entry) => entry.id)).toEqual([CLAUDE, OPENCODE, "paseo", "system", "other"]);
  });
});

describe("summarizeOwners", () => {
  const owners = ownersByPid({ table, envIds: parseAgentIds(PS_ENV), agents, inheritedId: KIMI });
  const summary = summarizeOwners(groupCpu(table, owners, { daemonPid: 23231, selfPid: 24020 }));

  it("keeps four bands in a fixed order, so each keeps its colour", () => {
    expect(summary.segments.map((segment) => segment.kind)).toEqual(["agents", "paseo", "system", "other"]);
  });

  it("adds every agent into one band", () => {
    expect(summary.segments[0].cpuPercent).toBeCloseTo(87.4);
  });

  it("lists only the agents using CPU, and counts the rest", () => {
    expect(summary.agents.map((agent) => agent.id)).toEqual([CLAUDE]);
    expect(summary.idleAgents).toBe(1);
  });

  it("totals the same figure as the bands", () => {
    expect(summary.totalPercent).toBeCloseTo(summary.segments.reduce((sum, segment) => sum + segment.cpuPercent, 0));
  });
});

describe("listAgents", () => {
  const entry = (id: string) => ({ agent: { id, provider: "claude", cwd: "/w", title: id, status: "idle" } });

  it("reads every page of the SDK's wrapped entries", async () => {
    const pages: Record<string, unknown> = {
      first: { entries: [entry("a"), entry("b")], pageInfo: { hasMore: true, nextCursor: "c1" } },
      c1: { entries: [entry("c")], pageInfo: { hasMore: false, nextCursor: null } },
    };
    const paseo = {
      agents: { list: async (options?: { page?: { cursor?: string } }) => pages[options?.page?.cursor ?? "first"] },
    } as never;
    expect((await listAgents(paseo)).map((agent) => agent.id)).toEqual(["a", "b", "c"]);
  });

  it("stops when a page hands back the cursor it was asked for", async () => {
    let calls = 0;
    const paseo = {
      agents: {
        list: async () => {
          calls += 1;
          return { entries: [entry(`x${calls}`)], pageInfo: { hasMore: true, nextCursor: "same" } };
        },
      },
    } as never;
    await listAgents(paseo);
    expect(calls).toBe(2);
  });
});
