import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { applyCleanup, planCleanup, type CleanupTarget } from "../shared/contracts";
import { formatBytes } from "../shared/format";
import { ActionButton, Card, useArmedConfirm, useChromeStyles, type Chrome } from "./ui";
import { paletteFor } from "../shared/viz";

/**
 * Scanning walks real directories with `du`, so it never runs on a timer — only
 * when asked. The result is kept in the query cache so reopening the surface
 * shows the last scan instead of re-walking the disk.
 */
export function CleanupSection({ chrome, hostId }: { chrome: Chrome; hostId: string }) {
  const styles = useChromeStyles(chrome);
  const palette = paletteFor(chrome.theme.colors.surface0);
  const plan = useRpc(planCleanup);
  const apply = useRpc(applyCleanup);
  const confirm = useArmedConfirm();

  /** Absent entries fall back to "selected when the cache exists". */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const scan = useQuery({
    queryKey: ["machine-status", "cleanup", hostId],
    queryFn: () => plan({}),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const targets = scan.data?.targets ?? [];
  const isSelected = (target: CleanupTarget) => overrides[target.id] ?? target.exists;
  const selected = targets.filter((target) => target.exists && isSelected(target));
  const selectedBytes = selected.reduce((sum, target) => sum + target.sizeBytes, 0);

  const cleanup = useMutation({
    mutationFn: () => apply({ targetIds: selected.map((target) => target.id) }),
    onSettled: () => {
      confirm.disarm();
      setOverrides({});
      void scan.refetch();
    },
  });

  const toggle = (target: CleanupTarget) => {
    if (!target.exists) return;
    cleanup.reset();
    setOverrides((current) => ({ ...current, [target.id]: !isSelected(target) }));
  };

  return (
    <Card
      chrome={chrome}
      title="Dev caches"
      subtitle={scan.data ? formatBytes(scan.data.totalBytes) + " total" : undefined}
    >
      {scan.error ? <Text style={styles.danger}>{(scan.error as Error).message}</Text> : null}

      {!scan.data ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.muted}>
            Measures package-manager and build caches. Nothing is removed until you confirm.
          </Text>
          <ActionButton
            chrome={chrome}
            label="Scan dev caches"
            busy={scan.isFetching}
            onPress={() => void scan.refetch()}
          />
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {targets.map((target) => {
            const active = isSelected(target);
            return (
              <Pressable
                key={target.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: active, disabled: !target.exists }}
                accessibilityLabel={`${target.label}, ${formatBytes(target.sizeBytes)}`}
                disabled={!target.exists}
                onPress={() => toggle(target)}
                style={({ pressed }) => [
                  styles.selectableRow,
                  {
                    borderColor: active ? chrome.theme.colors.accent : palette.border,
                    opacity: !target.exists ? 0.45 : pressed ? 0.7 : 1,
                  },
                ]}
              >
                <View style={styles.row}>
                  <Text style={styles.value}>
                    {active && target.exists ? "◉  " : "○  "}
                    {target.label}
                  </Text>
                  <Text style={styles.valueStrong}>
                    {target.exists ? formatBytes(target.sizeBytes) : "not present"}
                  </Text>
                </View>
                <Text style={styles.muted} numberOfLines={1}>
                  {target.path}
                </Text>
                {target.exists ? <Text style={styles.muted}>{target.hint}</Text> : null}
                {target.error ? <Text style={styles.danger}>{target.error}</Text> : null}
              </Pressable>
            );
          })}

          {cleanup.data ? (
            <View style={{ gap: 4 }}>
              <Text style={styles.valueStrong}>Freed {formatBytes(cleanup.data.freedBytes)}</Text>
              {cleanup.data.results
                .filter((result) => !result.ok)
                .map((result) => (
                  <Text key={result.id} style={styles.danger}>
                    {result.label}: {result.error}
                  </Text>
                ))}
            </View>
          ) : null}

          {cleanup.error ? (
            <Text style={styles.danger}>{(cleanup.error as Error).message}</Text>
          ) : null}

          <View style={{ gap: 8 }}>
            {confirm.armed ? (
              <>
                <Text style={styles.danger}>
                  Deletes the contents of {selected.length} cache
                  {selected.length === 1 ? "" : "s"}. Each tool re-creates its own.
                </Text>
                <ActionButton
                  chrome={chrome}
                  tone="danger"
                  label={`Confirm — delete ${formatBytes(selectedBytes)}`}
                  busy={cleanup.isPending}
                  onPress={() => cleanup.mutate()}
                />
                <ActionButton chrome={chrome} variant="ghost" label="Cancel" onPress={confirm.disarm} />
              </>
            ) : (
              <>
                <ActionButton
                  chrome={chrome}
                  label={
                    selected.length === 0
                      ? "Select a cache to clean"
                      : `Clean ${formatBytes(selectedBytes)} in ${selected.length} cache${selected.length === 1 ? "" : "s"}`
                  }
                  disabled={selected.length === 0}
                  onPress={confirm.arm}
                />
                <ActionButton
                  chrome={chrome}
                  variant="ghost"
                  label="Rescan"
                  busy={scan.isFetching}
                  onPress={() => void scan.refetch()}
                />
              </>
            )}
          </View>
        </View>
      )}
    </Card>
  );
}
