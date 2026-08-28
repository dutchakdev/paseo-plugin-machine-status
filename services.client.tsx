import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { readServices, type PortRow, type ServiceRow } from "./services.shared";
import { ActionButton, Card, useChromeStyles, type Chrome } from "./ui.client";
import { paletteFor, STATUS, type VizPalette } from "./viz.shared";

const SOURCE_DOT: Record<ServiceRow["source"], "agent" | "plain"> = {
  agent: "agent",
  "agent-child": "agent",
  docker: "plain",
  listener: "plain",
};

export function ServicesTab({ theme, layout, host }: PluginSurfaceProps) {
  const chrome: Chrome = { theme, compact: layout.compact };
  const styles = useChromeStyles(chrome);
  const palette = paletteFor(theme.colors.surface0);
  const read = useRpc(readServices);

  // Collection shells out to netstat, lsof, ps and docker, so it only runs while
  // this tab is the one on screen.
  const services = useQuery({
    queryKey: ["machine-status", "services", host.id],
    queryFn: () => read({}),
    refetchInterval: 5_000,
  });

  const data = services.data;
  const [showSystem, setShowSystem] = useState(false);

  // The OS listens on plenty of ports that have nothing to do with development:
  // AirPlay on 5000 and 7000, Handoff on an ephemeral port, Remote Desktop on
  // 3283. They are classified, not deleted, so the toggle can bring them back.
  const allPorts = data?.ports ?? [];
  const systemPorts = allPorts.filter((row) => row.relevance === "system");
  const ports = showSystem ? allPorts : allPorts.filter((row) => row.relevance === "dev");

  const allServices = data?.services ?? [];
  const shownServices = showSystem
    ? allServices
    : allServices.filter((service) => service.relevance === "dev");

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {services.error ? (
        <Card chrome={chrome} title="Ports unavailable">
          <Text style={styles.danger}>{(services.error as Error).message}</Text>
        </Card>
      ) : null}

      <View style={styles.band}>
        <View style={{ flex: 1.25 }}>
          <Card
            chrome={chrome}
            title="Open ports"
            subtitle={data ? `${ports.length} of ${allPorts.length} listening` : undefined}
          >
            <View style={[styles.rowWrap, { alignItems: "center" }]}>
              <Legend chrome={chrome} palette={palette} color={STATUS.warning} label="reachable" />
              <Legend chrome={chrome} palette={palette} color={palette.neutral} label="loopback only" />
              <View style={{ flex: 1 }} />
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: showSystem }}
                accessibilityLabel="Show system ports"
                onPress={() => setShowSystem((value) => !value)}
                style={({ pressed }) => [
                  styles.chip,
                  {
                    borderColor: showSystem ? chrome.theme.colors.accent : palette.borderStrong,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Text style={showSystem ? styles.value : styles.muted}>
                  {showSystem ? "Hide" : "Show"} system ({systemPorts.length})
                </Text>
              </Pressable>
            </View>

            {!layout.compact ? (
              <View style={[styles.processRow, { paddingVertical: 2 }]}>
                <Text style={[styles.axis, { width: 62 }]}>PORT</Text>
                <Text style={[styles.axis, { width: 44 }]}>PROTO</Text>
                <Text style={[styles.axis, { width: 96 }]}>ADDRESS</Text>
                <Text style={[styles.axis, { flex: 1 }]}>PROCESS</Text>
                <Text style={[styles.axis, { width: 58, textAlign: "right" }]}>PID</Text>
                <View style={{ width: 74 }} />
              </View>
            ) : null}

            {ports.map((row) => (
              <PortLine key={row.id} chrome={chrome} palette={palette} row={row} />
            ))}

            {data && ports.length === 0 ? (
              <Text style={styles.muted}>
                {allPorts.length === 0
                  ? "Nothing is listening."
                  : "No development ports. Everything listening belongs to the OS."}
              </Text>
            ) : null}
          </Card>
        </View>

        <View style={{ flex: 1 }}>
          <Card
            chrome={chrome}
            title="Running apps"
            subtitle={data ? `${shownServices.length} services` : undefined}
          >
            {shownServices.map((service) => (
              <View key={service.id} style={styles.processRow}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor:
                      SOURCE_DOT[service.source] === "agent" ? palette.series[0] : STATUS.good,
                  }}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.value} numberOfLines={1}>
                    {service.name}
                  </Text>
                  <Text style={styles.muted} numberOfLines={1}>
                    {service.subtitle}
                  </Text>
                </View>
                <Text style={[styles.muted, { width: 78, textAlign: "right" }]} numberOfLines={1}>
                  {service.ports.length > 0 ? service.ports.map((port) => `:${port}`).join(" ") : "—"}
                </Text>
              </View>
            ))}

            {data && shownServices.length === 0 ? (
              <Text style={styles.muted}>No services detected.</Text>
            ) : null}

            {(data?.notes ?? []).map((note) => (
              <Text key={note} style={styles.muted}>
                {note}
              </Text>
            ))}
          </Card>
        </View>
      </View>
    </ScrollView>
  );
}

function Legend({
  chrome,
  color,
  label,
}: {
  chrome: Chrome;
  palette: VizPalette;
  color: string;
  label: string;
}) {
  const styles = useChromeStyles(chrome);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

function PortLine({
  chrome,
  palette,
  row,
}: {
  chrome: Chrome;
  palette: VizPalette;
  row: PortRow;
}) {
  const styles = useChromeStyles(chrome);
  const exposed = row.scope !== "local";
  const label = row.attribution?.label ?? (row.owner === "other" ? "another user" : "unknown");

  const openIt = () => {
    if (row.url) void Linking.openURL(row.url).catch(() => undefined);
  };

  if (chrome.compact) {
    return (
      <View style={[styles.processRow, { flexDirection: "column", alignItems: "stretch", gap: 4 }]}>
        <View style={styles.row}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Dot color={exposed ? STATUS.warning : palette.neutral} />
            <Text style={styles.valueStrong}>{row.port}</Text>
            <Text style={styles.muted}>{row.protocol.toUpperCase()}</Text>
          </View>
          {row.url ? (
            <ActionButton chrome={chrome} variant="ghost" label="Open" onPress={openIt} />
          ) : null}
        </View>
        <Text style={styles.muted} numberOfLines={1}>
          {row.address} · {label}
          {row.pid === null ? "" : ` · PID ${row.pid}`}
        </Text>
        {row.attribution?.detail ? (
          <Text style={styles.muted} numberOfLines={1}>
            {row.attribution.detail}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.processRow}>
      <View style={{ width: 62, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Dot color={exposed ? STATUS.warning : palette.neutral} />
        <Text style={styles.valueStrong}>{row.port}</Text>
      </View>
      <Text style={[styles.muted, { width: 44 }]}>{row.protocol.toUpperCase()}</Text>
      <Text style={[styles.muted, { width: 96 }]} numberOfLines={1}>
        {row.address}
      </Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.value} numberOfLines={1}>
          {label}
        </Text>
        {row.attribution?.detail ? (
          <Text style={styles.muted} numberOfLines={1}>
            {row.attribution.detail}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.muted, { width: 58, textAlign: "right" }]}>{row.pid ?? "—"}</Text>
      <View style={{ width: 74, alignItems: "flex-end" }}>
        {row.url ? (
          <ActionButton chrome={chrome} variant="ghost" label="Open" onPress={openIt} />
        ) : (
          <Text style={styles.muted}>—</Text>
        )}
      </View>
    </View>
  );
}

function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}
