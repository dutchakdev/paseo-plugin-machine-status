import { severityOf, type Severity } from "./viz";

export interface PillReading {
  /** What the pill shows: two percentages, nothing else fits. */
  text: string;
  /** The worse of the two readings, so one colour can speak for both. */
  severity: Severity;
  /** Spoken label, where there is room to say which number is which. */
  label: string;
}

const RANK: Record<Severity, number> = { good: 0, warning: 1, serious: 2, critical: 3 };

const show = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? "—" : `${Math.round(value)}%`;

/**
 * Reduces the machine to what fits beside a text field.
 *
 * CPU load and memory pressure are the two numbers that change while an agent
 * works, and they fail in different ways: one saturates, the other swaps. Both
 * are shown; the colour follows whichever is worse, because a pill has room for
 * one colour and the user needs to know that something is wrong before knowing
 * which one.
 */
export function pillReading(cpuLoadPercent: number, pressurePercent: number | null): PillReading {
  const cpu = severityOf(cpuLoadPercent);
  const memory = severityOf(pressurePercent, 80, 92);
  return {
    text: `${show(cpuLoadPercent)} · ${show(pressurePercent)}`,
    severity: RANK[cpu] >= RANK[memory] ? cpu : memory,
    label: `Machine load: CPU ${show(cpuLoadPercent)}, memory ${show(pressurePercent)}`,
  };
}
