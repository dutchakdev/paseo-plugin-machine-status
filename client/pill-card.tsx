import { useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useMemo } from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";
import { listProcesses, readMetrics } from "../shared/contracts";
import { formatBytes, formatPercent } from "../shared/format";
import { agentPorts, cpuSeverity, memorySeverity } from "../shared/pill";
import { readServices } from "../shared/services";
import { paletteFor, SEVERITY_LABEL, STATUS, takeLast, type Severity } from "../shared/viz";
import { Sparkbars } from "./charts";
import { ActionButton, useChromeStyles, type Chrome } from "./ui";

/** Enough samples to read a trend in a card a few hundred points wide. */
const SLOTS = 24;
const TABULAR: TextStyle = { fontVariant: ["tabular-nums"] };

/**
 * The pill's popover: more than the two numbers, far less than the tab.
 *
 * It answers "is the machine the reason this feels slow" at a glance: both
 * readings with their recent trend, what is using the CPU right now, and which
 * development ports agents have left listening. Everything else is one press
 * away in the Machine tab.
 *
 * Metrics and services share their query keys with the tab, so a card opened
 * after the tab paints from cache. Polling runs only while the card is open.
 */
export function createMachineCard(openMachine: () => void) {
  return function MachineCard({ theme, host, layout, close }: PluginButtonContentProps) {
    const chrome: Chrome = { theme, compact: true };
    const styles = useChromeStyles(chrome);
    const palette = useMemo(() => paletteFor(theme.colors.surface0), [theme.colors.surface0]);

    const read = useRpc(readMetrics);
    const metrics = useQuery({
      queryKey: ["machine-status", "metrics", host.id],
      queryFn: () => read({}),
      refetchInterval: 3_000,
    });
    const top = useRpc(listProcesses);
    const processes = useQuery({
      queryKey: ["machine-status", "processes", host.id, "card"],
      queryFn: () => top({ sortBy: "cpu", limit: 3 }),
      refetchInterval: 5_000,
    });
    const scan = useRpc(readServices);
    const services = useQuery({
      queryKey: ["machine-status", "services", host.id],
      queryFn: () => scan({}),
      staleTime: 15_000,
    });

    const history = metrics.data?.history ?? [];
    const cpuSeries = useMemo(() => takeLast(history.map((sample) => sample.cpuLoadPercent), SLOTS), [history]);
    const pressureSeries = useMemo(
      () => takeLast(history.map((sample) => sample.pressurePercent ?? 0), SLOTS),
      [history],
    );
    const ports = useMemo(() => agentPorts(services.data?.ports ?? []), [services.data]);

    // A popover sizes to its content; without a width the sparkbars collapse.
    // On compact layouts the card is a bottom sheet and takes the sheet's width.
    const frame = layout.compact ? { alignSelf: "stretch" as const, gap: 12 } : { width: 300, gap: 12 };
    const divider = <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: palette.border }} />;
    const openTab = () => {
      close();
      openMachine();
    };

    const data = metrics.data;
    if (!data) {
      return (
        <View style={frame}>
          <Text style={metrics.error ? styles.danger : styles.muted}>
            {metrics.error ? (metrics.error as Error).message : "Reading the machine…"}
          </Text>
          <ActionButton chrome={chrome} label="Open Machine" variant="ghost" onPress={openTab} />
        </View>
      );
    }

    const footer = [
      `Disk ${formatPercent(data.disk.usedPercent)}`,
      data.power.percent !== null
        ? `Battery ${formatPercent(data.power.percent)}${data.power.source === "ac" ? " on AC" : ""}`
        : null,
      data.thermal.level !== "nominal" && data.thermal.level !== "unknown" ? `Thermal ${data.thermal.level}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <View style={frame}>
        <Reading
          chrome={chrome}
          label="CPU"
          color={palette.series[0]}
          value={formatPercent(data.cpu.loadPercent)}
          severity={cpuSeverity(data.cpu.loadPercent)}
          detail={`load ${data.cpu.loadAvg1.toFixed(2)} · ${data.cpu.cores} cores`}
          series={cpuSeries}
        />
        <Reading
          chrome={chrome}
          label="MEMORY"
          color={palette.series[1]}
          value={formatPercent(data.memory.pressurePercent)}
          severity={memorySeverity(data.memory.pressurePercent)}
          detail={`${formatBytes(data.memory.appBytes)} app · swap ${formatBytes(data.swap.usedBytes)}`}
          series={pressureSeries}
        />

        {divider}
        <View style={{ gap: 4 }}>
          <Text style={styles.muted}>Top processes</Text>
          {(processes.data?.items ?? []).map((item) => (
            <View key={item.pid} style={styles.row}>
              <Text numberOfLines={1} style={[styles.value, { flex: 1 }]}>
                {item.name}
              </Text>
              <Text style={[styles.muted, TABULAR]}>{formatPercent(item.cpuPercent)}</Text>
              <Text style={[styles.muted, TABULAR, { minWidth: 60, textAlign: "right" }]}>
                {formatBytes(item.memoryBytes)}
              </Text>
            </View>
          ))}
          {processes.data && processes.data.items.length === 0 ? <Text style={styles.muted}>None</Text> : null}
        </View>

        {ports.length > 0 ? (
          <>
            {divider}
            <View style={{ gap: 4 }}>
              <Text style={styles.muted}>Started by agents</Text>
              {ports.map((port) => (
                <View key={port.id} style={styles.row}>
                  <Text style={[styles.value, TABULAR]}>:{port.port}</Text>
                  <Text numberOfLines={1} style={[styles.muted, { flex: 1, textAlign: "right" }]}>
                    {port.command ?? "unknown"} · {port.attribution?.label}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {divider}
        <Text style={styles.muted}>{footer}</Text>
        <ActionButton chrome={chrome} label="Open Machine" variant="ghost" onPress={openTab} />
      </View>
    );
  };
}

/** One reading: the figure with its severity in words, and the trend beside it. */
function Reading({
  chrome,
  label,
  color,
  value,
  severity,
  detail,
  series,
}: {
  chrome: Chrome;
  label: string;
  color: string;
  value: string;
  severity: Severity;
  detail: string;
  series: readonly number[];
}) {
  const styles = useChromeStyles(chrome);
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.row}>
        <Text style={[styles.cardTitle, { color }]}>{label}</Text>
        <Text numberOfLines={1} style={styles.muted}>
          {detail}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
        <View style={{ minWidth: 64 }}>
          <Text style={[styles.valueStrong, TABULAR, severity === "good" ? null : { color: STATUS[severity] }]}>
            {value}
          </Text>
          <Text style={styles.axis}>{SEVERITY_LABEL[severity]}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Sparkbars values={series} min={0} max={100} slots={SLOTS} color={color} height={28} />
        </View>
      </View>
    </View>
  );
}
