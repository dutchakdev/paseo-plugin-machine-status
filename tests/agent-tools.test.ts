import { describe, expect, it } from "vitest";
import { machineReport, machineTools, registerAgentTools, withMachineTools } from "../server/agent-tools";
import type { CpuAttribution } from "../shared/attribution";
import type { Metrics } from "../shared/contracts";

const GB = 1024 ** 3;
const E = "efficiency" as const;
const P = "performance" as const;

/** The machine as it stood on 2026-11-08: saturated, load 659 on 8 cores. */
const metrics: Metrics = {
  collectedAt: "2026-11-08T21:00:00.000Z",
  hostname: "mac.local",
  platform: "Darwin 27.0.0 (arm64)",
  uptimeSeconds: 80 * 86_400,
  cpu: {
    cores: 8,
    loadAvg1: 659.41,
    loadAvg5: 448.67,
    loadAvg15: 280.17,
    loadPercent: 8242.6,
    usagePercent: 98.8,
    coreUsagePercent: [97, 98, 100, 99, 99, 100, 98, 99],
    coreKinds: [E, E, P, P, P, P, P, P],
    windowMs: 3_000,
  },
  memory: {
    totalBytes: 16 * GB,
    appBytes: 6 * GB,
    wiredBytes: 2 * GB,
    compressedBytes: 3 * GB,
    cachedBytes: 2 * GB,
    usedBytes: 11 * GB,
    freePercent: 34,
    pressurePercent: 66,
  },
  swap: { totalBytes: 2 * GB, usedBytes: 1.2 * GB, freeBytes: 0.8 * GB },
  disk: { mountedOn: "/", totalBytes: 500 * GB, usedBytes: 360 * GB, freeBytes: 140 * GB, usedPercent: 72 },
  power: { source: "ac", percent: 100, state: null, timeRemainingMinutes: null },
  thermal: { level: "unknown", cpuSpeedLimitPercent: null },
  history: [],
};

const ME = "a233f5cd-7a21-4009-b793-fc54854cce11";
const BUILDER = "b5319398-70b8-477d-811d-083e39b4276f";

const attribution: CpuAttribution = {
  collectedAt: "2026-11-08T21:00:00.000Z",
  totalPercent: 350,
  notes: [],
  groups: [
    { kind: "agent", id: BUILDER, label: "Build the iOS app", detail: "claude", cpuPercent: 107.4, processCount: 106, top: [{ pid: 1, name: "swift-frontend", cpuPercent: 100 }] },
    { kind: "agent", id: ME, label: "Fix the load pill", detail: "claude", cpuPercent: 72, processCount: 29, top: [{ pid: 2, name: "node", cpuPercent: 50.7 }] },
    { kind: "paseo", id: "paseo", label: "Paseo", detail: "daemon, app and plugins", cpuPercent: 2.3, processCount: 7, top: [] },
    { kind: "system", id: "system", label: "macOS", detail: null, cpuPercent: 165.3, processCount: 466, top: [{ pid: 3, name: "Finder", cpuPercent: 100.5 }] },
    { kind: "other", id: "other", label: "Other processes", detail: null, cpuPercent: 3, processCount: 383, top: [] },
  ],
};

