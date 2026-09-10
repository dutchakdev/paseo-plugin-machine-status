import os from "node:os";
import type { MetricsSchema } from "../shared/contracts";
import { run, tryRun } from "./exec";
import type { z } from "zod";

type Metrics = z.output<typeof MetricsSchema>;
type HistorySample = Metrics["history"][number];
type Power = Metrics["power"];
type Thermal = Metrics["thermal"];
type Disk = Metrics["disk"];
type Swap = Metrics["swap"];

/* -------------------------------------------------------------------------- */
/* Parsers — pure functions over raw command output, covered by tests/          */
/* -------------------------------------------------------------------------- */

export interface VmStat {
  pageSize: number;
  pages: Record<string, number>;
}

/**
 * `vm_stat` prints "Key:  12345." lines, with a few keys wrapped in quotes.
 * The page size only appears in the header, and it is 16 KiB on Apple Silicon
 * rather than the 4 KiB most examples assume.
 */
export function parseVmStat(raw: string): VmStat {
  const header = raw.match(/page size of (\d+) bytes/);
  const pageSize = header ? Number(header[1]) : 4096;
  const pages: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^"?([^":]+)"?:\s+(\d+)\.?\s*$/);
    if (!match) continue;
    pages[match[1].trim().toLowerCase()] = Number(match[2]);
  }
  return { pageSize, pages };
}

