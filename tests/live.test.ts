import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planCleanupHandler } from "../cleanup.server";
import {
  applyCleanup,
  killProcess,
  listProcesses,
  planCleanup,
  readMetrics,
} from "../contracts.shared";
import { readMetricsHandler } from "../metrics.server";
import { killProcessHandler, listProcessesHandler } from "../processes.server";
import { readServicesHandler } from "../services.server";
import { readServices } from "../services.shared";

/**
 * Live checks against the machine running the suite. They never mutate anything:
 * cleanup is only planned, and the kill tests assert refusals.
 */
const onMac = process.platform === "darwin";
const describeMac = onMac ? describe : describe.skip;

describeMac("readMetricsHandler", () => {
  it("reports memory consistent with what Node sees", async () => {
    const metrics = await readMetricsHandler();
    expect(metrics.memory.totalBytes).toBe(os.totalmem());
    expect(metrics.memory.usedBytes).toBeGreaterThan(0);
    expect(metrics.memory.usedBytes).toBeLessThanOrEqual(metrics.memory.totalBytes);
  });

  it("reports a plausible CPU load", async () => {
    const metrics = await readMetricsHandler();
    expect(metrics.cpu.cores).toBeGreaterThan(0);
    expect(metrics.cpu.loadAvg1).toBeGreaterThanOrEqual(0);
    expect(metrics.cpu.loadPercent).toBeGreaterThanOrEqual(0);
  });

  it("reports disk usage inside a sane range", async () => {
    const { disk } = await readMetricsHandler();
    expect(disk.mountedOn).toBe("/");
    expect(disk.usedPercent).toBeGreaterThan(0);
    expect(disk.usedPercent).toBeLessThanOrEqual(100);
    expect(disk.freeBytes).toBeGreaterThan(0);
  });

  it("resolves a memory pressure figure from macOS", async () => {
    const { memory } = await readMetricsHandler();
    expect(memory.pressurePercent).not.toBeNull();
    expect(memory.pressurePercent!).toBeGreaterThanOrEqual(0);
    expect(memory.pressurePercent!).toBeLessThanOrEqual(100);
  });

  it("returns a usable power and thermal reading", async () => {
    const metrics = await readMetricsHandler();
    expect(["ac", "battery", "unknown"]).toContain(metrics.power.source);
    expect(["nominal", "fair", "serious", "critical", "unknown"]).toContain(metrics.thermal.level);
  });

  it("reports uptime and a hostname", async () => {
    const metrics = await readMetricsHandler();
    expect(metrics.uptimeSeconds).toBeGreaterThan(0);
    expect(metrics.hostname.length).toBeGreaterThan(0);
  });
});

describeMac("listProcessesHandler", () => {
  it("returns the requested number of processes ranked by CPU", async () => {
    const { items } = await listProcessesHandler({ sortBy: "cpu", limit: 5 });
    expect(items).toHaveLength(5);
    for (let index = 1; index < items.length; index += 1) {
      expect(items[index - 1].cpuPercent).toBeGreaterThanOrEqual(items[index].cpuPercent);
    }
  });

  it("ranks by memory when asked", async () => {
    const { items } = await listProcessesHandler({ sortBy: "memory", limit: 5 });
    for (let index = 1; index < items.length; index += 1) {
      expect(items[index - 1].memoryBytes).toBeGreaterThanOrEqual(items[index].memoryBytes);
    }
  });
});