describe("machineReport", () => {
  const report = machineReport(metrics, attribution, ME);

  it("leads with utilisation, and keeps load as the queue it is", () => {
    expect(report.text).toContain("CPU 99% in use across 8 cores (2 efficiency, 6 performance)");
    expect(report.text).toContain("load 659, 82.4 runnable threads per core");
    expect(report.text).not.toContain("6337%");
  });

  it("carries the prose inside the structured content, which Paseo may forward alone", () => {
    expect(report.data.summary).toBe(report.text);
    expect(Object.keys(report.data)[0]).toBe("summary");
  });

  it("tells the calling agent its own share", () => {
    expect(report.data.you).toMatchObject({ cores: 0.72, processCount: 29 });
    expect(report.text).toContain("Your processes: 0.7 cores (node 51%)");
  });

  it("names who else is using the CPU", () => {
    expect(report.text).toContain('"Build the iOS app" 1.1 cores');
    expect(report.text).toContain("macOS 1.7 cores (Finder)");
  });

  it("advises against more parallel work on a saturated machine, and says who leads", () => {
    expect(report.data.guidance).toContain("Avoid starting more parallel work");
    expect(report.data.guidance).toContain('"Build the iOS app"');
  });

  it("says there is headroom when there is", () => {
    const calm = machineReport(
      { ...metrics, cpu: { ...metrics.cpu, usagePercent: 20, loadAvg1: 2, coreUsagePercent: [20, 20, 20, 20, 20, 20, 20, 20] }, memory: { ...metrics.memory, pressurePercent: 30 } },
      attribution,
      ME,
    );
    expect(calm.data.guidance).toContain("headroom");
  });

  it("warns about memory before CPU when memory is the tighter limit", () => {
    const tight = machineReport({ ...metrics, cpu: { ...metrics.cpu, usagePercent: 30 }, memory: { ...metrics.memory, pressurePercent: 93 } }, attribution, ME);
    expect(tight.data.guidance).toContain("Memory is tight");
  });

  it("shortens chat-length agent titles and leaves out agents using next to nothing", () => {
    const noisy = machineReport(
      metrics,
      {
        ...attribution,
        groups: [
          { ...attribution.groups[0], label: "Додав \"Hey Weight.zip\" в рут цього проекту. Цей проект я в кінці хочу зібрати" },
          { kind: "agent", id: "idle", label: "Idle chat", detail: "codex", cpuPercent: 0.4, processCount: 2, top: [] },
          ...attribution.groups.slice(1),
        ],
      },
      ME,
    );
    expect(noisy.text).toContain("проекту. Цей…");
    expect(noisy.text).not.toContain("Paseo 0.0 cores");
    expect(noisy.text).not.toContain("Idle chat");
  });

  it("still reports the machine when attribution is unavailable", () => {
    const bare = machineReport(metrics, null, ME);
    expect(bare.data.you).toBeNull();
    expect(bare.text).toContain("CPU 99% in use");
  });
});

describe("withMachineTools", () => {
  const tools = machineTools();

  it("leaves a request from a daemon before 0.14 untouched: it has no tools to extend", () => {
    const old = { agentId: "a", provider: "claude", cwd: "/", env: {} };
    expect(withMachineTools(old, tools)).toBe(old);
  });

  it("appends its tools and keeps every other field", () => {
    const request = { agentId: "a", title: "t", labels: {}, tools: [{ name: "someone_else" }], env: {}, mcpServers: {} };
    const result = withMachineTools(request, tools);
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "someone_else",
      "machine_status",
      "machine_explain_process",
    ]);
    expect(result.title).toBe("t");
  });

  it("replaces its own tools rather than adding them twice", () => {
    const request = { tools: [{ name: "machine_status" }] };
    expect(withMachineTools(request, tools).tools.filter((tool: { name: string }) => tool.name === "machine_status")).toHaveLength(1);
  });

  it("names its tools the way Paseo's defineAgentTool requires", () => {
    for (const tool of tools) expect(tool.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
});

describe("registerAgentTools", () => {
  it("does nothing on a host without request hooks", () => {
    expect(() => registerAgentTools({} as never)).not.toThrow();
  });

  it("never fails an agent's start: an error inside the hook returns the request unchanged", async () => {
    let hook: ((input: { request: unknown }) => unknown) | undefined;
    registerAgentTools({ before: (_name: string, handler: typeof hook) => { hook = handler; return () => {}; } } as never);
    const poisoned = {
      get tools(): never {
        throw new Error("boom");
      },
    };
    expect(await hook!({ request: poisoned })).toBeUndefined();
  });
});
