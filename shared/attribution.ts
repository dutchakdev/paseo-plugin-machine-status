import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const CpuGroupSchema = z.object({
  /** An agent, Paseo itself, a macOS component, or anything else. */
  kind: z.enum(["agent", "paseo", "system", "other"]),
  /** The agent id for agents; "paseo", "system" or "other" otherwise. */
  id: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  /** Summed `ps` %CPU of the group: 100 is one core. */
  cpuPercent: z.number(),
  processCount: z.number(),
  /** The heaviest busy processes in the group, at most three. */
  top: z.array(z.object({ pid: z.number(), name: z.string(), cpuPercent: z.number() })),
});

export const attributeCpu = defineRpc({
  name: "cpu.attribute",
  input: z.object({}),
  output: z.object({
    collectedAt: z.string(),
    /** Sum over every group, on the same scale. */
    totalPercent: z.number(),
    groups: z.array(CpuGroupSchema),
    notes: z.array(z.string()),
  }),
});

export type CpuGroup = z.output<typeof CpuGroupSchema>;
export type CpuAttribution = z.output<typeof attributeCpu.output>;

export type OwnerKind = "agents" | "paseo" | "system" | "other";

export interface OwnerSummary {
  totalPercent: number;
  /** Always four, in this order, so each keeps its colour and place. */
  segments: { kind: OwnerKind; label: string; cpuPercent: number }[];
  /** Agents using any CPU, heaviest first. */
  agents: CpuGroup[];
  /** Agents that hold processes but use no CPU right now. */
  idleAgents: number;
}

const SEGMENT_LABEL: Record<OwnerKind, string> = {
  agents: "Agents",
  paseo: "Paseo",
  system: "macOS",
  other: "Other",
};

/** Folds the groups into the four bands a reader compares, plus the agents behind the first. */
export function summarizeOwners(groups: readonly CpuGroup[]): OwnerSummary {
  const sums: Record<OwnerKind, number> = { agents: 0, paseo: 0, system: 0, other: 0 };
  for (const group of groups) sums[group.kind === "agent" ? "agents" : group.kind] += group.cpuPercent;
  const agentGroups = groups.filter((group) => group.kind === "agent");
  return {
    totalPercent: Object.values(sums).reduce((sum, value) => sum + value, 0),
    segments: (Object.keys(sums) as OwnerKind[]).map((kind) => ({
      kind,
      label: SEGMENT_LABEL[kind],
      cpuPercent: sums[kind],
    })),
    agents: agentGroups
      .filter((group) => group.cpuPercent > 0)
      .sort((left, right) => right.cpuPercent - left.cpuPercent),
    idleAgents: agentGroups.filter((group) => group.cpuPercent <= 0).length,
  };
}
