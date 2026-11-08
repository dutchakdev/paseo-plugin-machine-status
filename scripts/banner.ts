/**
 * Renders docs/banner.svg, the README's opening image, in the style the
 * author's other Paseo plugins share (secure-input, account-switcher): an
 * eyebrow, a two-line claim with one accent word, a short flow, the version,
 * and on the right the plugin's own UI.
 *
 * The right side is the pill's card as the plugin draws it, fed with the
 * readings from the evening the pill showed "6337%" (2026-11-08): CPU
 * saturated, load 659 on 8 cores. Colours, thresholds and figures come from
 * the plugin's own palette, severity rules and formatters, so they cannot
 * drift from the code.
 *
 *   npm run banner && scripts/preview-png.sh banner
 */
import { writeFileSync } from "node:fs";
import { URL } from "node:url";
import { summarizeOwners, type CpuGroup } from "../shared/attribution";
import { formatCores, formatLoad, formatPercent } from "../shared/format";
import { cpuSeverity, memorySeverity, pillReading } from "../shared/pill";
import { DARK_PALETTE, SEVERITY_LABEL, STATUS, type Severity } from "../shared/viz";

const WIDTH = 980;
const HEIGHT = 447;
const palette = DARK_PALETTE;

/** The family's chrome, taken from secure-input's banner. */
const INK = {
  surface: "#131516",
  text: "#f2f3f5",
  body: "#8e939a",
  faint: "#5d6268",
  eyebrow: "#626a70",
  cardEdge: "#2e3139",
  chip: "#1d1f24",
  chipEdge: "#2c2f37",
  chipText: "#c9ccd3",
  accentChip: "#211d33",
  accentEdge: "#3b3266",
  accentText: "#b9a6ff",
};
const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/* -------------------------------------------------------------------- data -- */

const cpu = { usagePercent: 98.8, loadAvg1: 659.41, cores: 8 };
const memory = { pressurePercent: 66, swap: "1.2 GB" };
const cpuTrend = [34, 38, 41, 47, 52, 58, 63, 71, 78, 84, 90, 95, 97, 99, 98, 99, 100, 99, 98, 99];
const memoryTrend = [52, 53, 55, 56, 58, 59, 61, 62, 63, 63, 64, 65, 65, 66, 66, 66, 65, 66, 66, 66];

const groups: CpuGroup[] = [
  { kind: "agent", id: "a", label: "Build the iOS app", detail: "claude", cpuPercent: 107.4, processCount: 106, top: [{ pid: 1, name: "swift-frontend", cpuPercent: 100 }] },
  { kind: "agent", id: "b", label: "Fix the load pill", detail: "claude", cpuPercent: 72, processCount: 29, top: [{ pid: 2, name: "node", cpuPercent: 50.7 }] },
  { kind: "paseo", id: "paseo", label: "Paseo", detail: null, cpuPercent: 2.3, processCount: 7, top: [] },
  { kind: "system", id: "system", label: "macOS", detail: null, cpuPercent: 165.3, processCount: 466, top: [{ pid: 3, name: "Finder", cpuPercent: 100.5 }] },
  { kind: "other", id: "other", label: "Other", detail: null, cpuPercent: 8.1, processCount: 383, top: [] },
];
const owners = summarizeOwners(groups);
const pill = pillReading(cpu.usagePercent, memory.pressurePercent);

/* ----------------------------------------------------------------- helpers -- */

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (x: number, y: number, body: string, fill: string, size: number, extra = "") =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" ${extra}>${esc(body)}</text>`;
const tone = (severity: Severity) => (severity === "good" ? INK.text : STATUS[severity]);

function sparkbars(x: number, bottom: number, width: number, height: number, values: number[], color: string): string {
  const gap = 2;
  const bar = (width - gap * (values.length - 1)) / values.length;
  return values
    .map((value, index) => {
      const h = Math.max(1.5, (value / 100) * height);
      return `<rect x="${(x + index * (bar + gap)).toFixed(1)}" y="${(bottom - h).toFixed(1)}" width="${bar.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${color}"/>`;
    })
    .join("");
}

/* -------------------------------------------------------------------- left -- */

