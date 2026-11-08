import React from "react";
import { Text, View } from "react-native";
import { BALANCE_TEXT, coreBalance, type CoreKind } from "../shared/cores";
import { formatPercent } from "../shared/format";
import { severityOf, STATUS, type VizPalette } from "../shared/viz";
import { useChromeStyles, type Chrome } from "./ui";

const KIND_LABEL: Record<CoreKind, string> = { efficiency: "Efficiency", performance: "Performance" };

/**
 * One bar per core, efficiency and performance cores grouped when the hardware
 * says which is which, with the reading of the pattern in words beneath.
 */
export function CoreStrip({
  chrome,
  palette,
  perCore,
  kinds,
}: {
  chrome: Chrome;
  palette: VizPalette;
  perCore: readonly (number | null)[];
  kinds: readonly (CoreKind | null)[];
}) {
  const styles = useChromeStyles(chrome);
  if (perCore.length === 0) return <Text style={styles.muted}>No per-core reading on this machine.</Text>;

  const balance = coreBalance(perCore, kinds);
  const indexes = perCore.map((_, index) => index);
  const groups: { label: string | null; indexes: number[] }[] = balance.byKind
    ? (["efficiency", "performance"] as const).map((kind) => ({
        label: `${KIND_LABEL[kind]} · ${formatPercent(balance.byKind![kind].percent)}`,
        indexes: indexes.filter((index) => kinds[index] === kind),
      }))
    : [{ label: null, indexes }];

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 12 }}>
        {groups.map((group) => (
          <View key={group.label ?? "all"} style={{ gap: 4, flex: group.indexes.length }}>
            <View style={{ flexDirection: "row", gap: 3, height: 44, alignItems: "flex-end" }}>
              {group.indexes.map((index) => {
                const value = perCore[index];
                const severity = severityOf(value);
                return (
                  <View
                    key={index}
                    accessibilityLabel={`Core ${index + 1}${kinds[index] ? `, ${kinds[index]}` : ""}: ${formatPercent(value)}`}
                    style={{ flex: 1, height: "100%", borderRadius: 3, backgroundColor: palette.neutral, overflow: "hidden", justifyContent: "flex-end" }}
                  >
                    <View
                      style={{
                        height: `${Math.max(0, Math.min(100, value ?? 0))}%`,
                        backgroundColor: severity === "good" ? palette.series[0] : STATUS[severity],
                      }}
                    />
                  </View>
                );
              })}
            </View>
            {group.label ? <Text style={styles.axis}>{group.label}</Text> : null}
          </View>
        ))}
      </View>
      <Text style={styles.muted}>{BALANCE_TEXT[balance.verdict]}</Text>
    </View>
  );
}
