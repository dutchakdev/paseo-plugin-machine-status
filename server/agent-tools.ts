import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CpuAttribution, CpuGroup } from "../shared/attribution";
import type { Metrics } from "../shared/contracts";
import { BALANCE_TEXT, coreBalance, type BalanceVerdict } from "../shared/cores";
import { formatBytes, formatCores, formatLoad, formatPercent } from "../shared/format";
import { attributeCpuHandler } from "./attribution";
import { describeError } from "./exec";
import { explainProcessHandler } from "./explain";
import { readMetricsHandler } from "./metrics";

/**
 * The plugin's data as tools for the agents themselves.
 *
 * The Machine tab answers a person looking at numbers. An agent needs the same
 * numbers turned into a decision: may I start this build in parallel, is my own
 * work the reason everything is slow, what is that process. So `machine_status`
 * reports the machine with the caller's own share and one line of guidance, and
 * `machine_explain_process` hands over the Explain verdict.
 *
 * Paseo 0.14 added agent tools to the `agent.session_open` request. This plugin
 * still supports 0.11, so it builds against the 0.11 SDK, mirrors the tool shape
 * here, and adds its tools only when the request carries a `tools` list.
 */

interface ToolContext {
  agent?: { id: string } | null;
  paseo: PluginHandlerContext["paseo"];
  signal?: AbortSignal;
}

interface ToolResult {
  text?: string;
  structuredContent?: unknown;
  isError?: boolean;
}

