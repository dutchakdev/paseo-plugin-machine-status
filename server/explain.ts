import os from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import { describeError, run, tryRun } from "./exec";
import type { explainProcess } from "../shared/explain";
import { classify, type ProcessEvidence } from "./explain-rules";
import { readMetricsHandler } from "./metrics";
import { ancestorsOf, parseElapsedSeconds, parsePsTable, processName, type RawProcess } from "./processes";
import { readServicesHandler } from "./services";

type Output = z.output<typeof explainProcess.output>;

const MB = 1024 * 1024;
const GB = 1024 ** 3;

async function cwdOf(pid: number): Promise<string | null> {
  const raw = await tryRun("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], 4_000);
  return raw?.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
}

function childrenOf(pid: number, table: readonly RawProcess[]): RawProcess[] {
  return table.filter((entry) => entry.ppid === pid);
}

export async function explainProcessHandler(
  { pid }: { pid: number },
  context: PluginHandlerContext,
): Promise<Output> {
  const table = parsePsTable(await run("/bin/ps", ["-Ao", "pid=,ppid=,pcpu=,rss=,comm="], 10_000));
  const self = table.find((entry) => entry.pid === pid);

  if (!self) {
    return {
      found: false,
      name: `PID ${pid}`,
      pid,
      explanation: {
        headline: "This process no longer exists — it exited while you were looking at it.",
        kind: "unknown",
        state: "steady",
        concern: "none",
        findings: ["A process that short-lived is almost always scheduled work rather than a fault."],
        advice: ["Nothing to do. Refresh the list to see what is running now."],
      },
    };
  }

  const [elapsedRaw, cwd, metrics, services] = await Promise.all([
    tryRun("/bin/ps", ["-o", "etime=", "-p", String(pid)], 3_000),
    cwdOf(pid),
    readMetricsHandler(),
    readServicesHandler({}, context),
  ]);

  const children = childrenOf(pid, table);
  const childPids = new Set([pid, ...children.map((child) => child.pid)]);

  const evidence: ProcessEvidence = {
    name: processName(self.command),
    pid,
    command: self.command,
    cpuPercent: self.cpuPercent,
    memoryBytes: self.memoryBytes,
    elapsed: elapsedRaw?.trim() ?? null,
    elapsedSeconds: elapsedRaw ? parseElapsedSeconds(elapsedRaw) : null,
    cwd,
    parents: [...ancestorsOf(pid, table)]
      .filter((entry) => entry !== pid)
      .map((entry) => ({ pid: entry, name: processName(table.find((row) => row.pid === entry)?.command ?? "") })),
    children: children.map((child) => ({
      pid: child.pid,
      name: processName(child.command),
      cpuPercent: child.cpuPercent,
    })),
    ports: services.ports
      .filter((port) => port.pid !== null && childPids.has(port.pid))
      .map((port) => ({ port: port.port, protocol: port.protocol, scope: port.scope })),
    isAppleSystemBinary: /^\/(System|usr\/libexec|usr\/sbin|Library\/Apple)\//.test(self.command),
    machine: {
      cores: metrics.cpu.cores,
      loadPercent: metrics.cpu.loadPercent,
      pressurePercent: metrics.memory.pressurePercent,
      swapUsedBytes: metrics.swap.usedBytes,
      swapTotalBytes: metrics.swap.totalBytes,
    },
  };

  return {
    found: true,
    name: evidence.name,
    pid,
    explanation: classify(evidence),
  };
}
