import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { parseLinuxCpuTimes, usageBetween } from "../server/cpu";
import { parseMeminfo, parsePsi } from "../server/linux-metrics";
import { readMetricsHandler } from "../server/metrics";
import { parseLinuxProcessStat, readTable } from "../server/processes";
import { parseSs, readServicesHandler } from "../server/services";
import { readMetrics } from "../shared/contracts";
import { readServices } from "../shared/services";

it("uses available memory rather than subtracting the page cache", () => {
  const { memory, swap } = parseMeminfo(
    "MemTotal: 1000 kB\nMemAvailable: 600 kB\nCached: 500 kB\nShmem: 100 kB\nSwapTotal: 100 kB\nSwapFree: 90 kB\n",
  );
  expect(memory).toMatchObject({ usedBytes: 400 * 1024, cachedBytes: 400 * 1024, freePercent: 60, pressurePercent: null });
  expect(swap.usedBytes).toBe(10 * 1024);
  expect(parsePsi("some avg10=0.42 avg60=0.21 avg300=0.10 total=483\n")).toBe(0.42);
  expect(parsePsi(null)).toBeNull();
});

it("counts Linux I/O wait as idle and steal time as busy without counting guest time twice", () => {
  const before = parseLinuxCpuTimes("cpu0 0 0 0 0 0 0 0 0 0 0");
  const after = parseLinuxCpuTimes("cpu0 1 0 1 2 2 1 1 2 1 0");
  expect(usageBetween(before, after).overall).toBe(60);
});

it("reads process counters after an executable name containing parentheses", () => {
  expect(parseLinuxProcessStat("42 (my ) app) S 1 2 3 4 5 6 7 8 9 10 77 23 0 0 20 0 1 0 12345 0"))
    .toEqual({ ticks: 100, started: 12345 });
});

it("keeps listening sockets without a readable PID", () => {
  const result = parseSs('tcp LISTEN 0 4096 [::]:6767 [::]:* users:(("paseo",pid=781,fd=11))\n' +
    'udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\n');
  expect(result.listeners).toHaveLength(2);
  expect(result.sockets).toEqual([{ protocol: "tcp", address: "::", port: 6767, command: "paseo", pid: 781 }]);
});

describe.skipIf(process.platform !== "linux")("Linux live collectors", () => {
  it("returns valid host counters and the running process", async () => {
    const metrics = readMetrics.output.parse(await readMetricsHandler());
    expect(metrics.os).toBe("linux");
    expect(metrics.memory.usedBytes).toBeGreaterThan(0);
    expect(metrics.memory.usedBytes).toBeLessThanOrEqual(metrics.memory.totalBytes);
    expect(metrics.cpu.usagePercent).not.toBeNull();
    expect(metrics.disk.totalBytes).toBeGreaterThan(0);
    expect((await readTable()).find(({ pid }) => pid === process.pid)?.cpuSeconds).toBeGreaterThanOrEqual(0);
  });

  it("finds a real TCP listener and attributes it to the current PID", async () => {
    const context = { paseo: { agents: { list: async () => ({ agents: [] }) } } } as unknown as Parameters<typeof readServicesHandler>[1];
    const socket = createServer().listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => socket.once("listening", resolve).once("error", reject));
      const binding = socket.address();
      if (!binding || typeof binding === "string") throw new Error("Expected TCP listener");
      const result = readServices.output.parse(await readServicesHandler({}, context));
      expect(result.ports.find(({ port }) => port === binding.port)).toMatchObject({ pid: process.pid, scope: "local" });
    } finally {
      socket.close();
    }
  });

  it("attributes a listener outside a matched agent process tree by its environment", async () => {
    const agent = { id: "linux-test-agent", provider: "codex", cwd: process.cwd(), title: "Linux test agent" };
    const context = {
      paseo: { agents: { list: async () => ({ agents: [agent] }) } },
    } as unknown as Parameters<typeof readServicesHandler>[1];
    await readTable();
    const child = spawn(process.execPath, ["-e", `
      const server = require("node:net").createServer();
      server.listen(0, "127.0.0.1", () => process.send(server.address().port));
      process.on("disconnect", () => server.close());
    `], {
      env: { ...process.env, PASEO_AGENT_ID: agent.id },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = once(child, "exit");
    try {
      const port = await Promise.race([
        once(child, "message").then(([port]) => port as number),
        exited.then(() => { throw new Error("Listener exited before opening a port"); }),
      ]);
      const result = readServices.output.parse(await readServicesHandler({}, context));
      expect(result.ports.find((entry) => entry.port === port)).toMatchObject({
        pid: child.pid,
        attribution: { kind: "agent-child", label: agent.title },
      });
      expect(result.services.find((entry) => entry.pid === child.pid)).toMatchObject({ source: "agent-child", ports: [port] });
    } finally {
      if (child.connected) child.disconnect();
      await exited;
    }
  });
});
