/** Presentation helpers shared by every surface. Pure functions, no runtime imports. */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : fractionDigits;
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`;
}

export function formatPercent(value: number | null, fractionDigits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(fractionDigits)}%`;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatMinutes(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/** Clamps a raw percentage into the 0..100 range a progress bar can render. */
export function clampPercent(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Load averages range from 0.04 on an idle machine to hundreds on a swamped one,
 * so the precision follows the size: two decimals where they mean something,
 * none where they would only add noise.
 */
export function formatLoad(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 10) return value.toFixed(2);
  if (value < 100) return value.toFixed(1);
  return value.toFixed(0);
}

/** `ps` %CPU as cores: 100% is one core, so 1,070% reads "10.7 cores". */
export function formatCores(cpuPercent: number): string {
  if (!Number.isFinite(cpuPercent) || cpuPercent < 0) return "—";
  const cores = cpuPercent / 100;
  return `${cores.toFixed(1)} ${cores.toFixed(1) === "1.0" ? "core" : "cores"}`;
}
