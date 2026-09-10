import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  controlContainer,
  controlEngine,
  pruneDocker,
  readContainerLogs,
  readDocker,
  removeImage,
  type DockerContainer,
  type DockerImage,
} from "../shared/docker";
import { formatBytes } from "../shared/format";
import { contextMenuTriggers, useContextMenu, type ContextMenuItem } from "./menu";
import { Card, MetricRow, useChromeStyles, type Chrome } from "./ui";
import { paletteFor, STATUS, type VizPalette } from "../shared/viz";

export function DockerTab({ theme, layout, host }: PluginSurfaceProps) {
  const chrome: Chrome = { theme, compact: layout.compact };
  const styles = useChromeStyles(chrome);
  const palette = paletteFor(theme.colors.surface0);
  const read = useRpc(readDocker);
  const control = useRpc(controlContainer);
  const prune = useRpc(pruneDocker);
  const engineControl = useRpc(controlEngine);
  const logs = useRpc(readContainerLogs);
  const dropImage = useRpc(removeImage);
  const openMenu = useContextMenu();
  const anchor = useRef({ x: 0, y: 0 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [engineStarting, setEngineStarting] = useState(false);

  const docker = useQuery({
    queryKey: ["machine-status", "docker", host.id],
    queryFn: () => read({}),
    // While the engine is coming up, poll fast enough that the panel notices;
    // Docker Desktop takes tens of seconds to answer after being launched.
    refetchInterval: activeId !== null ? false : engineStarting ? 3_000 : 10_000,
  });

  const act = useMutation({
    mutationFn: (input: { id: string; action: "start" | "stop" | "restart" | "remove" }) =>
      control(input),
    onSettled: () => {
      setActiveId(null);
      void docker.refetch();
    },
  });

  const clean = useMutation({
    mutationFn: (target: "containers" | "images") => prune({ target }),
    onSettled: () => void docker.refetch(),
  });

  const engine = useMutation({
    mutationFn: (action: "start" | "quit") => engineControl({ action }),
    onSuccess: (_result, action) => setEngineStarting(action === "start"),
    onSettled: () => void docker.refetch(),
  });

  const viewLogs = useMutation({
    mutationFn: (container: DockerContainer) =>
      logs({ id: container.id, lines: 200 }).then((result) => ({ ...result, name: container.name })),
  });

  const imageAction = useMutation({
    mutationFn: (id: string) => dropImage({ id }),
    onSettled: () => void docker.refetch(),
  });

  const data = docker.data;
  const containers = data?.containers ?? [];
  const running = containers.filter((container) => container.running);

  const confirm = (container: DockerContainer, action: "stop" | "restart" | "remove") => {
    const wording: Record<typeof action, string> = {
      stop: `Stop ${container.name}? Anything connecting to it loses the connection.`,
      restart: `Restart ${container.name}? It is unavailable while it comes back.`,
      remove: `Remove ${container.name}? The container is gone; its volumes stay.`,
    };
    openMenu({
      ...anchor.current,
      title: wording[action],
      items: [
        {
          id: "confirm",
          label: `Confirm — ${action}`,
          tone: "danger",
          onSelect: () => act.mutate({ id: container.id, action }),
        },
        { id: "cancel", label: "Cancel", onSelect: () => setActiveId(null) },
      ],
    });
  };

  const menuFor = (container: DockerContainer): ContextMenuItem[] => {
    const actions: ContextMenuItem[] = [
      { id: "logs", label: "View logs", onSelect: () => viewLogs.mutate(container) },
    ];
    for (const port of container.ports.slice(0, 3)) {
      actions.push({
        id: `open-${port}`,
        label: `Open http://127.0.0.1:${port}`,
        onSelect: () => void Linking.openURL(`http://127.0.0.1:${port}`).catch(() => undefined),
      });
    }
    if (container.running) {
      actions.push(
        { id: "restart", label: "Restart…", onSelect: () => confirm(container, "restart") },
        { id: "stop", label: "Stop…", tone: "danger", onSelect: () => confirm(container, "stop") },
      );
    } else {
      actions.push(
        { id: "start", label: "Start", onSelect: () => act.mutate({ id: container.id, action: "start" }) },
        { id: "remove", label: "Remove…", tone: "danger", onSelect: () => confirm(container, "remove") },
      );
    }
    return actions;
  };

  const open = (container: DockerContainer, x: number, y: number) => {
    anchor.current = { x, y };
    setActiveId(container.id);
    act.reset();
    openMenu({ x, y, title: `${container.name} · ${container.state}`, items: menuFor(container) });
  };

  const openImageMenu = (image: DockerImage, x: number, y: number) => {
    imageAction.reset();
    openMenu({
      x,
      y,
      title: image.dangling ? "Untagged image" : image.reference,
      items: [
        {
          id: "remove",
          label: "Remove…",
          tone: "danger",
          onSelect: () =>
            openMenu({
              x,
              y,
              title: `Remove ${image.reference}? Anything using it must pull again.`,
              items: [
                {
                  id: "go",
                  label: `Confirm — free ${formatBytes(image.sizeBytes)}`,
                  tone: "danger",
                  onSelect: () => imageAction.mutate(image.id),
                },
                { id: "cancel", label: "Cancel", onSelect: () => undefined },
              ],
            }),
        },
      ],
    });
  };

  const confirmPrune = (target: "containers" | "images", x: number, y: number) => {
    openMenu({
      x,
      y,
      title:
        target === "containers"
          ? "Remove every stopped container?"
          : "Remove dangling images? Tagged images stay.",
      items: [
        { id: "go", label: "Confirm — remove", tone: "danger", onSelect: () => clean.mutate(target) },
        { id: "cancel", label: "Cancel", onSelect: () => undefined },
      ],
    });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {data ? (
        <Card
          chrome={chrome}
          title="Engine"
          subtitle={data.engine.version ? `v${data.engine.version}` : undefined}
        >
          <View style={styles.row}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor:
                    data.engine.state === "running"
                      ? STATUS.good
                      : data.engine.state === "stopped"
                        ? STATUS.warning
                        : palette.neutral,
                }}
              />
              {/* The dot repeats the word; it never carries the state alone. */}
              <Text style={styles.value}>
                {data.engine.state === "running"
                  ? `${data.engine.app ?? "Docker"} is running`
                  : engineStarting
                    ? `${data.engine.app ?? "Docker"} is starting — this takes a moment`
                    : (data.reason ?? "Not running")}
              </Text>
            </View>

            {data.engine.state === "stopped" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Start ${data.engine.app ?? "Docker"}`}
                disabled={engine.isPending || engineStarting}
                onPress={() => engine.mutate("start")}
                style={({ pressed }) => [
                  styles.button,
                  { backgroundColor: theme.colors.accent, opacity: pressed || engineStarting ? 0.7 : 1 },
                ]}
              >
                <Text style={styles.buttonText}>
                  {engineStarting ? "Starting…" : `Start ${data.engine.app ?? "Docker"}`}
                </Text>
              </Pressable>
            ) : data.engine.state === "running" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Quit the engine"
                onPress={(event) =>
                  openMenu({
                    x: event.nativeEvent.pageX,
                    y: event.nativeEvent.pageY,
                    title: `Quit ${data.engine.app ?? "Docker"}? Every running container stops.`,
                    items: [
                      {
                        id: "quit",
                        label: "Confirm — quit",
                        tone: "danger",
                        onSelect: () => engine.mutate("quit"),
                      },
                      { id: "cancel", label: "Cancel", onSelect: () => undefined },
                    ],
                  })
                }
                style={({ pressed }) => [styles.ghostButton, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={styles.ghostButtonText}>Quit…</Text>
              </Pressable>
            ) : null}
          </View>

          {engine.data?.error ? <Text style={styles.danger}>{engine.data.error}</Text> : null}
          {data.engine.state === "missing" ? (
            <Text style={styles.muted}>
              Install Docker Desktop, OrbStack or Rancher Desktop and this tab starts working.
            </Text>
          ) : null}
        </Card>
      ) : null}

      {docker.error ? (
        <Card chrome={chrome} title="Docker unavailable">
          <Text style={styles.danger}>{(docker.error as Error).message}</Text>
        </Card>
      ) : null}

      {viewLogs.data ? (
        <LogView
          chrome={chrome}
          palette={palette}
          name={viewLogs.data.name}
          text={viewLogs.data.text}
          error={viewLogs.data.error}
          onDismiss={() => viewLogs.reset()}
        />
      ) : null}
      {viewLogs.isPending ? <Text style={styles.muted}>Reading logs…</Text> : null}

      {data?.available ? (
        <View style={styles.band}>
          <View style={{ flex: 1.3 }}>
            <Card
              chrome={chrome}
              title="Containers"
              subtitle={`${running.length} running of ${containers.length}`}
            >
              {!layout.compact ? (
                <View style={[styles.processRow, { paddingVertical: 2 }]}>
                  <Text style={[styles.axis, { flex: 1 }]}>NAME</Text>
                  <Text style={[styles.axis, { width: 150 }]}>IMAGE</Text>
                  <Text style={[styles.axis, { width: 96 }]}>PORTS</Text>
                  <Text style={[styles.axis, { width: 120, textAlign: "right" }]}>STATUS</Text>
                </View>
              ) : null}

              {containers.map((container) => (
                <Pressable
                  key={container.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${container.name}, ${container.image}, ${container.status}. Opens actions.`}
                  accessibilityState={{ selected: container.id === activeId }}
                  onPress={(event) => open(container, event.nativeEvent.pageX, event.nativeEvent.pageY)}
                  {...contextMenuTriggers((x, y) => open(container, x, y))}
                  style={({ pressed }) => [
                    styles.processRow,
                    {
                      backgroundColor: container.id === activeId ? palette.border : "transparent",
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: container.running ? STATUS.good : palette.neutral,
                      }}
                    />
                    <Text style={styles.value} numberOfLines={1}>
                      {container.name}
                    </Text>
                  </View>
                  <Text style={[styles.muted, { width: 150 }]} numberOfLines={1}>
                    {container.image}
                  </Text>
                  <Text style={[styles.muted, { width: 96 }]} numberOfLines={1}>
                    {container.ports.length > 0
                      ? container.ports.map((port) => `:${port}`).join(" ")
                      : "—"}
                  </Text>
                  {/* The dot repeats the status word, never replaces it. */}
                  <Text style={[styles.muted, { width: 120, textAlign: "right" }]} numberOfLines={1}>
                    {container.status}
                  </Text>
                </Pressable>
              ))}

              {containers.length === 0 ? (
                <Text style={styles.muted}>No containers.</Text>
              ) : (
                <Text style={styles.axis}>right-click a container</Text>
              )}

              {act.data?.error ? <Text style={styles.danger}>{act.data.error}</Text> : null}
            </Card>
          </View>

          <View style={{ flex: 1 }}>
            <Card chrome={chrome} title="Disk usage">
              {(data.usage ?? []).map((row) => (
                <View key={row.label} style={{ gap: 2 }}>
                  <MetricRow
                    chrome={chrome}
                    label={`${row.label} (${row.active} of ${row.total} active)`}
                    value={formatBytes(row.sizeBytes)}
                  />
                  <Text style={styles.axis}>
                    {formatBytes(row.reclaimableBytes)} reclaimable
                    {row.safeToReclaim ? "" : " — but this is container data"}
                  </Text>
                </View>
              ))}

              <View style={{ height: 4 }} />

              <PruneButton
                chrome={chrome}
                label="Remove stopped containers…"
                onPress={(x, y) => confirmPrune("containers", x, y)}
              />
              <PruneButton
                chrome={chrome}
                label="Remove dangling images…"
                onPress={(x, y) => confirmPrune("images", x, y)}
              />

              {clean.isPending ? <Text style={styles.muted}>Pruning…</Text> : null}
              {clean.data ? (
                <Text style={clean.data.ok ? styles.value : styles.danger}>
                  {clean.data.ok
                    ? `Reclaimed ${formatBytes(clean.data.reclaimedBytes)}.`
                    : clean.data.error}
                </Text>
              ) : null}

              {(data.notes ?? []).map((note) => (
                <Text key={note} style={styles.muted}>
                  {note}
                </Text>
              ))}
            </Card>

            <View style={{ height: chrome.compact ? 10 : 14 }} />

            <Card
              chrome={chrome}
              title="Images"
              subtitle={`${data.images.length} · ${data.images.filter((image) => image.dangling).length} untagged`}
            >
              {data.images.slice(0, 12).map((image) => (
                <Pressable
                  key={image.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${image.reference}, ${formatBytes(image.sizeBytes)}. Opens actions.`}
                  onPress={(event) => openImageMenu(image, event.nativeEvent.pageX, event.nativeEvent.pageY)}
                  {...contextMenuTriggers((x, y) => openImageMenu(image, x, y))}
                  style={({ pressed }) => [styles.processRow, { opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text style={[styles.value, { flex: 1 }]} numberOfLines={1}>
                    {image.dangling ? "untagged" : image.reference}
                  </Text>
                  <Text style={[styles.muted, { width: 80, textAlign: "right" }]}>
                    {formatBytes(image.sizeBytes)}
                  </Text>
                </Pressable>
              ))}
              {data.images.length > 12 ? (
                <Text style={styles.axis}>{data.images.length - 12} more not shown</Text>
              ) : null}
              {imageAction.data?.error ? (
                <Text style={styles.danger}>{imageAction.data.error}</Text>
              ) : null}
            </Card>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

function PruneButton({
  chrome,
  label,
  onPress,
}: {
  chrome: Chrome;
  label: string;
  onPress: (x: number, y: number) => void;
}) {
  const styles = useChromeStyles(chrome);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={(event) => onPress(event.nativeEvent.pageX, event.nativeEvent.pageY)}
      style={({ pressed }) => [styles.ghostButton, { opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={styles.ghostButtonText}>{label}</Text>
    </Pressable>
  );
}

/** Container logs, shown in the panel rather than sending the user to a terminal. */
function LogView({
  chrome,
  palette,
  name,
  text,
  error,
  onDismiss,
}: {
  chrome: Chrome;
  palette: VizPalette;
  name: string;
  text: string;
  error: string | null;
  onDismiss: () => void;
}) {
  const styles = useChromeStyles(chrome);
  return (
    <Card chrome={chrome} title={`Logs · ${name}`}>
      <View style={styles.row}>
        <Text style={styles.axis}>last 200 lines</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss logs" onPress={onDismiss}>
          <Text style={styles.muted}>Dismiss</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      <View
        style={{
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.border,
          padding: 10,
        }}
      >
        <Text style={[styles.muted, { fontFamily: "Menlo" }]} selectable>
          {text.length > 0 ? text : "This container has produced no output."}
        </Text>
      </View>
    </Card>
  );
}
