import { describe, expect, it } from "vitest";
import {
  columnHeights,
  DARK_PALETTE,
  isDarkSurface,
  LIGHT_PALETTE,
  padSlots,
  paletteFor,
  relativeLuminance,
  severityOf,
  spanLabel,
  stackedColumn,
  takeLast,
} from "../viz.shared";

describe("relativeLuminance", () => {
  it("reads six-digit hex", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 3);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 3);
  });

  it("expands three-digit hex", () => {
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 3);
  });

  it("reads rgb() and rgba()", () => {
    expect(relativeLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 3);
    expect(relativeLuminance("rgba(0,0,0,0.5)")).toBeCloseTo(0, 3);
  });

  it("returns null for a format it cannot read", () => {
    expect(relativeLuminance("oklch(0.2 0.01 240)")).toBeNull();
  });
});

describe("isDarkSurface", () => {
  it("classifies Paseo-like dark and light surfaces", () => {
    expect(isDarkSurface("#1a1a19")).toBe(true);
    expect(isDarkSurface("#fcfcfb")).toBe(false);
  });

  it("falls back to dark when the colour is unreadable", () => {
    // Guessing "light" would put low-contrast series on a dark panel.
    expect(isDarkSurface("color(display-p3 0.1 0.1 0.1)")).toBe(true);
  });

  it("picks the matching validated column", () => {
    expect(paletteFor("#1a1a19")).toBe(DARK_PALETTE);
    expect(paletteFor("#fcfcfb")).toBe(LIGHT_PALETTE);
  });
});

describe("palette integrity", () => {
  it("keeps four categorical slots per mode", () => {
    expect(DARK_PALETTE.series).toHaveLength(4);
    expect(LIGHT_PALETTE.series).toHaveLength(4);
  });

  it("never repeats a hue inside a mode", () => {
    expect(new Set(DARK_PALETTE.series).size).toBe(4);
    expect(new Set(LIGHT_PALETTE.series).size).toBe(4);
  });

  it("keeps the two modes distinct, since each was stepped for its own surface", () => {
    expect(DARK_PALETTE.series).not.toEqual(LIGHT_PALETTE.series);
  });
});

describe("severityOf", () => {
  it("escalates at the documented thresholds", () => {
    expect(severityOf(10)).toBe("good");
    expect(severityOf(80)).toBe("warning");
    expect(severityOf(95)).toBe("critical");
  });

  it("accepts custom thresholds for scales with different headroom", () => {
    expect(severityOf(88, 85, 95)).toBe("warning");
  });

  it("treats a missing reading as good rather than alarming", () => {
    expect(severityOf(null)).toBe("good");
  });
});

describe("columnHeights", () => {
  it("maps the range onto 0..100", () => {
    expect(columnHeights([0, 50, 100], 0, 100)).toEqual([0, 50, 100]);
  });

  it("clamps values outside the range", () => {
    expect(columnHeights([-20, 140], 0, 100)).toEqual([0, 100]);
  });

  it("returns flat columns for a degenerate range instead of dividing by zero", () => {
    expect(columnHeights([5, 5], 3, 3)).toEqual([0, 0]);
  });
});

describe("stackedColumn", () => {
  it("returns segment percentages plus the remainder", () => {
    expect(stackedColumn([25, 25], 100)).toEqual([25, 25, 50]);
  });

  it("always sums to 100", () => {
    const segments = stackedColumn([3, 5, 1], 16);
    expect(segments.reduce((sum, part) => sum + part, 0)).toBeCloseTo(100, 6);
  });

  it("never emits a negative remainder when the parts overflow the total", () => {
    const segments = stackedColumn([80, 40], 100);
    expect(segments[segments.length - 1]).toBe(0);
  });

  it("survives a zero total", () => {
    expect(stackedColumn([1, 2], 0)).toEqual([0, 0, 100]);
  });
});

describe("padSlots", () => {
  it("right-aligns a short series so the newest sample sits at the plot edge", () => {
    expect(padSlots([1, 2, 3], 5)).toEqual([null, null, 1, 2, 3]);
  });

  it("keeps the plot width constant however little history exists", () => {
    expect(padSlots([], 4)).toHaveLength(4);
    expect(padSlots([1], 4)).toHaveLength(4);
    expect(padSlots([1, 2, 3, 4, 5, 6], 4)).toHaveLength(4);
  });

  it("drops the oldest samples once the series overflows the plot", () => {
    expect(padSlots([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });

  it("returns nothing for a plot with no slots", () => {
    expect(padSlots([1, 2], 0)).toEqual([]);
  });

  it("passes objects through untouched, for stacked columns", () => {
    const column = { parts: [1], total: 2 };
    expect(padSlots([column], 2)).toEqual([null, column]);
  });
});

describe("takeLast", () => {
  it("returns the tail", () => {
    expect(takeLast([1, 2, 3, 4], 2)).toEqual([3, 4]);
  });

  it("returns a copy when asked for more than exists", () => {
    const input = [1, 2];
    const output = takeLast(input, 10);
    expect(output).toEqual([1, 2]);
    expect(output).not.toBe(input);
  });
});

describe("spanLabel", () => {
  it("reports the real span rather than a fixed window", () => {
    expect(spanLabel("2026-08-19T16:00:00.000Z", "2026-08-19T16:04:30.000Z")).toBe("last 5 min");
    expect(spanLabel("2026-08-19T16:00:00.000Z", "2026-08-19T16:00:45.000Z")).toBe("last 45s");
  });

  it("says so when there is no history", () => {
    expect(spanLabel(undefined, undefined)).toBe("no history yet");
  });

  it("handles a single sample", () => {
    expect(spanLabel("2026-08-19T16:00:00.000Z", "2026-08-19T16:00:00.000Z")).toBe("just started");
  });
});
