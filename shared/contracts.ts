import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Every contract in this file is validated on both sides of the plugin boundary:
 * the client validates what it sends, the daemon handler validates what it returns.
 * Keep this module free of Node and React Native code so both bundles can import it.
 */

export const CpuSchema = z.object({
  cores: z.number(),
  loadAvg1: z.number(),
  loadAvg5: z.number(),
  loadAvg15: z.number(),
  /**
   * loadAvg1 per core: 100 means one runnable thread per core. It is a queue
   * length, not utilisation, and climbs far past 100 when work waits for a core.
   */
  loadPercent: z.number(),
  /**
   * Share of all cores' time spent not idle over `windowMs`, 0–100, from the
   * kernel's tick counters. This is the CPU figure; null when no core was listed.
   */
  usagePercent: z.number().nullable(),
  /** The same per core, in the order the OS numbers them. */
  coreUsagePercent: z.array(z.number().nullable()),
  /** Efficiency or performance, per core in the same order; null where the hardware does not say. */
  coreKinds: z.array(z.enum(["efficiency", "performance"]).nullable()),
  /** How many milliseconds the usage figures cover. */
  windowMs: z.number(),
});

export const MemorySchema = z.object({
  totalBytes: z.number(),
  /** Activity Monitor's "App Memory": anonymous pages minus purgeable. */
  appBytes: z.number(),
  wiredBytes: z.number(),
  compressedBytes: z.number(),
  /** File-backed pages the kernel can reclaim on demand. */
  cachedBytes: z.number(),
  usedBytes: z.number(),
  /** Reported by macOS itself via `memory_pressure -Q`; null when unavailable. */
  freePercent: z.number().nullable(),
  pressurePercent: z.number().nullable(),
});

export const SwapSchema = z.object({
  totalBytes: z.number(),
  usedBytes: z.number(),
  freeBytes: z.number(),
});

export const DiskSchema = z.object({
  mountedOn: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  freeBytes: z.number(),
  /** Taken from df's own Capacity column: APFS containers make used/total misleading. */
  usedPercent: z.number(),
});

export const PowerSchema = z.object({
  source: z.enum(["ac", "battery", "unknown"]),
  percent: z.number().nullable(),
  state: z.string().nullable(),
  timeRemainingMinutes: z.number().nullable(),
});

export const ThermalSchema = z.object({
  level: z.enum(["nominal", "fair", "serious", "critical", "unknown"]),
  cpuSpeedLimitPercent: z.number().nullable(),
});

/** One point in the rolling history the charts draw. Kept small: it ships on every poll. */
export const HistorySampleSchema = z.object({
  at: z.string(),
  cpuUsagePercent: z.number().nullable(),
  cpuLoadPercent: z.number(),
  pressurePercent: z.number().nullable(),
  appBytes: z.number(),
  wiredBytes: z.number(),
  compressedBytes: z.number(),
  swapUsedBytes: z.number(),
});

export const MetricsSchema = z.object({
  collectedAt: z.string(),
  hostname: z.string(),
  platform: z.string(),
  uptimeSeconds: z.number(),
  cpu: CpuSchema,
  memory: MemorySchema,
  swap: SwapSchema,
  disk: DiskSchema,
  power: PowerSchema,
  thermal: ThermalSchema,
  history: z.array(HistorySampleSchema),
});

export const readMetrics = defineRpc({
  name: "metrics.read",
  input: z.object({}),
  output: MetricsSchema,
});

export const CleanupTargetSchema = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string(),
  path: z.string(),
  exists: z.boolean(),
  sizeBytes: z.number(),
  error: z.string().nullable(),
});

export const planCleanup = defineRpc({
  name: "cleanup.plan",
  input: z.object({}),
  output: z.object({
    scannedAt: z.string(),
    targets: z.array(CleanupTargetSchema),
    totalBytes: z.number(),
  }),
});

export const applyCleanup = defineRpc({
  name: "cleanup.apply",
  input: z.object({ targetIds: z.array(z.string()).min(1) }),
  output: z.object({
    appliedAt: z.string(),
    freedBytes: z.number(),
    results: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        ok: z.boolean(),
        freedBytes: z.number(),
        error: z.string().nullable(),
      }),
    ),
  }),
});

export const ProcessSchema = z.object({
  pid: z.number(),
  ppid: z.number(),
  cpuPercent: z.number(),
  memoryBytes: z.number(),
  name: z.string(),
  command: z.string(),
  /** True when killing this process would take Paseo itself down. */
  guarded: z.boolean(),
  /** Seconds since it started; null when ps did not report it. */
  elapsedSeconds: z.number().nullable(),
  /**
   * Its CPU time over its elapsed time, on the pcpu scale. Far below `cpuPercent`
   * means it became busy recently; close to it means it always runs like this.
   */
  lifetimeCpuPercent: z.number().nullable(),
});

export const listProcesses = defineRpc({
  name: "processes.list",
  input: z.object({
    sortBy: z.enum(["cpu", "memory"]).default("cpu"),
    limit: z.number().int().min(1).max(50).default(8),
  }),
  output: z.object({
    collectedAt: z.string(),
    items: z.array(ProcessSchema),
  }),
});

export const killProcess = defineRpc({
  name: "processes.kill",
  input: z.object({
    pid: z.number().int().positive(),
    signal: z.enum(["TERM", "KILL"]).default("TERM"),
  }),
  output: z.object({
    ok: z.boolean(),
    pid: z.number(),
    signal: z.string(),
    stillRunning: z.boolean(),
    error: z.string().nullable(),
  }),
});

export type Metrics = z.output<typeof MetricsSchema>;
export type HistorySample = z.output<typeof HistorySampleSchema>;
export type CleanupTarget = z.output<typeof CleanupTargetSchema>;
export type ProcessEntry = z.output<typeof ProcessSchema>;
