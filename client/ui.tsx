import type { PluginTheme } from "@getpaseo/plugin";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { clampPercent } from "../shared/format";
import { paletteFor } from "../shared/viz";

/**
 * Paseo exposes six colour tokens and a compact flag. Everything in this file is
 * built from those alone: hardcoding a colour would break on half the themes,
 * and there is no `surface1`, so panels are separated by hairline borders rather
 * than by a second background.
 */
export interface Chrome {
  theme: PluginTheme;
  compact: boolean;
}

export type Tone = "accent" | "danger";

export function useChromeStyles({ theme, compact }: Chrome) {
  const palette = paletteFor(theme.colors.surface0);
  return useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: theme.colors.surface0 },
        content: { padding: compact ? 12 : 20, gap: compact ? 10 : 14, paddingBottom: 40 },
        card: {
          borderRadius: 12,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.border,
          padding: compact ? 12 : 16,
          gap: compact ? 8 : 10,
        },
        cardTitle: {
          color: theme.colors.foreground,
          fontSize: compact ? 13 : 14,
          fontWeight: "600",
          letterSpacing: 0.4,
          textTransform: "uppercase",
        },
        cardSubtitle: { color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12 },
        heading: { color: theme.colors.foreground, fontSize: compact ? 20 : 26, fontWeight: "700" },
        muted: { color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12 },
        value: { color: theme.colors.foreground, fontSize: compact ? 13 : 14 },
        valueStrong: {
          color: theme.colors.foreground,
          fontSize: compact ? 16 : 18,
          fontWeight: "600",
        },
        danger: { color: theme.colors.statusDanger, fontSize: compact ? 11 : 12 },
        axis: { color: theme.colors.foregroundMuted, fontSize: 10 },
        figure: {
          color: theme.colors.foreground,
          fontSize: compact ? 26 : 30,
          fontWeight: "700",
          letterSpacing: -0.5,
        },
        row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
        rowWrap: { flexDirection: "row", flexWrap: "wrap", gap: compact ? 8 : 12 },
        tiles: { flexDirection: "row", flexWrap: "wrap", gap: compact ? 10 : 14 },
        chip: {
          paddingVertical: 5,
          paddingHorizontal: 12,
          borderRadius: 7,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.borderStrong,
        },
        track: { height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: palette.neutral },
        // A child View carries the opacity so the bar dims without fading its label.
        trackDim: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.surface0, opacity: 0.75 },
        fill: { height: 6, borderRadius: 3 },
        button: {
          paddingVertical: compact ? 10 : 12,
          paddingHorizontal: 16,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
        },
        buttonText: { color: theme.colors.accentForeground, fontWeight: "600", fontSize: compact ? 13 : 14 },
        ghostButton: {
          paddingVertical: compact ? 10 : 12,
          paddingHorizontal: 16,
          borderRadius: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.borderStrong,
          alignItems: "center",
          justifyContent: "center",
        },
        ghostButtonText: { color: theme.colors.foreground, fontWeight: "600", fontSize: compact ? 13 : 14 },
        selectableRow: {
          borderRadius: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.border,
          padding: compact ? 10 : 12,
          gap: 4,
        },
        /** The design's two-column bands; they collapse to a stack when compact. */
        band: {
          flexDirection: compact ? "column" : "row",
          gap: compact ? 10 : 14,
          alignItems: "stretch",
        },
        divider: { height: StyleSheet.hairlineWidth, backgroundColor: palette.border },
        /** One process per line: name, pid, cpu, bar, memory — no border, so the
         *  list reads as a table rather than a stack of cards. */
        processRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 7,
          paddingHorizontal: 10,
          borderRadius: 8,
        },
      }),
    [theme, compact, palette],
  );
}

export function Card({
  chrome,
  title,
  subtitle,
  children,
}: {
  chrome: Chrome;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const styles = useChromeStyles(chrome);
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.cardTitle}>{title}</Text>
        {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
      </View>
      {children}
    </View>
  );
}

export function MetricRow({
  chrome,
  label,
  value,
}: {
  chrome: Chrome;
  label: string;
  value: string;
}) {
  const styles = useChromeStyles(chrome);
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

/** A labelled progress bar. Crosses to the danger tone once the resource is nearly spent. */
export function Gauge({
  chrome,
  label,
  valueLabel,
  percent,
  dangerAt = 85,
}: {
  chrome: Chrome;
  label: string;
  valueLabel: string;
  percent: number | null;
  dangerAt?: number;
}) {
  const styles = useChromeStyles(chrome);
  const width = clampPercent(percent);
  const tone = width >= dangerAt ? chrome.theme.colors.statusDanger : chrome.theme.colors.accent;
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.row}>
        <Text style={styles.muted}>{label}</Text>
        <Text style={styles.valueStrong}>{valueLabel}</Text>
      </View>
      <View style={styles.track}>
        <View style={styles.trackDim} />
        <View style={[styles.fill, { width: `${width}%`, backgroundColor: tone }]} />
      </View>
    </View>
  );
}

export function ActionButton({
  chrome,
  label,
  onPress,
  tone = "accent",
  variant = "solid",
  disabled = false,
  busy = false,
}: {
  chrome: Chrome;
  label: string;
  onPress: () => void;
  tone?: Tone;
  variant?: "solid" | "ghost";
  disabled?: boolean;
  busy?: boolean;
}) {
  const styles = useChromeStyles(chrome);
  const background =
    tone === "danger" ? chrome.theme.colors.statusDanger : chrome.theme.colors.accent;
  const isGhost = variant === "ghost";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        isGhost ? styles.ghostButton : [styles.button, { backgroundColor: background }],
        { opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={isGhost ? chrome.theme.colors.foreground : chrome.theme.colors.accentForeground} />
      ) : (
        <Text style={isGhost ? styles.ghostButtonText : styles.buttonText}>{label}</Text>
      )}
    </Pressable>
  );
}

/**
 * Two-step confirmation for destructive actions. The armed state expires on its
 * own so a button left armed in a background tab cannot be triggered later by a
 * stray tap. The timer is cleared on unmount.
 */
export function useArmedConfirm(timeoutMs = 6_000) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const disarm = useCallback(() => {
    clear();
    setArmed(false);
  }, [clear]);

  const arm = useCallback(() => {
    clear();
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), timeoutMs);
  }, [clear, timeoutMs]);

  useEffect(() => clear, [clear]);

  return { armed, arm, disarm };
}
