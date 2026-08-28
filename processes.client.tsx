import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { killProcess, listProcesses, type ProcessEntry } from "./contracts.shared";
import { formatBytes } from "./format.shared";
import { explainProcess, type Explanation } from "./explain.shared";
import { contextMenuTriggers, useContextMenu, type ContextMenuItem } from "./menu.client";
import { Card, useChromeStyles, type Chrome } from "./ui.client";
import { severityOf, STATUS, type VizPalette } from "./viz.shared";


/**
 * Auto-refresh pauses while a menu is open: a list that reorders under the
 * cursor is how the wrong PID gets terminated.
 */
export function ProcessesSection({
  chrome,
  hostId,
  palette,
}: {
  chrome: Chrome;
  hostId: string;
  palette: VizPalette;
}) {
  const styles = useChromeStyles(chrome);
  const list = useRpc(listProcesses);
  const kill = useRpc(killProcess);
  const explain = useRpc(explainProcess);
  const openMenu = useContextMenu();

  const [sortBy, setSortBy] = useState<"cpu" | "memory">("cpu");
  const [activePid, setActivePid] = useState<number | null>(null);
  /** Where the menu was opened, so a confirmation submenu appears in the same place. */
  const anchor = useRef({ x: 0, y: 0 });

  const processes = useQuery({
    queryKey: ["machine-status", "processes", hostId, sortBy],
    queryFn: () => list({ sortBy, limit: 8 }),
    refetchInterval: activePid === null ? 5_000 : false,
  });

  const items = processes.data?.items ?? [];
  // The bar is scaled to the heaviest process on screen, so the worst offender
  // always reaches full width and the rest are read against it.
  const peakCpu = Math.max(...items.map((item) => item.cpuPercent), 1);

  const signal = useMutation({
    mutationFn: (variables: { pid: number; signal: "TERM" | "KILL" }) => kill(variables),
    onSettled: () => void processes.refetch(),
  });

  /**
   * The panel already knows the parent chain, the elapsed time, the ports and the
   * machine's state. Those facts answer "is this a problem" on their own, so the
   * verdict is computed here rather than delegated.
   */
  const investigate = useMutation({ mutationFn: (pid: number) => explain({ pid }) });

  /**
   * A destructive action gets its own menu rather than firing on the first click.
   * Re-opening at the same anchor keeps the two-step guarantee without turning
   * the menu into a dialog.
   */
  const confirmSignal = (item: ProcessEntry, kind: "TERM" | "KILL") => {
    openMenu({
      ...anchor.current,
      title: kind === "TERM" ? `Terminate ${item.name}?` : `Force kill ${item.name}?`,
      items: [
        {
          id: "confirm",
          label: kind === "TERM" ? "Confirm — unsaved work is lost" : "Confirm — no cleanup runs",
          tone: "danger",
          onSelect: () => signal.mutate({ pid: item.pid, signal: kind }),
        },
        { id: "cancel", label: "Cancel", onSelect: () => setActivePid(null) },
      ],
    });
  };

  const menuFor = (item: ProcessEntry): ContextMenuItem[] => {
    const actions: ContextMenuItem[] = [
      {
        id: "explain",
        label: "What is this?",
        onSelect: () => investigate.mutate(item.pid),
      },
      { id: "term", label: "Terminate (SIGTERM)…", tone: "danger", onSelect: () => confirmSignal(item, "TERM") },
    ];
    if (signal.data?.pid === item.pid && signal.data.stillRunning) {
      actions.push({
        id: "kill",
        label: "Force kill (SIGKILL)…",
        tone: "danger",
        onSelect: () => confirmSignal(item, "KILL"),
      });
    }
    return actions;
  };

  const open = (item: ProcessEntry, x: number, y: number) => {
    if (item.guarded) return;
    anchor.current = { x, y };
    setActivePid(item.pid);
    signal.reset();
    investigate.reset();
    openMenu({ x, y, title: `${item.name} · PID ${item.pid}`, items: menuFor(item) });
  };

  return (
    <Card
      chrome={chrome}
      title="Top processes"
      subtitle={activePid === null ? "refreshing every 5s" : "paused"}
    >
      <View style={styles.rowWrap}>
        {(["cpu", "memory"] as const).map((option) => (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected: sortBy === option }}
            accessibilityLabel={`Sort by ${option}`}
            onPress={() => setSortBy(option)}
            style={{
              paddingVertical: 6,
              paddingHorizontal: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: sortBy === option ? chrome.theme.colors.accent : palette.borderStrong,
            }}
          >
            <Text style={sortBy === option ? styles.value : styles.muted}>
              {option === "cpu" ? "By CPU" : "By memory"}
            </Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Text style={styles.axis}>right-click a row</Text>
      </View>

      {processes.error ? (
        <Text style={styles.danger}>{(processes.error as Error).message}</Text>
      ) : null}

      {!chrome.compact ? (
        <View style={[styles.processRow, { paddingVertical: 2 }]}>
          <Text style={[styles.axis, { flex: 1 }]}>PROCESS</Text>
          <Text style={[styles.axis, { width: 64 }]}>PID</Text>
          <Text style={[styles.axis, { width: 56, textAlign: "right" }]}>CPU</Text>
          <View style={{ width: 120 }} />
          <Text style={[styles.axis, { width: 84, textAlign: "right" }]}>MEMORY</Text>
        </View>
      ) : null}

      {items.map((item) => {
        const active = item.pid === activePid;
        const severity = severityOf(item.cpuPercent, 50, 80);
        return (
          <Pressable
            key={item.pid}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, PID ${item.pid}, ${item.cpuPercent.toFixed(1)} percent CPU, ${formatBytes(item.memoryBytes)}. Opens actions.`}
            accessibilityState={{ selected: active, disabled: item.guarded }}
            disabled={item.guarded}
            // A left click opens the same menu, so the actions are reachable
            // without a right button — on a trackpad, or by keyboard focus.
            onPress={(event) => open(item, event.nativeEvent.pageX, event.nativeEvent.pageY)}
            {...contextMenuTriggers((x, y) => open(item, x, y))}
            style={({ pressed }) => [
              styles.processRow,
              {
                backgroundColor: active ? palette.border : "transparent",
                opacity: item.guarded ? 0.45 : pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text style={[styles.value, { flex: 1 }]} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={[styles.muted, { width: 64 }]} numberOfLines={1}>
              {item.guarded ? "protected" : item.pid}
            </Text>
            <Text
              style={[
                styles.value,
                { width: 56, textAlign: "right", fontWeight: "600" },
                severity === "good" ? null : { color: STATUS[severity] },
              ]}
            >
              {item.cpuPercent.toFixed(1)}%
            </Text>
            <View
              style={{
                width: chrome.compact ? 48 : 120,
                height: 5,
                borderRadius: 3,
                backgroundColor: palette.neutral,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  width: `${(item.cpuPercent / peakCpu) * 100}%`,
                  height: "100%",
                  borderRadius: 3,
                  backgroundColor: severity === "good" ? palette.series[0] : STATUS[severity],
                }}
              />
            </View>
            <Text style={[styles.value, { width: 84, textAlign: "right" }]}>
              {formatBytes(item.memoryBytes)}
            </Text>
          </Pressable>
        );
      })}

      {/* The menu is gone by the time an action finishes, so results land here. */}
      {investigate.isPending ? <Text style={styles.muted}>Gathering evidence…</Text> : null}
      {investigate.error ? (
        <Text style={styles.danger}>{(investigate.error as Error).message}</Text>
      ) : null}
      {investigate.isSuccess ? (
        <Verdict
          chrome={chrome}
          palette={palette}
          name={investigate.data.name}
          pid={investigate.data.pid}
          explanation={investigate.data.explanation}
          onDismiss={() => investigate.reset()}
        />
      ) : null}

      {signal.data ? (
        <Text style={signal.data.ok && !signal.data.stillRunning ? styles.value : styles.danger}>
          {signal.data.error
            ? signal.data.error
            : signal.data.stillRunning
              ? `PID ${signal.data.pid} ignored SIG${signal.data.signal} and is still running — right-click it again to force kill.`
              : `PID ${signal.data.pid} exited.`}
        </Text>
      ) : null}
    </Card>
  );
}

const CONCERN_LABEL: Record<Explanation["concern"], string> = {
  none: "Nothing to do",
  watch: "Worth watching",
  act: "Worth acting on",
};

/** The verdict, shown where the question was asked. */
function Verdict({
  chrome,
  palette,
  name,
  pid,
  explanation,
  onDismiss,
}: {
  chrome: Chrome;
  palette: VizPalette;
  name: string;
  pid: number;
  explanation: Explanation;
  onDismiss: () => void;
}) {
  const styles = useChromeStyles(chrome);
  const tone =
    explanation.concern === "act"
      ? STATUS.critical
      : explanation.concern === "watch"
        ? STATUS.warning
        : palette.series[2];

  return (
    <View
      style={{
        marginTop: 4,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: palette.borderStrong,
        padding: chrome.compact ? 10 : 12,
        gap: 8,
      }}
    >
      <View style={styles.row}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone }} />
          {/* The dot never carries the meaning alone. */}
          <Text style={styles.axis}>{CONCERN_LABEL[explanation.concern]}</Text>
          <Text style={styles.axis}>· PID {pid}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={onDismiss}>
          <Text style={styles.muted}>Dismiss</Text>
        </Pressable>
      </View>

      <Text style={[styles.value, { fontWeight: "600" }]} selectable>
        {explanation.headline}
      </Text>

      {explanation.findings.map((finding) => (
        <Text key={finding} style={styles.muted} selectable>
          · {finding}
        </Text>
      ))}

      {explanation.advice.length > 0 ? (
        <>
          <Text style={styles.axis}>WHAT TO DO</Text>
          {explanation.advice.map((step, index) => (
            <Text key={step} style={styles.value} selectable>
              {index + 1}. {step}
            </Text>
          ))}
        </>
      ) : null}
    </View>
  );
}
