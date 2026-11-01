import type { PluginClientContext } from "@getpaseo/plugin/client";

export interface DirectoryAgent {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
}

export interface DirectoryListener {
  /** An agent exists, or changed. */
  track(agent: DirectoryAgent): void;
  /** An agent is gone. */
  hide(agentId: string): void;
  /** The agents that are known at the moment. */
  known(): Iterable<string>;
}

/** The most Paseo returns in one page. */
const PAGE_LIMIT = 200;
/** How long after a failure the observation is asked for again; each failure in a row doubles it, up to the cap. */
export const RETRY_MS = 5_000;
export const RETRY_CAP_MS = 60_000;

/**
 * Follows the agent directory through one owned observation.
 *
 * Paseo 0.15 keeps a plugin installed across a dropped connection and does not run
 * its setup again, so a list read once at setup would miss everything that happened
 * meanwhile. The observation hands over the existing agents and, after each
 * reconnect, a fresh snapshot of the first page. The rest are read page by page, and
 * only a directory read to its end removes the agents that went while the app was
 * away; a page that fails starts the read again later. Paseo gives up an observation
 * whose request fails after a reconnect, so a failure asks for a new one. Returns
 * the cleanup.
 */
export function followAgents(paseo: PluginClientContext["paseo"], listener: DirectoryListener): () => void {
  const lifetime = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  // Each snapshot starts a new read, and a read still under way gives way to it.
  let reading = 0;
  // Agents an update spoke of during a read: a page read after that may be older than the update.
  const updated = new Set<string>();

  async function catchUp(first: Awaited<ReturnType<typeof paseo.agents.list>>) {
    const read = ++reading;
    updated.clear();
    const listed = new Set<string>();
    const take = (page: typeof first) => {
      for (const { agent } of page.entries) {
        listed.add(agent.id);
        if (!updated.has(agent.id)) listener.track(agent);
      }
    };
    take(first);
    let { hasMore, nextCursor } = first.pageInfo;
    while (hasMore) {
      // A directory that cannot be read to its end says nothing about the agents it did not reach, so none is removed.
      if (!nextCursor) return;
      let page: typeof first;
      try {
        page = await paseo.agents.list({ page: { limit: PAGE_LIMIT, cursor: nextCursor } });
      } catch {
        if (read === reading) readAgain();
        return;
      }
      if (read !== reading || lifetime.signal.aborted) return;
      if (page.pageInfo.nextCursor === nextCursor) return;
      take(page);
      ({ hasMore, nextCursor } = page.pageInfo);
    }
    failures = 0;
    for (const id of [...listener.known()]) {
      if (!listed.has(id) && !updated.has(id)) listener.hide(id);
    }
  }

  function later(action: () => void) {
    if (lifetime.signal.aborted) return;
    clearTimeout(retry);
    retry = setTimeout(action, Math.min(RETRY_CAP_MS, RETRY_MS * 2 ** failures));
    failures += 1;
  }

  function readAgain() {
    later(() => {
      const read = reading;
      void paseo.agents
        .list({ page: { limit: PAGE_LIMIT } })
        .then((first) => {
          if (read === reading && !lifetime.signal.aborted) void catchUp(first);
          return undefined;
        })
        .catch(() => {
          if (read === reading) readAgain();
        });
    });
  }

  function observeAgain() {
    later(observe);
  }

  function observe() {
    if (lifetime.signal.aborted) return;
    void paseo.agents
      .list({ subscribe: {}, page: { limit: PAGE_LIMIT }, signal: lifetime.signal })
      .then(({ subscription }) => {
        subscription.subscribe({
          snapshot(result) {
            if (lifetime.signal.aborted) return;
            clearTimeout(retry);
            failures = 0;
            void catchUp(result);
          },
          update(message) {
            if (lifetime.signal.aborted || message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "upsert") {
              updated.add(update.agent.id);
              listener.track(update.agent);
            } else {
              updated.add(update.agentId);
              listener.hide(update.agentId);
            }
          },
          error: observeAgain,
        });
        return undefined;
      })
      .catch(observeAgain);
  }

  observe();
  return () => {
    lifetime.abort();
    clearTimeout(retry);
  };
}
