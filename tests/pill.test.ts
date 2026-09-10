import { describe, expect, it } from "vitest";
import { pillReading, agentPorts, cpuSeverity, memorySeverity } from "../shared/pill";
import type { PortRow } from "../shared/services";

describe("pillReading", () => {
  it("shows both numbers, because they fail in different ways", () => {
    expect(pillReading(28, 41).text).toBe("28% · 41%");
  });

  it("rounds rather than showing a decimal in a space this small", () => {
    expect(pillReading(28.4, 41.6).text).toBe("28% · 42%");
  });

  it("stays calm when both readings are low", () => {
    expect(pillReading(20, 30).severity).toBe("good");
  });

  it("takes the worse of the two, so one colour can speak for both", () => {
    // CPU is fine, memory is not: the pill still warns.
    expect(pillReading(10, 95).severity).toBe("critical");
    expect(pillReading(95, 10).severity).toBe("critical");
  });

  it("warns on memory earlier than on CPU, since swapping hurts sooner", () => {
    expect(pillReading(75, 0).severity).toBe("warning");
    expect(pillReading(0, 85).severity).toBe("warning");
    expect(pillReading(0, 75).severity).toBe("good");
  });

  it("shows a dash rather than a zero when macOS reports no pressure", () => {
    const reading = pillReading(30, null);
    expect(reading.text).toBe("30% · —");
    expect(reading.severity).toBe("good");
  });

  it("says which number is which where there is room to", () => {
    expect(pillReading(28, 41).label).toBe("Machine load: CPU 28%, memory 41%");
  });
})

describe("shared thresholds", () => {
  it("colours the pill and its card from the same thresholds", () => {
    expect(cpuSeverity(74)).toBe("good");
    expect(cpuSeverity(75)).toBe("warning");
    expect(cpuSeverity(90)).toBe("critical");
    expect(memorySeverity(79)).toBe("good");
    expect(memorySeverity(80)).toBe("warning");
    expect(memorySeverity(92)).toBe("critical");
    expect(memorySeverity(null)).toBe("good");
  });
});

describe("agentPorts", () => {
  const row = (over: Partial<PortRow>): PortRow => ({
    id: "p", port: 3000, protocol: "tcp", address: "127.0.0.1", scope: "local", pid: 1,
    command: "node", owner: "you", relevance: "dev", attribution: null, url: null, ...over,
  });
  const agent = (label: string) => ({ kind: "agent" as const, label, detail: "" });
  const child = (label: string) => ({ kind: "agent-child" as const, label, detail: "" });

  it("keeps development ports held by an agent or its child, once per port", () => {
    const rows = [
      row({ id: "a", port: 5173, attribution: child("claude") }),
      row({ id: "b", port: 5173, address: "::1", attribution: child("claude") }),
      row({ id: "c", port: 3001, attribution: agent("codex") }),
      row({ id: "d", port: 5432, attribution: { kind: "docker", label: "postgres", detail: "" } }),
      row({ id: "e", port: 7000, relevance: "system", attribution: agent("claude") }),
      row({ id: "f", port: 4000, attribution: null }),
    ];
    expect(agentPorts(rows).map((port) => port.port)).toEqual([3001, 5173]);
  });

  it("stops at the limit", () => {
    const rows = [3000, 3001, 3002, 3003, 3004].map((port) => row({ id: String(port), port, attribution: agent("claude") }));
    expect(agentPorts(rows)).toHaveLength(3);
    expect(agentPorts(rows, 5)).toHaveLength(5);
  });
});