/** The shape of Paseo's `AgentToolDefinition` (SDK 0.14). `defineAgentTool` only checks the name. */
export interface MachineTool {
  name: string;
  title?: string;
  description: string;
  input: z.ZodType;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

/* -------------------------------------------------------------------------- */
/* The report                                                                   */
/* -------------------------------------------------------------------------- */

export interface OwnerLine {
  kind: CpuGroup["kind"];
  label: string;
  /** Cores in use: `ps` %CPU / 100, two decimals. */
  cores: number;
  processCount: number;
  top: { pid: number; name: string; cpuPercent: number }[];
}

export interface MachineReportData {
  /**
   * The report in sentences, the same as the tool's text. Paseo may forward the
   * structured content alone, so the prose travels inside it too.
   */
  summary: string;
  cpu: {
    usagePercent: number | null;
    cores: number;
    efficiencyCores: number | null;
    performanceCores: number | null;
    loadAvg1: number;
    threadsPerCore: number;
    balance: BalanceVerdict;
  };
  memory: { pressurePercent: number | null; swapUsedBytes: number; swapTotalBytes: number };
  disk: { usedPercent: number; freeBytes: number };
  thermal: Metrics["thermal"]["level"];
  /** The calling agent's processes; null when ownership could not be read. */
  you: { cores: number; processCount: number; top: OwnerLine["top"] } | null;
  /** Agents using CPU, then Paseo, macOS and everything else. */
  owners: OwnerLine[];
  guidance: string;
  notes: string[];
}

const cores = (cpuPercent: number): number => Math.round(cpuPercent) / 100;
/** Below this an agent's share prints as 0.0 cores and says nothing. */
const NOTICEABLE = 5;
/** Agent titles are often a chat's first message; the report needs a name, not the message. */
const short = (label: string): string => (label.length > 48 ? `${label.slice(0, 47).trimEnd()}…` : label);
const topNames = (top: OwnerLine["top"], withShare: boolean) =>
  top.map((process) => (withShare ? `${process.name} ${Math.round(process.cpuPercent)}%` : process.name)).join(", ");

export function machineReport(
  metrics: Metrics,
  attribution: CpuAttribution | null,
  callerId: string | null,
): { text: string; data: MachineReportData } {
  const { cpu, memory, swap, disk, thermal } = metrics;
  const balance = coreBalance(cpu.coreUsagePercent, cpu.coreKinds);
  const threadsPerCore = cpu.loadAvg1 / cpu.cores;
  const kinds = balance.byKind;

  const groups = attribution?.groups ?? [];
  const mine = callerId ? groups.find((group) => group.kind === "agent" && group.id === callerId) : undefined;
  const otherAgents = groups
    .filter((group) => group.kind === "agent" && group.id !== callerId && group.cpuPercent >= NOTICEABLE)
    .sort((left, right) => right.cpuPercent - left.cpuPercent);
  const rest = groups.filter((group) => group.kind !== "agent");

  const toLine = (group: CpuGroup): OwnerLine => ({
    kind: group.kind,
    label: short(group.label),
    cores: cores(group.cpuPercent),
    processCount: group.processCount,
    top: group.top,
  });

  const you = attribution
    ? { cores: mine ? cores(mine.cpuPercent) : 0, processCount: mine?.processCount ?? 0, top: mine?.top ?? [] }
    : null;

  // --- guidance -------------------------------------------------------------
  const usage = cpu.usagePercent ?? 0;
  const pressure = memory.pressurePercent ?? 0;
  const busiestAgent = [...(mine ? [mine] : []), ...otherAgents].sort((left, right) => right.cpuPercent - left.cpuPercent)[0];
  const guidance: string[] = [];
  if (pressure >= 80) {
    guidance.push(
      `Memory is tight (pressure ${formatPercent(pressure)}): avoid starting memory-heavy work such as simulators, containers or large builds.`,
    );
  }
  if (usage >= 90 || balance.verdict === "saturated") {
    guidance.push("The CPU is saturated. Avoid starting more parallel work until it calms down.");
    if (busiestAgent) {
      guidance.push(
        busiestAgent.id === callerId
          ? `Your own processes are the busiest agent's (${formatCores(busiestAgent.cpuPercent)}).`
          : `The busiest agent is "${short(busiestAgent.label)}" (${formatCores(busiestAgent.cpuPercent)}).`,
      );
    }
  } else if (balance.verdict === "serial") {
    guidance.push("One core is pinned while the rest idle: the slow step is single-threaded, and parallel work would still fit.");
  } else if (usage < 60 && pressure < 80) {
    guidance.push("There is headroom for heavy work.");
  } else if (pressure < 80) {
    guidance.push("The machine is busy but not saturated.");
  }

  // --- text -----------------------------------------------------------------
  const lines: string[] = [];
  const split = kinds ? ` (${kinds.efficiency.cores} efficiency, ${kinds.performance.cores} performance)` : "";
  lines.push(
    `CPU ${formatPercent(cpu.usagePercent)} in use across ${cpu.cores} cores${split}; load ${formatLoad(cpu.loadAvg1)}, ${formatLoad(threadsPerCore)} runnable threads per core. ${BALANCE_TEXT[balance.verdict]}`,
  );
  lines.push(
    `Memory pressure ${formatPercent(memory.pressurePercent)}; swap ${formatBytes(swap.usedBytes)} of ${formatBytes(swap.totalBytes)} in use.`,
  );
  lines.push(
    `Disk ${formatPercent(disk.usedPercent)} used, ${formatBytes(disk.freeBytes)} free. Thermal: ${thermal.level === "unknown" ? "no throttling recorded" : thermal.level}.`,
  );
  if (you) {
    lines.push(
      `Your processes: ${formatCores(mine?.cpuPercent ?? 0)}${you.top.length > 0 ? ` (${topNames(you.top, true)})` : ""}, ${you.processCount} processes.`,
    );
    const others = [
      ...otherAgents.slice(0, 5).map((group) => `"${short(group.label)}" ${formatCores(group.cpuPercent)}${group.top.length > 0 ? ` (${topNames(group.top, false)})` : ""}`),
      ...rest.filter((group) => group.cpuPercent >= NOTICEABLE).map((group) => `${group.label} ${formatCores(group.cpuPercent)}${group.top.length > 0 ? ` (${topNames(group.top, false)})` : ""}`),
    ];
    lines.push(`Who else is using the CPU: ${others.join("; ")}.`);
  }
  for (const note of attribution?.notes ?? []) lines.push(note);
  lines.push(guidance.join(" "));

  const summary = lines.join("\n");
  return {
    text: summary,
    data: {
      summary,
      cpu: {
        usagePercent: cpu.usagePercent,
        cores: cpu.cores,
        efficiencyCores: kinds?.efficiency.cores ?? null,
        performanceCores: kinds?.performance.cores ?? null,
        loadAvg1: cpu.loadAvg1,
        threadsPerCore,
        balance: balance.verdict,
      },
      memory: { pressurePercent: memory.pressurePercent, swapUsedBytes: swap.usedBytes, swapTotalBytes: swap.totalBytes },
      disk: { usedPercent: disk.usedPercent, freeBytes: disk.freeBytes },
      thermal: thermal.level,
      you,
      owners: [...otherAgents, ...(mine ? [mine] : []), ...rest].map(toLine),
      guidance: guidance.join(" "),
      notes: attribution?.notes ?? [],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The tools                                                                    */
/* -------------------------------------------------------------------------- */

interface ToolDeps {
  metrics: () => Promise<Metrics>;
  attribute: (context: PluginHandlerContext) => Promise<CpuAttribution>;
  explain: (pid: number, context: PluginHandlerContext) => ReturnType<typeof explainProcessHandler>;
}

const LIVE: ToolDeps = {
  metrics: readMetricsHandler,
  attribute: (context) => attributeCpuHandler({}, context),
  explain: (pid, context) => explainProcessHandler({ pid }, context),
};

const failure = (tool: string, error: unknown): ToolResult => ({ isError: true, text: `${tool} failed: ${describeError(error)}` });

export function machineTools(deps: ToolDeps = LIVE): MachineTool[] {
  return [
    {
      name: "machine_status",
      title: "Machine status",
      description:
        "How loaded this Mac is right now: CPU in use, memory pressure, disk, and how many cores each agent's processes use, yours included, with one line of guidance. Call it before starting heavy or parallel work (builds, test suites, simulators, containers) and when commands run unexpectedly slowly. Read-only.",
      input: z.object({}),
      async execute(_input, { agent, paseo }) {
        try {
          const context = { paseo } as PluginHandlerContext;
          const [metrics, attribution] = await Promise.all([
            deps.metrics(),
            deps.attribute(context).catch(() => null),
          ]);
          const report = machineReport(metrics, attribution, agent?.id ?? null);
          return { text: report.text, structuredContent: report.data };
        } catch (error) {
          return failure("machine_status", error);
        }
      },
    },
    {
      name: "machine_explain_process",
      title: "Explain a process",
      description:
        "Explain one process on this Mac by PID: what it is, which agent started it if any, whether it became busy recently or always runs like this, and what to do about it. Use a PID from machine_status or ps. Read-only.",
      input: z.object({ pid: z.number().int().positive() }),
      async execute(input, { paseo }) {
        try {
          const { pid } = z.object({ pid: z.number().int().positive() }).parse(input);
          const result = await deps.explain(pid, { paseo } as PluginHandlerContext);
          const { explanation } = result;
          return {
            text: [
              `${result.name} (PID ${result.pid}): ${explanation.headline}`,
              ...explanation.findings,
              `Advice: ${explanation.advice.join(" ")}`,
            ].join("\n"),
            structuredContent: result,
          };
        } catch (error) {
          return failure("machine_explain_process", error);
        }
      },
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Adds the tools to a session-open request that can carry them. Paseo hands
 * each plugin's hook its own empty `tools` list and merges the results, so the
 * request is returned whole with the tools appended. A request without `tools`
 * comes from a daemon before 0.14 and goes back untouched.
 */
export function withMachineTools<Request extends object>(request: Request, tools: readonly MachineTool[]): Request {
  const current = (request as { tools?: unknown }).tools;
  if (!Array.isArray(current)) return request;
  const own = new Set(tools.map((tool) => tool.name));
  const kept = current.filter((tool: { name?: unknown }) => !own.has(String(tool?.name)));
  return { ...request, tools: [...kept, ...tools] };
}

/**
 * Registers the session-open hook. A hook that throws stops the agent from
 * starting, so any failure here returns nothing, which Paseo reads as "leave the
 * request as it is": the agent starts without these tools rather than not at all.
 */
export function registerAgentTools(server: Pick<PluginServerContext, "before">, tools: MachineTool[] = machineTools()): () => void {
  if (typeof server.before !== "function") return () => {};
  return server.before("agent.session_open", ({ request }) => {
    try {
      return withMachineTools(request, tools);
    } catch {
      return undefined;
    }
  });
}
