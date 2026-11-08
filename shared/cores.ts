/**
 * How the busy CPU is spread over the cores. Pure, shared by the Machine tab
 * and the agent tool: the strip shows it, the verdict says what it means.
 */

export type CoreKind = "efficiency" | "performance";

export type BalanceVerdict =
  /** No per-core reading. */
  | "unknown"
  /** Nearly every core is busy: more work than cores. */
  | "saturated"
  /** One or two cores pinned, the rest near idle: the slow step runs on one thread. */
  | "serial"
  /** Only efficiency cores are busy: macOS runs background-priority work there. */
  | "background"
  /** Little is running. */
  | "idle"
  /** Most cores are working hard, but some headroom is left. */
  | "busy"
  /** A moderate load shared across cores. */
  | "spread";

export interface CoreBalance {
  verdict: BalanceVerdict;
  /** Mean over the cores that reported. */
  overall: number | null;
  busiest: { index: number; percent: number; kind: CoreKind | null } | null;
  /** Mean per kind, when the hardware says which core is which. */
  byKind: Record<CoreKind, { cores: number; percent: number }> | null;
}

const PINNED = 85;
const QUIET = 25;

export function coreBalance(perCore: readonly (number | null)[], kinds: readonly (CoreKind | null)[]): CoreBalance {
  const cores = perCore
    .map((percent, index) => (percent === null ? null : { index, percent, kind: kinds[index] ?? null }))
    .filter((core): core is { index: number; percent: number; kind: CoreKind | null } => core !== null);
  if (cores.length === 0) return { verdict: "unknown", overall: null, busiest: null, byKind: null };

  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const overall = mean(cores.map((core) => core.percent));
  const busiest = cores.reduce((top, core) => (core.percent > top.percent ? core : top));

  let byKind: CoreBalance["byKind"] = null;
  if (cores.every((core) => core.kind !== null)) {
    const of = (kind: CoreKind) => cores.filter((core) => core.kind === kind).map((core) => core.percent);
    const efficiency = of("efficiency");
    const performance = of("performance");
    if (efficiency.length > 0 && performance.length > 0) {
      byKind = {
        efficiency: { cores: efficiency.length, percent: mean(efficiency) },
        performance: { cores: performance.length, percent: mean(performance) },
      };
    }
  }

  const pinned = cores.filter((core) => core.percent >= PINNED);
  const rest = cores.filter((core) => core.percent < PINNED);
  const restQuiet = rest.length > 0 && mean(rest.map((core) => core.percent)) < QUIET;

  let verdict: BalanceVerdict;
  if (overall >= 90 || pinned.length === cores.length) verdict = "saturated";
  else if (pinned.length > 0 && restQuiet && pinned.every((core) => core.kind === "efficiency")) verdict = "background";
  else if (pinned.length > 0 && pinned.length <= Math.max(2, Math.floor(cores.length / 4)) && restQuiet) verdict = "serial";
  else if (overall < 10) verdict = "idle";
  else if (overall >= 60) verdict = "busy";
  else verdict = "spread";

  return { verdict, overall, busiest: { index: busiest.index, percent: busiest.percent, kind: busiest.kind }, byKind };
}

export const BALANCE_TEXT: Record<BalanceVerdict, string> = {
  unknown: "No per-core reading.",
  saturated: "Every core is busy: there is more work than cores, so everything waits its turn.",
  serial: "One or two cores are pinned while the rest are idle: the slow step runs on a single thread, and more cores would not speed it up.",
  background: "Only the efficiency cores are busy: macOS runs background-priority work there, and it leaves the performance cores to you.",
  idle: "The cores are mostly idle.",
  busy: "Most cores are working hard, with a little headroom left.",
  spread: "A moderate load, shared across the cores.",
};
