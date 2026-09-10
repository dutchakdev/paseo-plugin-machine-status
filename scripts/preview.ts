/**
 * Renders the README preview: what the plugin draws, and nothing else.
 *
 * Every value comes from the plugin's own pure functions — the validated
 * palette, the severity thresholds, the sparkline geometry, the byte and percent
 * formatters — fed with mock readings. Nothing here restates a value that lives
 * in the plugin, so changing a threshold or a palette slot changes the image.
 *
 * There is deliberately no imitation of the Paseo window around it. A drawn
 * frame would claim to be a screenshot of something this script never saw.
 *
 *   npm run preview
 */
import { writeFileSync } from "node:fs";
import { URL } from "node:url";
import { formatBytes, formatPercent } from "../shared/format";
import { columnHeights, DARK_PALETTE, severityOf, STATUS } from "../shared/viz";

const GB = 1024 ** 3;
const palette = DARK_PALETTE;

const INK = {
  chrome: "#0f1112",
  surface: "#131516",
  card: "#1a1d1f",
  line: "rgba(255,255,255,0.10)",
  text: "#e8eaec",
  muted: "#9aa1a6",
  faint: "#626a70",
};

const machine = {
  hostname: "macbook-m1.local",
  platform: "Darwin 27.0.0 (arm64) · up 5d 11h",
  cpu: { cores: 8, loadAvg1: 2.31, loadAvg5: 1.98, loadAvg15: 1.75, loadPercent: 28.9 },
  memory: { totalBytes: 16 * GB, usedBytes: 11.0 * GB, appBytes: 5.6 * GB, wiredBytes: 2.1 * GB, compressedBytes: 3.3 * GB, pressurePercent: 37 },
  swap: { totalBytes: 2 * GB, usedBytes: 1.2 * GB },
  disk: { usedPercent: 15, freeBytes: 143.8 * GB },
};

/** Rough advance widths for system-ui; enough to keep labels from colliding. */
function textWidth(value: string, size: number, bold = false): number {
  let total = 0;
  for (const char of value) {
    if (" .,:;'|!".includes(char)) total += size * 0.3;
    else if ("il".includes(char)) total += size * 0.27;
    else if (/[0-9]/.test(char)) total += size * 0.6;
    else if (/[A-Z%]/.test(char)) total += size * 0.68;
    else total += size * 0.53;
  }
  return total * (bold ? 1.04 : 1);
}

const esc = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const text = (
  x: number,
  y: number,
  value: string,
  fill: string,
  size: number,
  weight = "400",
  anchor: "start" | "end" | "middle" = "start",
  extra = "",
): string =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="system-ui, -apple-system, sans-serif" text-anchor="${anchor}" ${extra}>${esc(value)}</text>`;

const rect = (x: number, y: number, w: number, h: number, fill: string, radius = 0, stroke?: string): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ""}/>`;

const wave = (seed: number, base: number, spread: number, count: number): number[] =>
  Array.from({ length: count }, (_, index) =>
    Math.max(0, base + Math.sin(index / 3.1 + seed) * spread + Math.sin(index / 1.27 + seed) * (spread / 3)),
  );

function bars(values: number[], min: number, max: number, x: number, y: number, w: number, h: number, color: string): string {
  const heights = columnHeights(values, min, max);
  const step = w / heights.length;
  return heights
    .map((value, index) => {
      const height = Math.max((value / 100) * h, 2);
      return rect(+(x + index * step).toFixed(1), +(y + h - height).toFixed(1), +Math.max(step - 1, 1).toFixed(1), +height.toFixed(1), color, 1);
    })
    .join("");
}

/* ---------------------------------------------------------------- chrome -- */

const WIDTH = 980;
const PAD = 22;
const contentX = PAD;
const contentW = WIDTH - PAD * 2;