const left = [
  text(48, 64, "MACHINE STATUS · PASEO PLUGIN", INK.eyebrow, 11, `font-weight="600" font-family="${SANS}" letter-spacing="1.6"`),
  text(46, 128, "Every core counted,", INK.text, 38, `font-weight="700" font-family="${SANS}" letter-spacing="-0.6"`),
  `<text x="46" y="174" fill="${INK.text}" font-size="38" font-weight="700" font-family="${SANS}" letter-spacing="-0.6">every <tspan fill="url(#accent)">agent</tspan> named.</text>`,
  text(48, 218, "CPU in use and memory pressure beside every chat. Open the", INK.body, 15, `font-family="${SANS}"`),
  text(48, 240, "pill to see which agent the busy cores belong to.", INK.body, 15, `font-family="${SANS}"`),
].join("\n  ");

const chips = (() => {
  const items = [
    { label: pill.text, width: 96, accent: false },
    { label: "who is using the CPU", width: 178, accent: true },
    { label: "machine_status", width: 126, accent: false },
  ];
  let x = 48;
  const parts: string[] = [];
  items.forEach((item, index) => {
    parts.push(
      `<rect x="${x}" y="282" width="${item.width}" height="30" rx="8" fill="${item.accent ? INK.accentChip : INK.chip}" stroke="${item.accent ? INK.accentEdge : INK.chipEdge}"/>`,
      text(x + item.width / 2, 301, item.label, item.accent ? INK.accentText : INK.chipText, 11.5, `text-anchor="middle"`),
    );
    x += item.width;
    if (index < items.length - 1) {
      parts.push(`<path d="M${x + 6} 297 h22" stroke="#4b4f58" stroke-width="1.5"/><path d="M${x + 28} 297 l-5 -4 v8z" fill="#4b4f58"/>`);
      x += 34;
    }
  });
  parts.push(text(48, 336, "agents ask too: their share, who else, whether to wait", INK.faint, 11.5));
  return `<g font-family="${MONO}">${parts.join("")}</g>`;
})();

const footer = `<g font-family="${SANS}">
    <rect x="48" y="377" width="122" height="28" rx="14" fill="none" stroke="${INK.accentEdge}"/>
    <circle cx="66" cy="391" r="4" fill="#8b74ff"/>
    ${text(78, 395.5, "Paseo 0.11+", INK.accentText, 12.5, `font-weight="600"`)}
    ${text(184, 395.5, "macOS · tick counters · process tree · agent ids", INK.faint, 12.5)}
  </g>`;

/* ------------------------------------------------------------------- right -- */

const CARD_X = 584;
const CARD_Y = 40;
const CARD_W = 350;
const CARD_H = 322;
const cpuTone = cpuSeverity(cpu.usagePercent);
const memoryTone = memorySeverity(memory.pressurePercent);

function reading(x: number, label: string, color: string, meta: string, value: string, severity: Severity, trend: number[]): string {
  return [
    text(x, 88, label, color, 10.5, `font-weight="700" letter-spacing="1.2" font-family="${SANS}"`),
    text(x + 152, 88, meta, INK.faint, 10.5, `text-anchor="end" font-family="${SANS}"`),
    text(x, 119, value, tone(severity), 26, `font-weight="700" font-family="${SANS}" letter-spacing="-0.4"`),
    text(x + 66, 119, SEVERITY_LABEL[severity], severity === "good" ? INK.faint : STATUS[severity], 11, `font-family="${SANS}"`),
    sparkbars(x, 160, 152, 26, trend, color),
  ].join("");
}

const bandColor: Record<string, string> = {
  agents: palette.series[0],
  paseo: palette.series[1],
  system: palette.series[2],
  other: palette.neutral,
};

