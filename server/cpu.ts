import os from "node:os";
import type { CoreKind } from "../shared/cores";
import { tryRun } from "./exec";

/**
 * CPU utilisation from the kernel's own tick counters.
 *
 * `os.cpus()` is libuv's `uv_cpu_info`, which on macOS calls `host_processor_info`
 * and returns each core's cumulative user/nice/sys/idle/irq time. Two readings
 * give the share of time each core spent not idle in between: the same figure
 * Activity Monitor and `top` report, bounded by 100%.
 *
 * Load average is not that figure. It counts runnable threads, so on a machine
 * with work queued it reads 659 on 8 cores, which divided by the core count is
 * 8240%: true, and useless as a percentage.
 */

export type CoreTimes = os.CpuInfo["times"];

export interface CoreUsage {
  /** Busy share of all cores' ticks, 0–100; null when no ticks passed. */
  overall: number | null;
  /** The same per core, in the order the OS numbers them. */
  perCore: (number | null)[];
}

export interface CpuUsage extends CoreUsage {
  /** How many milliseconds the figures cover. 0 when nothing was measured. */
  windowMs: number;
}

const totalOf = (times: CoreTimes): number => times.user + times.nice + times.sys + times.idle + times.irq;

/**
 * Utilisation between two readings. The overall figure weights every core by the
 * ticks it actually reported, rather than averaging per-core percentages, so a
 * core that ticked less cannot pull the total around.
 */
export function usageBetween(before: readonly CoreTimes[], after: readonly CoreTimes[]): CoreUsage {
  if (before.length === 0 || before.length !== after.length) return { overall: null, perCore: [] };

  let busy = 0;
  let total = 0;
  const perCore = after.map((times, index) => {
    const previous = before[index];
    const coreTotal = totalOf(times) - totalOf(previous);
    const coreIdle = times.idle - previous.idle;
    // A counter that went backwards (a core reset, a wrapped value) is no evidence.
    if (coreTotal <= 0 || coreIdle < 0 || coreIdle > coreTotal) return null;
    busy += coreTotal - coreIdle;
    total += coreTotal;
    return ((coreTotal - coreIdle) / coreTotal) * 100;
  });

  return { overall: total > 0 ? (busy / total) * 100 : null, perCore };
}

export interface SamplerDeps {
  read: () => CoreTimes[];
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

export interface SamplerPolicy {
  /** Reads closer together than this get the previous figure: a sliver of ticks is noise. */
  minWindowMs: number;
  /** A baseline older than this averages too much of the past to describe now. */
  maxWindowMs: number;
  /** The window opened on purpose when there is no usable baseline. */
  freshWindowMs: number;
}

/**
 * Pollers here run every 3 s (Machine tab, card) or 10 s (pill), so the previous
 * read is usually a good baseline and no read waits. The first read, and any
 * read after a long quiet spell, opens a short window of its own. There is no
 * background timer for the same reason history has none: sampling forever would
 * keep the machine awake to report on how busy it is.
 */
export const DEFAULT_POLICY: SamplerPolicy = {
  minWindowMs: 1_000,
  maxWindowMs: 15_000,
  freshWindowMs: 250,
};

export function createCpuSampler(deps: SamplerDeps, policy: SamplerPolicy = DEFAULT_POLICY) {
  let baseline: { at: number; times: CoreTimes[] } | null = null;
  let last: CpuUsage | null = null;
  let open: Promise<CpuUsage> | null = null;

  async function freshWindow(): Promise<CpuUsage> {
    const start = { at: deps.now(), times: deps.read() };
    await deps.wait(policy.freshWindowMs);
    const end = { at: deps.now(), times: deps.read() };
    baseline = end;
    last = { ...usageBetween(start.times, end.times), windowMs: end.at - start.at };
    return last;
  }

  return async function sample(): Promise<CpuUsage> {
    if (open) return open;

    const now = deps.now();
    const age = baseline ? now - baseline.at : Number.POSITIVE_INFINITY;

    if (last && age < policy.minWindowMs) return last;

    if (!baseline || age > policy.maxWindowMs) {
      open = freshWindow().finally(() => {
        open = null;
      });
      return open;
    }

    const times = deps.read();
    if (times.length === 0) return { overall: null, perCore: [], windowMs: 0 };
    const usage = { ...usageBetween(baseline.times, times), windowMs: now - baseline.at };
    baseline = { at: now, times };
    last = usage;
    return usage;
  };
}

/** The daemon's sampler. One per plugin process, shared by every caller. */
export const sampleCpuUsage = createCpuSampler({
  read: () => os.cpus().map((cpu) => cpu.times),
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/* -------------------------------------------------------------------------- */
/* Core kinds                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads `ioreg -rd1 -c IOPlatformDevice -k cluster-type`: one block per core,
 * keys in no fixed order. Apple Silicon marks each core's cluster "E" or "P";
 * an Intel Mac has no cluster type and yields an empty map.
 */
export function parseCoreKinds(raw: string): Map<number, CoreKind> {
  const kinds = new Map<number, CoreKind>();
  for (const block of raw.split(/^\+-o /m)) {
    const id = /"logical-cpu-id" = (\d+)/.exec(block);
    const cluster = /"cluster-type" = <"([EP])">/.exec(block);
    if (!id || !cluster) continue;
    kinds.set(Number(id[1]), cluster[1] === "E" ? "efficiency" : "performance");
  }
  return kinds;
}

/**
 * Labels for the cores in `os.cpus()` order. `host_processor_info`, which
 * `os.cpus()` reads, indexes processors by the kernel's CPU number, which is the
 * device tree's `logical-cpu-id`. When the counts disagree nothing is labelled:
 * one missing core would shift every label after it.
 */
export function alignCoreKinds(kinds: ReadonlyMap<number, CoreKind>, count: number): (CoreKind | null)[] {
  if (kinds.size !== count) return new Array<CoreKind | null>(count).fill(null);
  return Array.from({ length: count }, (_, index) => kinds.get(index) ?? null);
}

let coreKinds: Promise<Map<number, CoreKind>> | null = null;

/** The hardware does not change while the daemon runs, so ioreg is read once. */
export function readCoreKinds(): Promise<Map<number, CoreKind>> {
  coreKinds ??= tryRun("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformDevice", "-k", "cluster-type"], 4_000).then(
    (raw) => parseCoreKinds(raw ?? ""),
  );
  return coreKinds;
}