const TILE_W = (contentW - 14 * 3) / 4;
const TILE_H = 128;
const tilesY = 74;
const chartsY = tilesY + TILE_H + 16;
const CHART_H = 196;
const HEIGHT = chartsY + CHART_H + PAD;

const parts: string[] = [];

parts.push(
  rect(0, 0, WIDTH, HEIGHT, INK.surface, 14),
  text(contentX, 30, machine.hostname, INK.text, 21, "700"),
  text(contentX, 50, machine.platform, INK.muted, 11),
  text(WIDTH - PAD, 28, "Live · every 3s · last 4 min", INK.faint, 10, "400", "end"),
);

/* ----------------------------------------------------------------- tiles -- */

const cpuSeverity = severityOf(machine.cpu.loadPercent);
const memorySeverity = severityOf(machine.memory.pressurePercent, 80, 92);
const diskSeverity = severityOf(machine.disk.usedPercent, 85, 95);

const tiles = [
  { label: "CPU", colour: palette.series[0], meta: `${machine.cpu.cores} cores`, value: machine.cpu.loadAvg1.toFixed(2), suffix: "load, 1 min", severity: cpuSeverity, footer: `5 min ${machine.cpu.loadAvg5.toFixed(2)} · 15 min ${machine.cpu.loadAvg15.toFixed(2)} · OK`, series: wave(0, 30, 22, 40), max: 100 },
  { label: "MEMORY", colour: palette.series[1], meta: formatBytes(machine.memory.totalBytes), value: formatPercent(machine.memory.pressurePercent), suffix: "pressure", severity: memorySeverity, footer: `${formatBytes(machine.memory.usedBytes)} used · OK`, series: wave(2.2, 37, 8, 40), max: 100 },
  { label: "SWAP", colour: palette.series[2], meta: formatBytes(machine.swap.totalBytes), value: formatBytes(machine.swap.usedBytes), suffix: "in use", severity: "good" as const, footer: `${formatBytes(machine.swap.totalBytes - machine.swap.usedBytes)} free`, series: wave(4.1, 60, 10, 40), max: 100 },
  { label: "DISK", colour: palette.series[3], meta: "/", value: formatPercent(machine.disk.usedPercent), suffix: "used", severity: diskSeverity, footer: `${formatBytes(machine.disk.freeBytes)} free`, series: null, max: 100 },
];

tiles.forEach((tile, index) => {
  const x = contentX + index * (TILE_W + 14);
  const tone = tile.severity === "good" ? INK.text : STATUS[tile.severity];
  parts.push(
    rect(x, tilesY, TILE_W, TILE_H, INK.card, 12, INK.line),
    text(x + 16, tilesY + 26, tile.label, tile.colour, 11, "600", "start", 'letter-spacing="1.2"'),
    text(x + TILE_W - 16, tilesY + 26, tile.meta, INK.faint, 10, "400", "end"),
    text(x + 16, tilesY + 62, tile.value, tone, 25, "700"),
    // Placed by measured width so the suffix never lands on the figure.
    text(x + 16 + textWidth(tile.value, 25, true) + 9, tilesY + 62, tile.suffix, INK.muted, 11),
    text(x + 16, tilesY + TILE_H - 14, tile.footer, INK.muted, 10),
  );
  if (tile.series) {
    parts.push(bars(tile.series, 0, tile.max, x + 16, tilesY + 76, TILE_W - 32, 28, tile.colour));
  } else {
    parts.push(
      rect(x + 16, tilesY + 88, TILE_W - 32, 8, palette.neutral, 4),
      rect(x + 16, tilesY + 88, ((TILE_W - 32) * machine.disk.usedPercent) / 100, 8, palette.series[3], 4),
    );
  }
});

/* ---------------------------------------------------------------- charts -- */

const CHART_W = (contentW - 14) / 2;
const plotPad = 40;