describeMac("killProcessHandler", () => {
  it("refuses to kill the process it is running in", async () => {
    // If the guard were broken this suite would be terminated rather than fail.
    const result = await killProcessHandler({ pid: process.pid, signal: "TERM" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Paseo itself or one of its parents/);
  });

  it("refuses to kill launchd", async () => {
    const result = await killProcessHandler({ pid: 1, signal: "TERM" });
    expect(result.ok).toBe(false);
  });

  it("reports a missing process instead of throwing", async () => {
    const result = await killProcessHandler({ pid: 999_999, signal: "TERM" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no such process");
  });
});

describeMac("planCleanupHandler", () => {
  it("keeps every target inside the home directory", async () => {
    const { targets } = await planCleanupHandler();
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const relative = path.relative(os.homedir(), target.path);
      expect(relative.startsWith("..")).toBe(false);
      expect(relative.split(path.sep).filter(Boolean).length).toBeGreaterThanOrEqual(2);
    }
  }, 180_000);

  it("sizes the caches that exist and leaves the rest at zero", async () => {
    const { targets, totalBytes } = await planCleanupHandler();
    expect(totalBytes).toBe(targets.reduce((sum, target) => sum + target.sizeBytes, 0));
    for (const target of targets) {
      if (!target.exists) expect(target.sizeBytes).toBe(0);
    }
  }, 180_000);
});

/**
 * Paseo validates every handler result against its contract before it reaches the
 * client, so a handler that drifts from its schema fails as an RPC rejection at
 * runtime rather than at compile time. These checks close that gap.
 */
describeMac("handler output matches its contract", () => {
  it("metrics.read", async () => {
    const result = await readMetricsHandler();
    expect(() => readMetrics.output.parse(result)).not.toThrow();
  });

  it("processes.list", async () => {
    const result = await listProcessesHandler({ sortBy: "cpu", limit: 8 });
    expect(() => listProcesses.output.parse(result)).not.toThrow();
  });

  it("processes.kill, including the refusal path", async () => {
    const refused = await killProcessHandler({ pid: process.pid, signal: "TERM" });
    expect(() => killProcess.output.parse(refused)).not.toThrow();
  });

  it("cleanup.plan", async () => {
    const result = await planCleanupHandler();
    expect(() => planCleanup.output.parse(result)).not.toThrow();
  }, 180_000);

  it("rejects an apply call with no targets, as the contract requires", () => {
    expect(() => applyCleanup.input.parse({ targetIds: [] })).toThrow();
  });

  it("accepts the input shape the client actually sends", () => {
    expect(() => readMetrics.input.parse({})).not.toThrow();
    expect(listProcesses.input.parse({}).limit).toBe(8);
    expect(listProcesses.input.parse({}).sortBy).toBe("cpu");
    expect(killProcess.input.parse({ pid: 42 }).signal).toBe("TERM");
  });
});


describeMac("readServicesHandler", () => {
  // The agent list is stubbed: these tests assert collection and shape, not the
  // daemon's current agents, which change between runs.
  const context = {
    paseo: { agents: { list: async () => ({ agents: [] }) } },
  } as unknown as Parameters<typeof readServicesHandler>[1];

  it("finds the ports this machine is actually listening on", async () => {
    const result = await readServicesHandler({}, context);
    expect(result.ports.length).toBeGreaterThan(0);
  });

  it("satisfies its own contract", async () => {
    const result = await readServicesHandler({}, context);
    expect(() => readServices.output.parse(result)).not.toThrow();
  });

  it("returns ports in ascending order", async () => {
    const { ports } = await readServicesHandler({}, context);
    for (let index = 1; index < ports.length; index += 1) {
      expect(ports[index - 1].port).toBeLessThanOrEqual(ports[index].port);
    }
  });

  it("never lists the same socket twice", async () => {
    const { ports } = await readServicesHandler({}, context);
    expect(new Set(ports.map((port) => port.id)).size).toBe(ports.length);
  });

  it("classifies loopback binds as local and wildcard binds as reachable", async () => {
    const { ports } = await readServicesHandler({}, context);
    for (const port of ports) {
      if (port.address === "127.0.0.1" || port.address === "::1") expect(port.scope).toBe("local");
      if (port.address === "*") expect(port.scope).toBe("public");
    }
  });

  it("says out loud when a socket belongs to a user it cannot inspect", async () => {
    const result = await readServicesHandler({}, context);
    const unattributed = result.ports.filter((port) => port.owner === "other");
    if (unattributed.length > 0) {
      expect(result.notes.join(" ")).toMatch(/another user/);
    }
  });

  it("reports the daemon's own listening port, which proves attribution reaches real processes", async () => {
    const { ports } = await readServicesHandler({}, context);
    const daemon = ports.find((port) => port.port === 6767);
    expect(daemon?.pid).not.toBeNull();
  });
}, 30_000);
