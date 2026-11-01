import { afterEach, describe, expect, it, vi } from "vitest";
import { RETRY_CAP_MS, RETRY_MS, followAgents, type DirectoryAgent } from "../client/agent-directory";

type PageInfo = { hasMore: boolean; nextCursor: string | null };
type Page = { entries: { agent: DirectoryAgent }[]; pageInfo: PageInfo };
type Handlers = { snapshot(result: Page): void; update(message: unknown): void; error?(error: unknown): void };
type ListOptions = { subscribe?: object; page: { limit: number; cursor?: string }; signal?: AbortSignal };

function fixture(options: { failObservations?: number } = {}) {
  const shown = new Map<string, DirectoryAgent>();
  const observers: Handlers[] = [];
  const pages = new Map<string, Page | Promise<Page>>();
  let failing = options.failObservations ?? 0;
  const list = vi.fn(async (request: ListOptions) => {
    if (request.subscribe) {
      if (failing > 0) {
        failing -= 1;
        throw new Error("no observation");
      }
      return { subscription: { subscribe: (next: Handlers) => { observers.push(next); } } };
    }
    const page = pages.get(request.page.cursor ?? "");
    if (!page) throw new Error("no such page");
    return page;
  });
  const stop = followAgents({ agents: { list } } as never, {
    track: (agent) => shown.set(agent.id, agent),
    hide: (id) => shown.delete(id),
    known: () => shown.keys(),
  });
  const ready = async () => {
    await vi.waitFor(() => expect(observers.length).toBeGreaterThan(0));
    return observers[0]!;
  };
  const observations = () => list.mock.calls.filter(([request]) => request.subscribe).length;
  return { shown, list, pages, stop, ready, observers, observations };
}

const entry = (id: string) => ({ agent: { id, workspaceId: "w" } });
const whole: PageInfo = { hasMore: false, nextCursor: null };
const more = (nextCursor: string): PageInfo => ({ hasMore: true, nextCursor });
const names = (shown: Map<string, DirectoryAgent>) => [...shown.keys()].sort();

afterEach(() => {
  vi.useRealTimers();
});

