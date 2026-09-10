import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ColumnChart, Legend, Meter, Sparkbars, StackedColumnChart, StatTile } from "./charts";
import { ServicesTab } from "./services";
import { CleanupSection } from "./cleanup";
import { DockerTab } from "./docker";
import { ContextMenuProvider } from "./menu";
import { readMetrics, type Metrics } from "../shared/contracts";
import { formatBytes, formatDuration, formatMinutes, formatPercent } from "../shared/format";
import { ProcessesSection } from "./processes";
import { ActionButton, Card, MetricRow, useChromeStyles, type Chrome } from "./ui";
import {
  paletteFor,
  SEVERITY_LABEL,
  severityOf,
  spanLabel,
  STATUS,
} from "../shared/viz";
import { cpuSeverity as cpuSeverityOf, memorySeverity as memorySeverityOf } from "../shared/pill";

type Expanded = "cpu" | "memory" | "swap" | "disk" | null;

const THERMAL_LABEL: Record<string, string> = {
  nominal: "Nominal",
  fair: "Fair",
  serious: "Serious",
  critical: "Critical",
  unknown: "Not reported",
};

const GB = 1024 ** 3;

function OverviewTab({ theme, layout, host }: PluginSurfaceProps) {
  const chrome: Chrome = { theme, compact: layout.compact };
  const styles = useChromeStyles(chrome);
  const palette = useMemo(() => paletteFor(theme.colors.surface0), [theme.colors.surface0]);

  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Expanded>(null);
  const toggle = (key: Exclude<Expanded, null>) =>
    setExpanded((current) => (current === key ? null : key));

  const read = useRpc(readMetrics);
  const metrics = useQuery({
    queryKey: ["machine-status", "metrics", host.id],
    queryFn: () => read({}),
    refetchInterval: paused ? false : 3_000,
  });
  const data = metrics.data;
  const history = data?.history ?? [];

  // Fixed plot widths: the chart occupies the whole card and fills from the right.
  const sparkSlots = layout.compact ? 20 : 40;
  const chartSlots = layout.compact ? 45 : 90;
  const stackSlots = layout.compact ? 24 : 45;
  const span = spanLabel(history[0]?.at, history[history.length - 1]?.at);

  const cpuSeries = useMemo(() => history.map((sample) => sample.cpuLoadPercent), [history]);
  const pressureSeries = useMemo(
    () => history.map((sample) => sample.pressurePercent ?? 0),
    [history],
  );
  const swapSeries = useMemo(
    () => history.map((sample) => sample.swapUsedBytes / GB),
    [history],
  );
  const memColumns = useMemo(
    () =>
      history.map((sample) => ({
        parts: [sample.appBytes, sample.wiredBytes, sample.compressedBytes],
        total: data?.memory.totalBytes ?? 1,
      })),
    [history, data?.memory.totalBytes],
  );

  // The pill and its card colour by the same thresholds; so does this tab.
  const cpuSeverity = cpuSeverityOf(data?.cpu.loadPercent ?? null);
  const memorySeverity = memorySeverityOf(data?.memory.pressurePercent ?? null);
  const diskSeverity = severityOf(data?.disk.usedPercent ?? null, 85, 95);
  const swapPercent =
    data && data.swap.totalBytes > 0 ? (data.swap.usedBytes / data.swap.totalBytes) * 100 : 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <View style={{ gap: 2, flexShrink: 1 }}>
          <Text style={styles.heading}>{data?.hostname ?? host.label}</Text>
          <Text style={styles.muted}>
            {data
              ? `${data.platform} · up ${formatDuration(data.uptimeSeconds)}`
              : "Reading metrics…"}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <Text style={styles.axis}>
            {paused ? "Paused" : `Live · every 3s · ${span}`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={paused ? "Resume sampling" : "Pause sampling"}
            onPress={() => setPaused((value) => !value)}
            style={({ pressed }) => [styles.chip, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={styles.value}>{paused ? "Resume" : "Pause"}</Text>
          </Pressable>
        </View>
      </View>

      {metrics.error ? (
        <Card chrome={chrome} title="Metrics unavailable">
          <Text style={styles.danger}>{(metrics.error as Error).message}</Text>
        </Card>
      ) : null}

      {data ? (
        <>
          <View style={styles.tiles}>
            <StatTile
              chrome={chrome}
              label="CPU"
              labelColor={palette.series[0]}
              meta={`${data.cpu.cores} cores`}
              value={data.cpu.loadAvg1.toFixed(2)}
              valueSuffix="load, 1 min"
              valueColor={cpuSeverity === "good" ? undefined : STATUS[cpuSeverity]}
              expanded={expanded === "cpu"}
              onPress={() => toggle("cpu")}
              footer={
                <Text style={styles.muted}>
                  5 min {data.cpu.loadAvg5.toFixed(2)} · 15 min {data.cpu.loadAvg15.toFixed(2)} ·{" "}
                  {SEVERITY_LABEL[cpuSeverity]}
                </Text>
              }
            >
              <Sparkbars
                values={cpuSeries}
                min={0}
                max={100}
                slots={sparkSlots}
                color={palette.series[0]}
              />
            </StatTile>

            <StatTile
              chrome={chrome}
              label="MEMORY"
              labelColor={palette.series[1]}
              meta={formatBytes(data.memory.totalBytes)}
              value={formatPercent(data.memory.pressurePercent)}
              valueSuffix="pressure"
              valueColor={memorySeverity === "good" ? undefined : STATUS[memorySeverity]}
              expanded={expanded === "memory"}
              onPress={() => toggle("memory")}
              footer={
                <Text style={styles.muted}>
                  {formatBytes(data.memory.usedBytes)} used · {SEVERITY_LABEL[memorySeverity]}
                </Text>
              }
            >
              <Sparkbars
                values={pressureSeries}
                min={0}
                max={100}
                slots={sparkSlots}
                color={palette.series[1]}
              />
            </StatTile>

            <StatTile
              chrome={chrome}
              label="SWAP"
              labelColor={palette.series[2]}
              meta={formatBytes(data.swap.totalBytes)}
              value={formatBytes(data.swap.usedBytes)}
              valueSuffix="in use"
              expanded={expanded === "swap"}
              onPress={() => toggle("swap")}
              footer={<Text style={styles.muted}>{formatBytes(data.swap.freeBytes)} free</Text>}
            >
              <Sparkbars
                values={swapSeries}
                min={0}
                max={Math.max(data.swap.totalBytes / GB, 0.1)}
                slots={sparkSlots}
                color={palette.series[2]}
              />
            </StatTile>

            <StatTile
              chrome={chrome}
              label="DISK"
              labelColor={palette.series[3]}
              meta={data.disk.mountedOn}
              value={formatPercent(data.disk.usedPercent)}
              valueSuffix="used"
              valueColor={diskSeverity === "good" ? undefined : STATUS[diskSeverity]}
              expanded={expanded === "disk"}
              onPress={() => toggle("disk")}
              footer={<Text style={styles.muted}>{formatBytes(data.disk.freeBytes)} free</Text>}
            >
              <View style={{ height: 34, justifyContent: "center" }}>
                <Meter
                  percent={data.disk.usedPercent}
                  color={diskSeverity === "good" ? palette.series[3] : STATUS[diskSeverity]}
                  palette={palette}
                />
              </View>
            </StatTile>
          </View>

          {expanded === "cpu" ? (
            <DetailCard chrome={chrome} title="CPU · detail" onClose={() => setExpanded(null)}>
              <MetricRow chrome={chrome} label="Load 1 min" value={data.cpu.loadAvg1.toFixed(2)} />
              <MetricRow chrome={chrome} label="Load 5 min" value={data.cpu.loadAvg5.toFixed(2)} />
              <MetricRow chrome={chrome} label="Load 15 min" value={data.cpu.loadAvg15.toFixed(2)} />
              <MetricRow
                chrome={chrome}
                label="Per core"
                value={`${formatPercent(data.cpu.loadPercent)} · ${SEVERITY_LABEL[cpuSeverity]}`}
              />
              <Text style={styles.muted}>
                Per-core utilisation needs a native call macOS does not expose to the shell, so it is
                not shown rather than estimated.
              </Text>
            </DetailCard>
          ) : null}

          {expanded === "memory" ? (
            <DetailCard chrome={chrome} title="Memory · detail" onClose={() => setExpanded(null)}>
              {[
                { label: "App", bytes: data.memory.appBytes, color: palette.series[0] },
                { label: "Wired", bytes: data.memory.wiredBytes, color: palette.series[1] },
                { label: "Compressed", bytes: data.memory.compressedBytes, color: palette.series[2] },
                { label: "Cached files", bytes: data.memory.cachedBytes, color: palette.neutral },
              ].map((row) => (
                <View key={row.label} style={{ gap: 4 }}>
                  <View style={styles.row}>
                    <Text style={styles.muted}>{row.label}</Text>
                    <Text style={styles.value}>{formatBytes(row.bytes)}</Text>
                  </View>
                  <Meter
                    percent={(row.bytes / data.memory.totalBytes) * 100}
                    color={row.color}
                    palette={palette}
                    height={6}
                  />
                </View>
              ))}
            </DetailCard>
          ) : null}

          {expanded === "swap" ? (
            <DetailCard chrome={chrome} title="Swap · detail" onClose={() => setExpanded(null)}>
              <ColumnChart
                chrome={chrome}
                values={swapSeries}
                min={0}
                max={Math.max(data.swap.totalBytes / GB, 0.1)}
                color={palette.series[2]}
                palette={palette}
                slots={chartSlots}
                height={110}
                topLabel={`${(data.swap.totalBytes / GB).toFixed(1)}G`}
                midLabel={`${(data.swap.totalBytes / GB / 2).toFixed(1)}G`}
                bottomLabel="0"
                caption={span}
              />
              <MetricRow chrome={chrome} label="In use" value={formatBytes(data.swap.usedBytes)} />
              <MetricRow chrome={chrome} label="Free" value={formatBytes(data.swap.freeBytes)} />
            </DetailCard>
          ) : null}

          {expanded === "disk" ? (
            <DetailCard chrome={chrome} title="Disk · detail" onClose={() => setExpanded(null)}>
              <Meter
                percent={data.disk.usedPercent}
                color={diskSeverity === "good" ? palette.series[3] : STATUS[diskSeverity]}
                palette={palette}
                height={12}
              />
              <MetricRow chrome={chrome} label="Volume" value={data.disk.mountedOn} />
              <MetricRow chrome={chrome} label="Used" value={formatBytes(data.disk.usedBytes)} />
              <MetricRow chrome={chrome} label="Free" value={formatBytes(data.disk.freeBytes)} />
            </DetailCard>
          ) : null}

          {/* The design pairs the two time charts on one band, 1.15fr : 1fr. */}
          <View style={styles.band}>
            <View style={{ flex: 1.15 }}>
              <Card
                chrome={chrome}
                title="CPU load over time"
                subtitle={`${formatPercent(data.cpu.loadPercent)} · ${SEVERITY_LABEL[cpuSeverity]}`}
              >
                <ColumnChart
                  chrome={chrome}
                  values={cpuSeries}
                  min={0}
                  max={100}
                  color={palette.series[0]}
                  palette={palette}
                  slots={chartSlots}
                  height={layout.compact ? 110 : 180}
                  topLabel="100%"
                  midLabel="50%"
                  bottomLabel="0%"
                  caption={span}
                />
              </Card>
            </View>
            <View style={{ flex: 1 }}>
              <Card
                chrome={chrome}
                title="Memory over time"
                subtitle={`${formatBytes(data.memory.usedBytes)} of ${formatBytes(data.memory.totalBytes)}`}
              >
                <StackedColumnChart
                  chrome={chrome}
                  columns={memColumns}
                  colors={[palette.series[0], palette.series[1], palette.series[2]]}
                  palette={palette}
                  slots={stackSlots}
                  height={layout.compact ? 110 : 180}
                  topLabel={formatBytes(data.memory.totalBytes, 0)}
                  midLabel={formatBytes(data.memory.totalBytes / 2, 0)}
                  bottomLabel="0"
                  caption={span}
                />
                <Legend
                  chrome={chrome}
                  items={[
                    { label: "App", value: formatBytes(data.memory.appBytes), color: palette.series[0] },
                    { label: "Wired", value: formatBytes(data.memory.wiredBytes), color: palette.series[1] },
                    {
                      label: "Compressed",
                      value: formatBytes(data.memory.compressedBytes),
                      color: palette.series[2],
                    },
                  ]}
                />
                <Text style={styles.muted}>
                  Headroom above the stack is unused memory · cached files{" "}
                  {formatBytes(data.memory.cachedBytes)}
                </Text>
              </Card>
            </View>
          </View>
        </>
      ) : null}

      {/* Bottom band, 360px : 1fr — resources on the left, processes on the right. */}
      <View style={styles.band}>
        <View style={[{ gap: layout.compact ? 10 : 14 }, layout.compact ? null : { width: 360 }]}>
          {data ? (
            <Card chrome={chrome} title="Disk & swap" subtitle={data.disk.mountedOn}>
              <View style={{ gap: 6 }}>
                <View style={styles.row}>
                  <Text style={styles.muted}>Capacity used</Text>
                  <Text style={styles.valueStrong}>{formatPercent(data.disk.usedPercent)}</Text>
                </View>
                <Meter
                  percent={data.disk.usedPercent}
                  color={diskSeverity === "good" ? palette.series[3] : STATUS[diskSeverity]}
                  palette={palette}
                  height={10}
                />
              </View>
              <MetricRow chrome={chrome} label="Used" value={formatBytes(data.disk.usedBytes)} />
              <MetricRow chrome={chrome} label="Free" value={formatBytes(data.disk.freeBytes)} />

              <View style={styles.divider} />

              <View style={{ gap: 6 }}>
                <View style={styles.row}>
                  <Text style={styles.muted}>Swap in use</Text>
                  <Text style={styles.valueStrong}>
                    {formatBytes(data.swap.usedBytes)} of {formatBytes(data.swap.totalBytes)}
                  </Text>
                </View>
                <Meter percent={swapPercent} color={palette.series[2]} palette={palette} height={10} />
              </View>
              <MetricRow chrome={chrome} label="Free" value={formatBytes(data.swap.freeBytes)} />

              <View style={styles.divider} />

              <MetricRow
                chrome={chrome}
                label="Power"
                value={
                  data.power.source === "ac"
                    ? `AC power${data.power.percent === null ? "" : ` · ${formatPercent(data.power.percent)}`}`
                    : data.power.source === "battery"
                      ? `Battery · ${formatPercent(data.power.percent)}`
                      : "Unknown"
                }
              />
              {data.power.timeRemainingMinutes !== null ? (
                <MetricRow
                  chrome={chrome}
                  label="Remaining"
                  value={formatMinutes(data.power.timeRemainingMinutes)}
                />
              ) : null}
              <MetricRow
                chrome={chrome}
                label="Thermal"
                value={THERMAL_LABEL[data.thermal.level] ?? data.thermal.level}
              />
            </Card>
          ) : null}
          <CleanupSection chrome={chrome} hostId={host.id} />
        </View>
        <View style={{ flex: 1 }}>
          <ProcessesSection chrome={chrome} hostId={host.id} palette={palette} />
        </View>
      </View>
    </ScrollView>
  );
}

function DetailCard({
  chrome,
  title,
  onClose,
  children,
}: {
  chrome: Chrome;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const styles = useChromeStyles(chrome);
  return (
    <View style={[styles.card, { borderColor: chrome.theme.colors.accent }]}>
      <View style={styles.row}>
        <Text style={styles.cardTitle}>{title}</Text>
        <ActionButton chrome={chrome} variant="ghost" label="Close" onPress={onClose} />
      </View>
      {children}
    </View>
  );
}


type TabId = "overview" | "services" | "docker";

const TABS: readonly { id: TabId; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "services", title: "Ports & services" },
  { id: "docker", title: "Docker" },
];

/**
 * Only the selected tab is mounted. The services tab shells out to netstat, lsof
 * and docker on a timer, and mounting it in the background would keep that
 * running for a panel nobody is looking at.
 */
export function MachineStatusSurface(props: PluginSurfaceProps) {
  const chrome: Chrome = { theme: props.theme, compact: props.layout.compact };
  const styles = useChromeStyles(chrome);
  const [tab, setTab] = useState<TabId>("overview");

  return (
    <ContextMenuProvider chrome={chrome}>
      <View style={styles.screen}>
      <View
        style={{
          flexDirection: "row",
          gap: props.layout.compact ? 16 : 24,
          paddingHorizontal: props.layout.compact ? 12 : 20,
          paddingTop: props.layout.compact ? 10 : 14,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: paletteFor(props.theme.colors.surface0).border,
        }}
      >
        {TABS.map((entry) => {
          const active = entry.id === tab;
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={entry.title}
              onPress={() => setTab(entry.id)}
              style={({ pressed }) => ({
                paddingBottom: 10,
                borderBottomWidth: 2,
                borderBottomColor: active ? props.theme.colors.accent : "transparent",
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text
                style={[
                  styles.value,
                  { fontWeight: "600" },
                  active ? null : { color: props.theme.colors.foregroundMuted },
                ]}
              >
                {entry.title}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "overview" ? <OverviewTab {...props} /> : null}
      {tab === "services" ? <ServicesTab {...props} /> : null}
      {tab === "docker" ? <DockerTab {...props} /> : null}
      </View>
    </ContextMenuProvider>
  );
}