function chartCard(x: number, title: string, badge: string): number {
  parts.push(
    rect(x, chartsY, CHART_W, CHART_H, INK.card, 12, INK.line),
    text(x + 16, chartsY + 26, title, INK.muted, 11, "600", "start", 'letter-spacing="1.2"'),
    text(x + CHART_W - 16, chartsY + 26, badge, INK.muted, 11, "400", "end"),
  );
  return x + 16 + plotPad;
}

const cpuPlotX = chartCard(contentX, "CPU LOAD OVER TIME", `${formatPercent(machine.cpu.loadPercent)} · OK`);
const cpuPlotW = CHART_W - 32 - plotPad;
const plotY = chartsY + 46;
const plotH = 108;
for (const [index, label] of ["100%", "50%", "0%"].entries()) {
  const y = plotY + (plotH / 2) * index;
  parts.push(
    text(cpuPlotX - 8, y + 4, label, INK.faint, 9, "400", "end"),
    `<line x1="${cpuPlotX}" y1="${y}" x2="${cpuPlotX + cpuPlotW}" y2="${y}" stroke="${palette.grid}"${index === 1 ? ' stroke-dasharray="4 4"' : ""}/>`,
  );
}
parts.push(
  bars(wave(0, 34, 26, 90), 0, 100, cpuPlotX, plotY, cpuPlotW, plotH, palette.series[0]),
  text(cpuPlotX, plotY + plotH + 20, "last 4 min", INK.faint, 9),
);

const memX = contentX + CHART_W + 14;
const memPlotX = chartCard(memX, "MEMORY OVER TIME", `${formatBytes(machine.memory.usedBytes)} of ${formatBytes(machine.memory.totalBytes)}`);
const memPlotW = CHART_W - 32 - plotPad;
for (const [index, label] of ["16 GB", "8 GB", "0"].entries()) {
  const y = plotY + (plotH / 2) * index;
  parts.push(
    text(memPlotX - 8, y + 4, label, INK.faint, 9, "400", "end"),
    `<line x1="${memPlotX}" y1="${y}" x2="${memPlotX + memPlotW}" y2="${y}" stroke="${palette.grid}"${index === 1 ? ' stroke-dasharray="4 4"' : ""}/>`,
  );
}
// Stacked columns: app, wired and compressed against the machine's total.
const stackCount = 44;
const step = memPlotW / stackCount;
const layers = [machine.memory.appBytes, machine.memory.wiredBytes, machine.memory.compressedBytes];
for (let column = 0; column < stackCount; column += 1) {
  let bottom = plotY + plotH;
  layers.forEach((bytes, layer) => {
    const jitter = 1 + Math.sin(column / 4 + layer) * 0.06;
    const height = ((bytes * jitter) / machine.memory.totalBytes) * plotH;
    bottom -= height;
    parts.push(rect(+(memPlotX + column * step).toFixed(1), +bottom.toFixed(1), +Math.max(step - 2, 1).toFixed(1), +height.toFixed(1), palette.series[layer]));
  });
}
const legend = [
  { label: "App", value: formatBytes(machine.memory.appBytes), colour: palette.series[0] },
  { label: "Wired", value: formatBytes(machine.memory.wiredBytes), colour: palette.series[1] },
  { label: "Compressed", value: formatBytes(machine.memory.compressedBytes), colour: palette.series[2] },
];
let legendX = memPlotX;
for (const item of legend) {
  parts.push(
    rect(legendX, plotY + plotH + 12, 8, 8, item.colour, 2),
    text(legendX + 13, plotY + plotH + 20, `${item.label} ${item.value}`, INK.muted, 10),
  );
  legendX += textWidth(`${item.label} ${item.value}`, 10) + 30;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
${parts.join("\n")}
</svg>
`;
writeFileSync(new URL("../docs/preview.svg", import.meta.url), svg);
console.log(`docs/preview.svg  ${WIDTH}x${HEIGHT}`);
console.log(`series ${palette.series.join(" ")} · cpu=${cpuSeverity} memory=${memorySeverity} disk=${diskSeverity}`);