const ownersBlock = (() => {
  const parts: string[] = [];
  parts.push(text(18, 198, "Who is using the CPU", "#9a9ca6", 11.5, `font-family="${SANS}"`));
  parts.push(text(332, 198, formatCores(owners.totalPercent), INK.faint, 11.5, `text-anchor="end" font-family="${SANS}"`));
  // The stacked bar.
  let x = 18;
  const width = 314;
  const live = owners.segments.filter((segment) => segment.cpuPercent > 0);
  const gaps = live.length - 1;
  live.forEach((segment, index) => {
    const w = ((width - gaps) * segment.cpuPercent) / owners.totalPercent;
    const first = index === 0;
    const last = index === live.length - 1;
    parts.push(`<rect x="${x.toFixed(1)}" y="208" width="${w.toFixed(1)}" height="8" rx="${first || last ? 4 : 0}" fill="${bandColor[segment.kind]}"/>`);
    x += w + 1;
  });
  // Legend: every swatch with its label and value.
  let lx = 18;
  for (const segment of owners.segments) {
    const value = formatCores(segment.cpuPercent).replace(/ cores?$/, "");
    parts.push(`<rect x="${lx}" y="226" width="8" height="8" rx="2" fill="${bandColor[segment.kind]}"/>`);
    parts.push(text(lx + 12, 234, `${segment.label} ${value}`, "#9a9ca6", 10, `font-family="${MONO}"`));
    lx += 12 + (segment.label.length + value.length + 1) * 6.02 + 9;
  }
  // The agents behind the first band.
  owners.agents.slice(0, 2).forEach((agent, index) => {
    const y = 262 + index * 36;
    parts.push(text(18, y, agent.label, "#eef0f3", 13, `font-weight="600" font-family="${SANS}"`));
    parts.push(text(332, y, formatCores(agent.cpuPercent), "#eef0f3", 13, `text-anchor="end" font-family="${SANS}"`));
    parts.push(
      text(18, y + 15, `${agent.detail} · ${agent.top.map((process) => process.name).join(", ")} · ${agent.processCount} processes`, INK.faint, 10.5, `font-family="${MONO}"`),
    );
  });
  return parts.join("");
})();

const card = `<g transform="translate(${CARD_X}, ${CARD_Y})">
    <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="16" fill="url(#card)" stroke="${INK.cardEdge}"/>
    <!-- the pill this card opens from -->
    <rect x="18" y="18" width="150" height="34" rx="17" fill="#17181c" stroke="#2c6b43" stroke-width="1.6"/>
    <path d="M34 35 h4 l3 -7 l5 14 l3 -7 h4" fill="none" stroke="${STATUS[pill.severity]}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    ${text(62, 40, pill.text, "#a9adb5", 14, `font-family="${SANS}"`)}
    ${text(332, 40, `load ${formatLoad(cpu.loadAvg1)} · ${cpu.cores} cores`, INK.faint, 11, `text-anchor="end" font-family="${MONO}"`)}
    ${reading(18, "CPU", palette.series[0], "", formatPercent(cpu.usagePercent), cpuTone, cpuTrend)}
    ${reading(180, "MEMORY", palette.series[1], `swap ${memory.swap}`, formatPercent(memory.pressurePercent), memoryTone, memoryTrend)}
    <rect x="18" y="176" width="314" height="1" fill="rgba(255,255,255,0.08)"/>
    ${ownersBlock}
  </g>`;

const toolCard = `<g transform="translate(${CARD_X}, ${CARD_Y + CARD_H + 14})" font-family="${MONO}" font-size="11">
    <rect x="0" y="0" width="${CARD_W}" height="40" rx="11" fill="#18201c" stroke="#23302a"/>
    <path d="M15 20 h4 l3 -6 l4 12 l3 -6 h4" fill="none" stroke="#9fd8b5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    ${text(42, 24.5, "machine_status → saturated · yours 0.7 cores", "#9fd8b5", 11)}
  </g>`;

/* -------------------------------------------------------------------- page -- */

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <radialGradient id="glow" cx="0.78" cy="0.42" r="0.62">
      <stop offset="0" stop-color="#6c55f0" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#3a2d86" stop-opacity="0.10"/>
      <stop offset="1" stop-color="${INK.surface}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="card" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1f2126"/>
      <stop offset="1" stop-color="#191a1f"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a08cff"/>
      <stop offset="1" stop-color="#7a62f2"/>
    </linearGradient>
    <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="1" fill="#ffffff" opacity="0.045"/>
    </pattern>
  </defs>

  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="14" fill="${INK.surface}"/>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="14" fill="url(#dots)"/>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="14" fill="url(#glow)"/>

  ${left}
  ${chips}
  ${footer}

  ${card}
  ${toolCard}
</svg>
`;

writeFileSync(new URL("../docs/banner.svg", import.meta.url), svg);
console.log(`docs/banner.svg  ${WIDTH}x${HEIGHT}`);
