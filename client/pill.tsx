import type {
  PluginButton,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useSyncExternalStore } from "react";
import { readMetrics } from "../shared/contracts";
import { createMachineCard } from "./pill-card";
import { pillReading, type PillReading } from "../shared/pill";
import { STATUS } from "../shared/viz";

/** Often enough to notice a runaway agent, rarely enough to cost nothing. */
const REFRESH_MS = 10_000;

/**
 * The latest reading, held once for every pill. Paseo draws the label itself, so
 * the numbers reach each pill through `update`; the icon is the plugin's own and
 * reads the severity from here.
 */
interface ReadingStore {
  get(): PillReading | null;
  set(next: PillReading): void;
  subscribe(listener: () => void): () => void;
}

function createReadingStore(): ReadingStore {
  let current: PillReading | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next) {
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The pill's icon, tinted by the worse of the two readings. While all is well it
 * keeps the colour Paseo hands it, so the pill only draws the eye when it should.
 */
function createIcon(store: ReadingStore) {
  return function MachineLoadIcon({ size, color }: PluginButtonIconProps) {
    const reading = useSyncExternalStore(store.subscribe, store.get);
    const tone = reading && reading.severity !== "good" ? STATUS[reading.severity] : color;
    return <Icon name="Activity" size={size} color={tone} />;
  };
}

interface TrackedAgent {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
}

/**
 * CPU load and memory pressure beside every agent's composer, fed by one poll.
 *
 * Paseo scopes a pill to a single agent, so this follows the agent directory: a
 * pill appears for each agent that has a workspace and goes when the agent is
 * archived or removed. The directory is seeded from `list`, because a
 * subscription reports changes rather than the agents that already exist.
 */
export function contributePills(client: PluginClientContext) {
  const store = createReadingStore();
  const icon = createIcon(store);
  const card = createMachineCard(() => client.openSurface("main"));
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  let disposed = false;
  let inFlight = false;

  function button(): PluginButton {
    const current = store.get();
    return {
      title: current?.label ?? "Machine load",
      icon,
      label: current?.text ?? "Machine",
      // A compact card rather than a jump to the tab: the question beside the
      // composer is "is it the machine", and the answer should not cost the chat.
      behavior: { kind: "popover", Content: card },
    };
  }

  async function refresh() {
    if (inFlight || disposed || pills.size === 0) return;
    inFlight = true;
    try {
      const metrics = await client.rpc(readMetrics, {});
      if (disposed) return;
      const next = pillReading(metrics.cpu.loadPercent, metrics.memory.pressurePercent);
      store.set(next);
      for (const { registration } of pills.values()) {
        registration.update({ title: next.label, label: next.text });
      }
    } catch {
      // A failed read leaves the last numbers up; the next tick tries again.
    } finally {
      inFlight = false;
    }
  }

  function show(agentId: string, workspaceId: string) {
    const existing = pills.get(agentId);
    if (existing?.workspaceId === workspaceId) return;
    existing?.registration.remove();
    pills.set(agentId, {
      workspaceId,
      registration: client.addComposerPill({ id: "machine", workspaceId, agentId, button: button() }),
    });
    if (store.get() === null) void refresh();
  }

  function hide(agentId: string) {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  }

  function track(agent: TrackedAgent) {
    if (agent.workspaceId && !agent.archivedAt) show(agent.id, agent.workspaceId);
    else hide(agent.id);
  }

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (disposed) return;
    if (update.kind === "upsert") track(update.agent);
    else hide(update.agentId);
  });

  client.paseo.agents
    .list()
    .then(({ entries }) => {
      if (!disposed) for (const entry of entries) track(entry.agent);
    })
    .catch(() => {
      // Without the seed, pills appear as each agent next reports a change.
    });

  const timer = setInterval(() => void refresh(), REFRESH_MS);

  return () => {
    disposed = true;
    clearInterval(timer);
    unsubscribe();
    for (const { registration } of pills.values()) registration.remove();
    pills.clear();
  };
}
