import { describe, expect, it } from "vitest";
import { classify, describeKnown, type ProcessEvidence } from "../explain.rules";

const GB = 1024 ** 3;

const base: ProcessEvidence = {
  name: "something",
  pid: 1234,
  command: "/usr/local/bin/something",
  cpuPercent: 2,
  memoryBytes: 50 * 1024 * 1024,
  elapsedSeconds: 3600,
  elapsed: "01:00:00",
  cwd: "/",
  parents: [{ pid: 1, name: "launchd" }],
  children: [],
  ports: [],
  isAppleSystemBinary: false,
  machine: {
    cores: 8,
    loadPercent: 30,
    pressurePercent: 33,
    swapUsedBytes: 0,
    swapTotalBytes: 2 * GB,
  },
};

/** The reading that started all of this: 84.9% CPU, 20 seconds old. */
const xprotect: ProcessEvidence = {
  ...base,
  name: "XProtectRemediatorPirrit",
  command: "/Library/Apple/System/Library/CoreServices/XProtect.app/Contents/MacOS/XProtectRemediatorPirrit",
  cpuPercent: 84.9,
  memoryBytes: 395 * 1024 * 1024,
  elapsedSeconds: 20,
  elapsed: "00:20",
  parents: [{ pid: 3032, name: "XProtectPluginService" }],
  isAppleSystemBinary: true,
};

describe("describeKnown", () => {
  it("recognises the per-family remediators without inventing what the family is", () => {
    const known = describeKnown("XProtectRemediatorPirrit");
    expect(known?.what).toContain("malware remediation");
    expect(known?.what).toContain("Pirrit");
  });

  it("describes the processes that actually top a CPU list", () => {
    expect(describeKnown("mds_stores")?.what).toContain("Spotlight");
    expect(describeKnown("kernel_task")?.what).toContain("cool the machine");
  });

  it("returns null for anything it has no documented description of", () => {
    expect(describeKnown("some-random-binary")).toBeNull();
  });
});

describe("classify: the XProtect case", () => {
  const verdict = classify(xprotect);

  it("calls it scheduled work rather than a problem", () => {
    expect(verdict.state).toBe("just-started");
    expect(verdict.concern).toBe("none");
    expect(verdict.headline).toContain("will finish on its own");
  });

  it("says not to kill it, and why killing achieves nothing", () => {
    expect(verdict.advice.join(" ")).toContain("Wait");
    expect(verdict.advice.join(" ")).toContain("start it again later");
  });

  it("leads its evidence with the elapsed time", () => {
    expect(verdict.findings.join(" ")).toContain("00:20 ago");
    expect(verdict.findings.join(" ")).toContain("not a process that has hung");
  });

  it("names the parent that identifies the origin", () => {
    expect(verdict.findings.join(" ")).toContain("XProtectPluginService");
  });
});

describe("classify: kind comes from structure, not names", () => {
  it("treats anything under the Paseo daemon as agent-spawned, whatever it is called", () => {
    const mcp = classify({
      ...base,
      name: "npm exec @playwright/mcp",
      parents: [
        { pid: 13959, name: "claude" },
        { pid: 45907, name: "Paseo Daemon" },
      ],
    });
    expect(mcp.kind).toBe("agent-spawned");
  });

  it("does not call a system binary agent-spawned just because it is busy", () => {
    expect(classify(xprotect).kind).toBe("apple-system");
  });

  it("recognises a dev runtime by a local port even under an unfamiliar name", () => {
    const server = classify({ ...base, name: "myserver", ports: [{ port: 5173, protocol: "tcp", scope: "local" }] });
    expect(server.kind).toBe("dev-runtime");
  });
});

describe("classify: sustained load", () => {
  const hog = classify({ ...base, name: "node", cpuPercent: 92, elapsedSeconds: 7200, elapsed: "02:00:00" });

  it("separates a long burn from a fresh burst", () => {
    expect(hog.state).toBe("sustained-load");
    expect(hog.concern).toBe("act");
  });

  it("orders advice by reversibility, quitting normally before terminating", () => {
    const joined = hog.advice.join(" ");
    expect(joined.indexOf("Quit it the normal way")).toBeLessThan(joined.indexOf("terminate"));
  });

  it("names the agent session when the process belongs to one", () => {
    const agentChild = classify({
      ...base,
      cpuPercent: 92,
      elapsedSeconds: 7200,
      elapsed: "02:00:00",
      parents: [{ pid: 1, name: "Paseo Daemon" }],
    });
    expect(agentChild.advice.join(" ")).toContain("closing that session releases it");
  });

  it("points out when the machine as a whole is not overloaded", () => {
    expect(hog.findings.join(" ")).toContain("this one process is the outlier");
  });

  it("refuses to recommend killing a busy macOS component", () => {
    const system = classify({ ...xprotect, elapsedSeconds: 7200, elapsed: "02:00:00" });
    expect(system.headline).toContain("not something to kill");
    expect(system.advice.join(" ")).not.toContain("terminate");
  });
});

describe("classify: memory", () => {
  const vm = classify({ ...base, name: "com.docker.backend", memoryBytes: 3 * GB, cpuPercent: 1 });

  it("recognises idle memory hoarding, which a CPU list never shows", () => {
    expect(vm.state).toBe("memory-heavy");
    expect(vm.headline).toContain("idle but holding");
  });

  it("quantifies what quitting would free", () => {
    expect(vm.advice.join(" ")).toContain("3.0 GB");
  });

  it("mentions swapping when the machine is actually short on memory", () => {
    const swapping = classify({
      ...base,
      cpuPercent: 92,
      elapsedSeconds: 7200,
      elapsed: "02:00:00",
      machine: { ...base.machine, swapUsedBytes: 1.8 * GB },
    });
    expect(swapping.findings.join(" ")).toContain("memory is the tighter constraint");
  });
});

describe("classify: the quiet case", () => {
  it("says so plainly instead of manufacturing a concern", () => {
    const calm = classify(base);
    expect(calm.state).toBe("steady");
    expect(calm.headline).toContain("behaving normally");
    expect(calm.advice).toEqual(["Nothing to do."]);
  });
});
