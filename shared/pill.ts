import type { PortRow } from "./services";
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
 * CPU utilisation and memory pressure are the two numbers that change while an
 * agent works, and they fail in different ways: one saturates, the other swaps.
 * Both are shown; the colour follows whichever is worse, because a pill has room
 * for one colour and the user needs to know that something is wrong before
 * knowing which one.
 *
 * The CPU figure is utilisation, never load average: load per core is a queue
 * length with no ceiling, and it once put "6337%" in this pill.
 */
export function pillReading(cpuUsagePercent: number | null, pressurePercent: number | null): PillReading {
  const cpu = cpuSeverity(cpuUsagePercent);
  const memory = memorySeverity(pressurePercent);
  return {
    text: `${show(cpuUsagePercent)} · ${show(pressurePercent)}`,
    severity: RANK[cpu] >= RANK[memory] ? cpu : memory,
    label: `Machine load: CPU ${show(cpuUsagePercent)}, memory ${show(pressurePercent)}`,
  };
}

/**
 * The thresholds the pill colours by, shared with its card so the two never
 * disagree about the same number. CPU is utilisation; memory pressure keeps the
 * higher thresholds the pill has always used.
 */
export function cpuSeverity(usagePercent: number | null): Severity {
  return severityOf(usagePercent);
}

export function memorySeverity(pressurePercent: number | null): Severity {
  return severityOf(pressurePercent, 80, 92);
}

/**
 * Development ports held by an agent or by a process an agent started, once per
 * port number: the side effects of agent work that outlive the turn that made
 * them. IPv4 and IPv6 listeners on the same port collapse into one row.
 */
export function agentPorts(ports: readonly PortRow[], limit = 3): PortRow[] {
  const byPort = new Map<number, PortRow>();
  for (const port of ports) {
    const kind = port.attribution?.kind;
    if (port.relevance !== "dev" || (kind !== "agent" && kind !== "agent-child")) continue;
    if (!byPort.has(port.port)) byPort.set(port.port, port);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port).slice(0, limit);
}