const SIZE_MULTIPLIER: Record<string, number> = {
  "": 1,
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** Reads `vm.swapusage: total = 2048.00M  used = 1187.94M  free = 860.06M`. */
export function parseSwapUsage(raw: string): Swap {
  const field = (key: string): number => {
    const match = raw.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)\\s*([BKMGT]?)`, "i"));
    if (!match) return 0;
    return Number(match[1]) * (SIZE_MULTIPLIER[match[2].toUpperCase()] ?? 1);
  };
  return { totalBytes: field("total"), usedBytes: field("used"), freeBytes: field("free") };
}

/**
 * Reads `df -k -P` output. POSIX mode is required: without it macOS wraps long
 * device names onto a second line and the columns no longer line up.
 * The percentage comes from df's Capacity column because on APFS the container
 * is shared between volumes and used/total does not describe usable space.
 */
export function parseDf(raw: string): Disk | null {
  for (const line of raw.split("\n").slice(1)) {
    const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.*\S)\s*$/);
    if (!match) continue;
    return {
      mountedOn: match[6],
      totalBytes: Number(match[2]) * 1024,
      usedBytes: Number(match[3]) * 1024,
      freeBytes: Number(match[4]) * 1024,
      usedPercent: Number(match[5]),
    };
  }
  return null;
}

/**
 * Reads `pmset -g batt`. The state segment sits between the percentage and the
 * trailing "present:" marker, and can itself contain a semicolon
 * ("AC attached; not charging"), so it is captured as a whole.
 */
export function parseBattery(raw: string): Power {
  const drawing = raw.match(/Now drawing from '([^']+)'/i);
  const source: Power["source"] = drawing
    ? /ac\s*power/i.test(drawing[1])
      ? "ac"
      : "battery"
    : "unknown";

  const percentMatch = raw.match(/(\d+)%/);
  const stateMatch = raw.match(/\d+%;\s*(.+?)(?:\s+present:.*)?$/m);
  const timeMatch = raw.match(/(\d+):(\d{2})\s+remaining/);

  return {
    source,
    percent: percentMatch ? Number(percentMatch[1]) : null,
    state: stateMatch ? stateMatch[1].trim() : null,
    timeRemainingMinutes: timeMatch ? Number(timeMatch[1]) * 60 + Number(timeMatch[2]) : null,
  };
}

/**
 * Reads `pmset -g therm`. A healthy machine reports nothing at all
 * ("No thermal warning level has been recorded"), which is reported as
 * "unknown" rather than pretending the reading was a nominal one.
 */
export function parseThermal(raw: string): Thermal {
  const limitMatch = raw.match(/CPU_Speed_Limit\s*=\s*(\d+)/i);
  if (!limitMatch) return { level: "unknown", cpuSpeedLimitPercent: null };
  const cpuSpeedLimitPercent = Number(limitMatch[1]);
  const level: Thermal["level"] =
    cpuSpeedLimitPercent >= 100
      ? "nominal"
      : cpuSpeedLimitPercent >= 75
        ? "fair"
        : cpuSpeedLimitPercent >= 50
          ? "serious"
          : "critical";
  return { level, cpuSpeedLimitPercent };
}

/** Reads `memory_pressure -Q`, macOS's own free-memory figure. */
export function parseMemoryPressure(raw: string): number | null {
  const match = raw.match(/free percentage:\s*(\d+)%/i);
  return match ? Number(match[1]) : null;
}

export function buildMemory(
  vmStat: VmStat,
  totalBytes: number,
  freePercent: number | null,
): Metrics["memory"] {
  const pageBytes = (key: string): number => (vmStat.pages[key] ?? 0) * vmStat.pageSize;
  const appBytes = Math.max(0, pageBytes("anonymous pages") - pageBytes("pages purgeable"));
  const wiredBytes = pageBytes("pages wired down");
  const compressedBytes = pageBytes("pages occupied by compressor");
  return {
    totalBytes,
    appBytes,
    wiredBytes,
    compressedBytes,
    cachedBytes: pageBytes("file-backed pages"),
    usedBytes: appBytes + wiredBytes + compressedBytes,
    freePercent,
    pressurePercent: freePercent === null ? null : 100 - freePercent,
  };
}

/* -------------------------------------------------------------------------- */
/* Rolling history                                                              */
/* -------------------------------------------------------------------------- */

export const HISTORY_LIMIT = 90;

/**
 * History accumulates as a side effect of being read. There is deliberately no
 * background timer: a plugin that samples forever would keep the machine awake
 * to report on how busy the machine is. The cost is that history only covers the
 * time the panel was open, which is why the chart caption reports the real span
 * between its first and last sample instead of claiming a fixed window.
 */
const history: HistorySample[] = [];

export function appendHistory(sample: HistorySample, limit = HISTORY_LIMIT): HistorySample[] {
  history.push(sample);
  if (history.length > limit) history.splice(0, history.length - limit);
  return history;
}

export function resetHistory(): void {
  history.length = 0;
}

export type Extent = {
  min: number;
  max: number;
  avg: number;
  last: number;
};

function extentOf(values: readonly number[]): Extent | null {
  if (values.length === 0) return null;
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    last: values[values.length - 1],
  };
}

export type HistorySummary = {
  samples: number;
  fromAt: string | null;
  toAt: string | null;
  spanSeconds: number;
  cpuLoadPercent: Extent | null;
  pressurePercent: Extent | null;
  memoryUsedBytes: Extent | null;
  swapUsedBytes: Extent | null;
};

/**
 * Reduces a series to what a reader needs to judge it. min/max/avg against the
 * current value is what separates "spiking now" from "pinned for minutes" — the
 * distinction a single snapshot cannot make.
 */
export function summarizeHistory(samples: readonly HistorySample[]): HistorySummary {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span =
    first && last ? Math.max(0, Math.round((Date.parse(last.at) - Date.parse(first.at)) / 1000)) : 0;

  return {
    samples: samples.length,
    fromAt: first?.at ?? null,
    toAt: last?.at ?? null,
    spanSeconds: span,
    cpuLoadPercent: extentOf(samples.map((sample) => sample.cpuLoadPercent)),
    pressurePercent: extentOf(
      samples.filter((sample) => sample.pressurePercent !== null).map((sample) => sample.pressurePercent as number),
    ),
    memoryUsedBytes: extentOf(
      samples.map((sample) => sample.appBytes + sample.wiredBytes + sample.compressedBytes),
    ),
    swapUsedBytes: extentOf(samples.map((sample) => sample.swapUsedBytes)),
  };
}

/** Evenly spaced picks, always including the first and last sample. */
export function downsample<T>(samples: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (samples.length <= count) return [...samples];
  if (count === 1) return [samples[samples.length - 1]];
  const step = (samples.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, index) => samples[Math.round(index * step)]);
}

export function toHistorySample(metrics: Omit<Metrics, "history">): HistorySample {
  return {
    at: metrics.collectedAt,
    cpuLoadPercent: metrics.cpu.loadPercent,
    pressurePercent: metrics.memory.pressurePercent,
    appBytes: metrics.memory.appBytes,
    wiredBytes: metrics.memory.wiredBytes,
    compressedBytes: metrics.memory.compressedBytes,
    swapUsedBytes: metrics.swap.usedBytes,
  };
}

/* -------------------------------------------------------------------------- */
/* Collector                                                                    */
/* -------------------------------------------------------------------------- */

const EMPTY_DISK: Disk = {
  mountedOn: "/",
  totalBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
  usedPercent: 0,
};

export async function readMetricsHandler(): Promise<Metrics> {
  const snapshot = await collect();
  return { ...snapshot, history: [...appendHistory(toHistorySample(snapshot))] };
}

async function collect(): Promise<Omit<Metrics, "history">> {
  if (process.platform !== "darwin") {
    throw new Error(
      `machine-status collects metrics through macOS tools; this daemon runs on ${process.platform}.`,
    );
  }

  const [vmStatRaw, swapRaw, dfRaw, batteryRaw, thermalRaw, pressureRaw] = await Promise.all([
    run("/usr/bin/vm_stat", []),
    run("/usr/sbin/sysctl", ["vm.swapusage"]),
    run("/bin/df", ["-k", "-P", "/"]),
    tryRun("/usr/bin/pmset", ["-g", "batt"]),
    tryRun("/usr/bin/pmset", ["-g", "therm"]),
    tryRun("/usr/bin/memory_pressure", ["-Q"]),
  ]);

  const cores = os.cpus().length || 1;
  const [loadAvg1, loadAvg5, loadAvg15] = os.loadavg();

  return {
    collectedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    uptimeSeconds: os.uptime(),
    cpu: {
      cores,
      loadAvg1,
      loadAvg5,
      loadAvg15,
      loadPercent: (loadAvg1 / cores) * 100,
    },
    memory: buildMemory(
      parseVmStat(vmStatRaw),
      os.totalmem(),
      pressureRaw ? parseMemoryPressure(pressureRaw) : null,
    ),
    swap: parseSwapUsage(swapRaw),
    disk: parseDf(dfRaw) ?? EMPTY_DISK,
    power: batteryRaw
      ? parseBattery(batteryRaw)
      : { source: "unknown", percent: null, state: null, timeRemainingMinutes: null },
    thermal: thermalRaw ? parseThermal(thermalRaw) : { level: "unknown", cpuSpeedLimitPercent: null },
  };
}
