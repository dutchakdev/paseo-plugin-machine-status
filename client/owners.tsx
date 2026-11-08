import React from "react";
import { Text, View, type TextStyle } from "react-native";
import { summarizeOwners, type CpuAttribution, type OwnerKind } from "../shared/attribution";
import { formatCores } from "../shared/format";
import type { VizPalette } from "../shared/viz";
import { Legend } from "./charts";
import { useChromeStyles, type Chrome } from "./ui";

const TABULAR: TextStyle = { fontVariant: ["tabular-nums"] };

/** Fixed slots: agents lead because they are the question, "other" is quietest. */
function colorOf(kind: OwnerKind, palette: VizPalette): string {
  switch (kind) {
    case "agents":
      return palette.series[0];
    case "paseo":
      return palette.series[1];
    case "system":
      return palette.series[2];
    default:
      return palette.neutral;
  }
}

/**
 * Who the busy CPU belongs to: each agent, Paseo itself, macOS, the rest.
 *
 * One stacked bar answers "is it my agents" at a glance; the rows under it name
 * the agents and what each is running. Figures are cores (`ps` %CPU / 100),
 * because a share of a multi-core machine reads more plainly that way than a
 * percentage that can pass 100.
 */
export function CpuOwners({
  chrome,
  palette,
  data,
  agentLimit,
}: {
  chrome: Chrome;
  palette: VizPalette;
  data: CpuAttribution;
  /** How many agent rows to show; the rest are counted. */
  agentLimit: number;
}) {
  const styles = useChromeStyles(chrome);
  const summary = summarizeOwners(data.groups);
  const shown = summary.agents.slice(0, agentLimit);
  const hidden = summary.agents.length - shown.length;

  return (
    <View style={{ gap: 8 }}>
      <View
        accessibilityRole="image"
        accessibilityLabel={summary.segments.map((segment) => `${segment.label} ${formatCores(segment.cpuPercent)}`).join(", ")}
        style={{ flexDirection: "row", height: 8, borderRadius: 4, overflow: "hidden", gap: 1, backgroundColor: palette.neutral }}
      >
        {summary.totalPercent > 0
          ? summary.segments
              .filter((segment) => segment.cpuPercent > 0)
              .map((segment) => (
                <View key={segment.kind} style={{ flex: segment.cpuPercent, backgroundColor: colorOf(segment.kind, palette) }} />
              ))
          : null}
      </View>
      <Legend
        chrome={chrome}
        items={summary.segments.map((segment) => ({
          label: segment.label,
          value: formatCores(segment.cpuPercent),
          color: colorOf(segment.kind, palette),
        }))}
      />

      {shown.map((agent) => (
        <View key={agent.id} style={{ gap: 1 }}>
          <View style={styles.row}>
            <Text numberOfLines={1} style={[styles.value, { flex: 1 }]}>
              {agent.label}
            </Text>
            <Text style={[styles.value, TABULAR]}>{formatCores(agent.cpuPercent)}</Text>
          </View>
          <Text numberOfLines={1} style={styles.muted}>
            {[agent.detail, agent.top.map((process) => process.name).join(", "), `${agent.processCount} processes`]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
      ))}
      {summary.agents.length === 0 ? <Text style={styles.muted}>No agent is using the CPU right now.</Text> : null}
      {hidden > 0 || summary.idleAgents > 0 ? (
        <Text style={styles.axis}>
          {[
            hidden > 0 ? `${hidden} more agent${hidden === 1 ? "" : "s"} using CPU` : null,
            summary.idleAgents > 0
              ? `${summary.idleAgents} idle agent${summary.idleAgents === 1 ? "" : "s"} still holding processes`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
      {data.notes.map((note) => (
        <Text key={note} style={styles.danger}>
          {note}
        </Text>
      ))}
    </View>
  );
}
