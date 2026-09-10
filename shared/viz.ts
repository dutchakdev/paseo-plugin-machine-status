/**
 * Chart palette and geometry. Pure values and pure functions only, so the colour
 * decisions and the bar maths are both testable without a renderer.
 *
 * Paseo exposes six theme tokens and never says which theme is active, so the
 * data palette is chosen by measuring the luminance of `surface0`. Chrome comes
 * from the theme; series colour does not — a categorical hue has to stay the
 * same hue across themes or it stops identifying anything.
 *
 * Both columns below are the reference categorical order and were validated with
 * scripts/validate_palette.js against their own surface: every hard gate passes
 * in both modes (worst adjacent CVD ΔE 8.4 dark / 9.1 light, normal-vision 19.8
 * dark / 22.9 light). The light column's aqua and yellow sit under 3:1, which the
 * relief rule permits because every series is directly labelled with its value.
 */

export interface VizPalette {
  /** Categorical slots in fixed order. Assigned by slot, never cycled. */
  series: readonly [string, string, string, string];
  /** For "free"/"unused" remainders, which are an absence rather than a category. */
  neutral: string;
  grid: string;
  /**
   * Hairline ring. Deliberately NOT a text token: `foregroundMuted` is tuned to be
   * legible as type, which makes it far too loud for a 1px edge.
   */
  border: string;
  borderStrong: string;
}

export const DARK_PALETTE: VizPalette = {
  series: ["#3987e5", "#d95926", "#199e70", "#c98500"],
  neutral: "#383835",
  grid: "#2c2c2a",
  border: "rgba(255,255,255,0.10)",
  borderStrong: "rgba(255,255,255,0.18)",
};

export const LIGHT_PALETTE: VizPalette = {
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  neutral: "#c3c2b7",
  grid: "#e1e0d9",
  border: "rgba(11,11,11,0.10)",
  borderStrong: "rgba(11,11,11,0.18)",
};

/** Fixed across themes: a status colour must never impersonate a series. */
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

export type Severity = keyof typeof STATUS;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, or null when the colour is in a format we cannot read. */
export function relativeLuminance(color: string): number | null {
  const trimmed = color.trim();

  const hex = HEX.exec(trimmed);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/./g, (d) => d + d) : hex[1];
    const [r, g, b] = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  const rgb = RGB.exec(trimmed);
  if (rgb) {
    const [r, g, b] = [1, 2, 3].map((index) => Number(rgb[index]));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  return null;
}

/** Unreadable colour formats fall back to dark, which is Paseo's default. */
export function isDarkSurface(color: string): boolean {
  const luminance = relativeLuminance(color);
  return luminance === null ? true : luminance < 0.4;
}

export function paletteFor(surface: string): VizPalette {
  return isDarkSurface(surface) ? DARK_PALETTE : LIGHT_PALETTE;
}

/**
 * Severity for a utilisation percentage. Always paired with a text label in the
 * UI: a status colour never carries the meaning on its own.
 */
export function severityOf(percent: number | null, warnAt = 75, criticalAt = 90): Severity {
  if (percent === null || !Number.isFinite(percent)) return "good";
  if (percent >= criticalAt) return "critical";
  if (percent >= warnAt) return "warning";
  return "good";
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  good: "OK",
  warning: "High",
  serious: "Serious",
  critical: "Critical",
};

/** Column heights as percentages, for a bar-per-sample chart. */
export function columnHeights(values: readonly number[], min: number, max: number): number[] {
  const span = max - min;
  if (span <= 0) return values.map(() => 0);
  return values.map((value) => {
    const clamped = Math.max(min, Math.min(max, value));
    return ((clamped - min) / span) * 100;
  });
}

/**
 * Splits one stacked column into segment percentages of `total`. The remainder is
 * returned as the last entry so the column always sums to 100.
 */
export function stackedColumn(parts: readonly number[], total: number): number[] {
  if (total <= 0) return parts.map(() => 0).concat(100);
  const segments = parts.map((part) => Math.max(0, (part / total) * 100));
  const used = segments.reduce((sum, segment) => sum + segment, 0);
  return segments.concat(Math.max(0, 100 - used));
}

/**
 * Right-aligns a series into a fixed number of slots, padding the left with nulls.
 *
 * A live monitor's plot has a constant width whether or not history has filled it:
 * the newest sample belongs at the right edge next to "now", and the empty left is
 * the honest picture of how much history exists. Stretching a handful of samples
 * across the full width would instead imply they span the whole window.
 */
export function padSlots<T>(values: readonly T[], slots: number): (T | null)[] {
  if (slots <= 0) return [];
  if (values.length >= slots) return values.slice(values.length - slots) as T[];
  return [...new Array<null>(slots - values.length).fill(null), ...values];
}

export function takeLast<T>(items: readonly T[], count: number): T[] {
  return count >= items.length ? [...items] : items.slice(items.length - count);
}

/** Human span between the first and last sample, for an honest axis caption. */
export function spanLabel(first: string | undefined, last: string | undefined): string {
  if (!first || !last) return "no history yet";
  const seconds = Math.round((Date.parse(last) - Date.parse(first)) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "just started";
  if (seconds < 90) return `last ${seconds}s`;
  return `last ${Math.round(seconds / 60)} min`;
}