describe("followAgents", () => {
  it("shows the agents that already exist from the first snapshot", async () => {
    const { shown, ready } = fixture();
    (await ready()).snapshot({ entries: [entry("a"), entry("b")], pageInfo: whole });
    expect(names(shown)).toEqual(["a", "b"]);
  });

  it("catches up from the snapshot after a reconnect: new agents appear, gone ones leave", async () => {
    const { shown, ready } = fixture();
    const handlers = await ready();
    handlers.snapshot({ entries: [entry("kept"), entry("gone")], pageInfo: whole });
    handlers.snapshot({ entries: [entry("kept"), entry("created-offline")], pageInfo: whole });
    expect(names(shown)).toEqual(["created-offline", "kept"]);
  });

  it("reads a long directory to its end before it removes anyone", async () => {
    const { shown, pages, list, ready } = fixture();
    const handlers = await ready();
    handlers.snapshot({ entries: [entry("on-page-2"), entry("gone")], pageInfo: whole });
    pages.set("c2", { entries: [entry("on-page-2")], pageInfo: whole });
    handlers.snapshot({ entries: [entry("on-page-1")], pageInfo: more("c2") });
    await vi.waitFor(() => expect(names(shown)).toEqual(["on-page-1", "on-page-2"]));
    expect(list).toHaveBeenLastCalledWith({ page: { limit: 200, cursor: "c2" } });
  });

  it("removes no one when a later page cannot be read, and reads the directory again later", async () => {
    vi.useFakeTimers();
    const { shown, pages, observers } = fixture();
    await vi.advanceTimersByTimeAsync(0);
    const handlers = observers[0]!;
    handlers.snapshot({ entries: [entry("gone")], pageInfo: whole });
    handlers.snapshot({ entries: [entry("on-page-1")], pageInfo: more("c2") });
    await vi.advanceTimersByTimeAsync(0);
    expect(names(shown)).toEqual(["gone", "on-page-1"]);
    pages.set("", { entries: [entry("on-page-1")], pageInfo: more("c2") });
    pages.set("c2", { entries: [entry("on-page-2")], pageInfo: whole });
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(names(shown)).toEqual(["on-page-1", "on-page-2"]);
  });

  it("waits longer while the read keeps failing, and a snapshot cancels the wait", async () => {
    vi.useFakeTimers();
    const { list, observers } = fixture();
    await vi.advanceTimersByTimeAsync(0);
    const handlers = observers[0]!;
    const reads = () => list.mock.calls.filter(([request]) => !request.subscribe).length;
    handlers.snapshot({ entries: [], pageInfo: more("missing") });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(reads()).toBe(2);
    handlers.snapshot({ entries: [], pageInfo: whole });
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 2);
    expect(reads()).toBe(2);
  });

  it("cancels a read that waits to be tried again when it is cleaned up", async () => {
    vi.useFakeTimers();
    const { list, observers, stop } = fixture();
    await vi.advanceTimersByTimeAsync(0);
    observers[0]!.snapshot({ entries: [], pageInfo: more("missing") });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const before = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 2);
    expect(list).toHaveBeenCalledTimes(before);
  });

  it("stops at a cursor that does not move, and removes no one", async () => {
    const { shown, pages, list, ready } = fixture();
    const handlers = await ready();
    handlers.snapshot({ entries: [entry("older")], pageInfo: whole });
    pages.set("stuck", { entries: [], pageInfo: more("stuck") });
    handlers.snapshot({ entries: [entry("newer")], pageInfo: more("stuck") });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(list).toHaveBeenCalledTimes(2);
    expect(names(shown)).toEqual(["newer", "older"]);
  });

  it("lets an update made during the read win over an older page", async () => {
    const { shown, pages, ready } = fixture();
    const handlers = await ready();
    let answer!: (page: Page) => void;
    pages.set("c2", new Promise<Page>((resolve) => { answer = resolve; }));
    handlers.snapshot({ entries: [entry("a")], pageInfo: more("c2") });
    handlers.update({ type: "agent_update", payload: { kind: "remove", agentId: "removed-meanwhile" } });
    handlers.update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "created-meanwhile", workspaceId: "w" } } });
    answer({ entries: [entry("removed-meanwhile")], pageInfo: whole });
    await vi.waitFor(() => expect(names(shown)).toEqual(["a", "created-meanwhile"]));
  });

  it("drops a read when a newer snapshot arrives", async () => {
    const { shown, pages, ready } = fixture();
    const handlers = await ready();
    let answer!: (page: Page) => void;
    pages.set("old", new Promise<Page>((resolve) => { answer = resolve; }));
    handlers.snapshot({ entries: [entry("a")], pageInfo: more("old") });
    handlers.snapshot({ entries: [entry("b")], pageInfo: whole });
    answer({ entries: [entry("stale")], pageInfo: whole });
    await new Promise((resolve) => setImmediate(resolve));
    expect(names(shown)).toEqual(["b"]);
  });

  it("follows upserts and removals, and ignores other messages", async () => {
    const { shown, ready } = fixture();
    const handlers = await ready();
    handlers.update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "a", workspaceId: "w" } } });
    handlers.update({ type: "status", payload: {} });
    expect(names(shown)).toEqual(["a"]);
    handlers.update({ type: "agent_update", payload: { kind: "remove", agentId: "a" } });
    expect(shown.size).toBe(0);
  });

  it("asks for a new observation when Paseo gives one up after a reconnect", async () => {
    vi.useFakeTimers();
    const { shown, observers, observations, ready } = fixture();
    const first = await vi.waitFor(ready);
    first.error?.(new Error("the request failed"));
    expect(observations()).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(observations()).toBe(2);
    observers[1]!.snapshot({ entries: [entry("back")], pageInfo: whole });
    expect(names(shown)).toEqual(["back"]);
  });

  it("keeps trying while the observation cannot start, waiting longer each time up to the cap", async () => {
    vi.useFakeTimers();
    const { observations, observers } = fixture({ failObservations: 6 });
    await vi.advanceTimersByTimeAsync(0);
    expect(observations()).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(observations()).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(observations()).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(observations()).toBe(3);
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 4);
    expect(observations()).toBe(7);
    expect(observers).toHaveLength(1);
  });

  it("waits the shortest time again after a snapshot arrived", async () => {
    vi.useFakeTimers();
    const { observations, observers } = fixture({ failObservations: 2 });
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(observations()).toBe(3);
    observers[0]!.snapshot({ entries: [], pageInfo: whole });
    observers[0]!.error?.(new Error("the request failed"));
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(observations()).toBe(4);
  });

  it("ends the observation with its cleanup, and nothing arrives after it", async () => {
    const { shown, list, stop, ready } = fixture();
    const handlers = await ready();
    stop();
    expect(list.mock.calls[0]![0].signal?.aborted).toBe(true);
    handlers.snapshot({ entries: [entry("late")], pageInfo: whole });
    handlers.update({ type: "agent_update", payload: { kind: "upsert", agent: { id: "late", workspaceId: "w" } } });
    expect(shown.size).toBe(0);
  });

  it("cancels a retry that is waiting when it is cleaned up", async () => {
    vi.useFakeTimers();
    const { observations, stop } = fixture({ failObservations: 1 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(RETRY_CAP_MS * 2);
    expect(observations()).toBe(1);
  });
});
