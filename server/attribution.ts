import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { attributeCpu, CpuGroup } from "../shared/attribution";
import { normalizeAgents, SYSTEM_PREFIXES } from "../shared/services-classify";
import { describeError, run, runTolerant } from "./exec";
import { ancestorsOf, cwdOf, parsePsTable, processName, PS_ARGS, type RawProcess } from "./processes";

type Output = z.output<typeof attributeCpu.output>;

/**
 * Which agent a process belongs to, decided by evidence.
 *
 * Paseo starts every agent with `PASEO_AGENT_ID` in its environment, and every
 * process the agent starts inherits it, including the ones that outlive the
 * agent's process tree (`nohup`, daemonised dev servers, helpers reparented to
 * launchd). That id, matched exactly against the daemon's agent list, beats both
 * the binary name (Paseo may start an agent through a launcher called `node`)
 * and the process tree (which loses everything that was reparented).
 */

export interface AgentRef {
  id: string;
  provider: string;
  title: string;
  cwd: string;
}

const AGENT_ID = /(?:^|\s)PASEO_AGENT_ID=([0-9A-Za-z-]+)(?=\s|$)/g;

/**
 * Reads `ps -wwE -o pid=,command=` and keeps one value per line: the agent id.
 * The rest of each environment holds whatever the user exported, secrets
 * included, so it is neither stored nor returned. The last occurrence wins
 * because the environment follows the arguments, and an argument may quote one.
 */
export function parseAgentIds(raw: string): Map<number, string> {
  const ids = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const pid = /^\s*(\d+)\s/.exec(line);
    if (!pid) continue;
    let last: string | null = null;
    for (const match of line.matchAll(AGENT_ID)) last = match[1];
    if (last) ids.set(Number(pid[1]), last);
  }
  return ids;
}

export interface OwnerInputs {
  table: readonly RawProcess[];
  /** pid → `PASEO_AGENT_ID` read from that process's own environment. */
  envIds: ReadonlyMap<number, string>;
  agents: readonly AgentRef[];
  /**
   * The id this plugin's own process inherited, if any. A daemon started from an
   * agent's terminal passes that agent's id to every plugin host, so seeing it
   * proves nothing about who started a process.
   */
  inheritedId: string | null;
  /** pid → agent id from provider-and-cwd matching, for daemons without the variable. */
  fallbackRoots?: ReadonlyMap<number, string>;
}

/**
 * pid → the agent it belongs to. A process with its own evidence belongs to that
 * agent; one without takes the owner of its nearest ancestor that has some.
 */
export function ownersByPid({ table, envIds, agents, inheritedId, fallbackRoots }: OwnerInputs): Map<number, AgentRef> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const parentOf = new Map(table.map((entry) => [entry.pid, entry.ppid]));

  const direct = (pid: number): AgentRef | null => {
    const id = envIds.get(pid);
    if (id && id !== inheritedId) {
      const agent = byId.get(id);
      if (agent) return agent;
    }
    const fallback = fallbackRoots?.get(pid);
    return fallback ? (byId.get(fallback) ?? null) : null;
  };

  const resolved = new Map<number, AgentRef | null>();
  for (const { pid } of table) {
    const path: number[] = [];
    let current = pid;
    let owner: AgentRef | null = null;
    for (;;) {
      if (resolved.has(current)) {
        owner = resolved.get(current)!;
        break;
      }
      path.push(current);
      const found = direct(current);
      if (found) {
        owner = found;
        break;
      }
      const parent = parentOf.get(current);
      // launchd and the kernel own everything; reaching them means no agent does.
      if (parent === undefined || parent <= 1 || path.includes(parent)) break;
      current = parent;
    }
    for (const entry of path) resolved.set(entry, owner);
  }

  const owners = new Map<number, AgentRef>();
  for (const [pid, owner] of resolved) if (owner) owners.set(pid, owner);
  return owners;
}

export interface AgentRoot extends AgentRef {
  pid: number;
  command: string;
}

/** Daemon children that are agents, by the id in their environment. */
export function envAgentRoots(
  daemonChildren: readonly RawProcess[],
  envIds: ReadonlyMap<number, string>,
  agents: readonly AgentRef[],
  inheritedId: string | null,
): AgentRoot[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const roots: AgentRoot[] = [];
  for (const child of daemonChildren) {
    const id = envIds.get(child.pid);
    const agent = id && id !== inheritedId ? byId.get(id) : undefined;
    if (agent) roots.push({ ...agent, pid: child.pid, command: child.command });
  }
  return roots;
}

/**
 * A provider name must match the binary as a whole word, not as a prefix.
 * `ps` on this machine contains AMPDeviceDiscoveryAgent, Campo and
 * CursorUIViewService, all of which a substring test happily reports as the
 * "amp" and "cursor" agents.
 */
export function binaryMatchesProvider(binary: string, provider: string): boolean {
  if (provider.length === 0) return false;
  if (binary === provider) return true;
  if (!binary.startsWith(provider)) return false;
  return /^[^a-z0-9]/.test(binary.slice(provider.length));
}

/**
 * Identifies which daemon children are coding agents.
 *
 * Matching on the command name alone does not work: a substring search for
 * "amp" or "cursor" hits AMPDeviceDiscoveryAgent and CursorUIViewService. The
 * reliable signal is structural — Paseo starts each agent as its own child — and
 * it is confirmed against the daemon's own agent list, so anything else under the
 * daemon (esbuild, Paseo's internal helpers, this plugin) is left out.
 */
export function matchAgentRoots(
  daemonChildren: readonly (RawProcess & { cwd: string })[],
  agents: readonly { id: string; provider: string; cwd: string; title: string }[],
  excluded: ReadonlySet<number>,
): AgentRoot[] {
  const roots: AgentRoot[] = [];
  const claimed = new Set<string>();

  for (const child of daemonChildren) {
    if (excluded.has(child.pid)) continue;
    const binary = (child.command.split("/").pop() ?? "").toLowerCase();

    const agent = agents.find(
      (candidate) =>
        !claimed.has(candidate.id) &&
        candidate.provider.length > 0 &&
        binaryMatchesProvider(binary, candidate.provider) &&
        // cwd disambiguates two agents of the same provider in different workspaces
        (candidate.cwd === "" || child.cwd === "" || candidate.cwd === child.cwd),
    );
    if (!agent) continue;

    claimed.add(agent.id);
    roots.push({
      id: agent.id,
      pid: child.pid,
      provider: agent.provider,
      title: agent.title,
      cwd: child.cwd || agent.cwd,
      command: child.command,
    });
  }
  return roots;
}

/** System locations, plus `/sbin`, where launchd lives. */
const SYSTEM_BINARIES = [...SYSTEM_PREFIXES, "/sbin/"];
const PASEO_APP = "/Applications/Paseo.app/";
const TOP = 3;

/**
 * Splits the CPU in use between each agent, Paseo itself, macOS and everything
 * else. Figures are `ps` %CPU on its own scale (100 = one core), summed.
 */
export function groupCpu(
  table: readonly RawProcess[],
  owners: ReadonlyMap<number, AgentRef>,
  { daemonPid, selfPid }: { daemonPid: number; selfPid: number },
): CpuGroup[] {
  // Paseo is the chain this plugin runs under, minus launchd, plus everything
  // under the daemon that no agent owns: plugin hosts and their commands.
  const paseo = new Set([...ancestorsOf(selfPid, table)].filter((pid) => pid > 1));
  const parentOf = new Map(table.map((entry) => [entry.pid, entry.ppid]));
  const underDaemon = (pid: number): boolean => {
    const seen = new Set<number>();
    let current: number | undefined = pid;
    while (current !== undefined && current > 1 && !seen.has(current)) {
      if (current === daemonPid) return true;
      seen.add(current);
      current = parentOf.get(current);
    }
    return false;
  };

  const groups = new Map<string, CpuGroup & { members: RawProcess[] }>();
  const add = (key: string, make: () => Omit<CpuGroup, "cpuPercent" | "processCount" | "top">, entry: RawProcess) => {
    let group = groups.get(key);
    if (!group) {
      group = { ...make(), cpuPercent: 0, processCount: 0, top: [], members: [] };
      groups.set(key, group);
    }
    group.cpuPercent += entry.cpuPercent;
    group.processCount += 1;
    group.members.push(entry);
  };

  for (const entry of table) {
    const agent = owners.get(entry.pid);
    if (agent) {
      add(
        agent.id,
        () => ({
          kind: "agent",
          id: agent.id,
          label: agent.title || `${agent.provider} agent`,
          detail: agent.provider,
        }),
        entry,
      );
    } else if (paseo.has(entry.pid) || underDaemon(entry.pid) || entry.command.startsWith(PASEO_APP)) {
      add("paseo", () => ({ kind: "paseo", id: "paseo", label: "Paseo", detail: "daemon, app and plugins" }), entry);
    } else if (SYSTEM_BINARIES.some((prefix) => entry.command.startsWith(prefix))) {
      add("system", () => ({ kind: "system", id: "system", label: "macOS", detail: null }), entry);
    } else {
      add("other", () => ({ kind: "other", id: "other", label: "Other processes", detail: null }), entry);
    }
  }

  const ORDER = { agent: 0, paseo: 1, system: 2, other: 3 } as const;
  return [...groups.values()]
    .map(({ members, ...group }) => ({
      ...group,
      top: members
        .filter((member) => member.cpuPercent > 0)
        .sort((left, right) => right.cpuPercent - left.cpuPercent)
        .slice(0, TOP)
        .map((member) => ({ pid: member.pid, name: processName(member.command), cpuPercent: member.cpuPercent })),
    }))
    .sort((left, right) => ORDER[left.kind] - ORDER[right.kind] || right.cpuPercent - left.cpuPercent);
}

/* -------------------------------------------------------------------------- */
/* Collection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads agent ids for the given processes. `ps` exits 1 when one of them has
 * gone since the table was read, and still prints the rest.
 */
export async function readAgentIds(pids: readonly number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  return parseAgentIds(await runTolerant("/bin/ps", ["-wwE", "-o", "pid=,command=", "-p", pids.join(",")], 8_000));
}

export function toAgentRefs(raw: unknown): AgentRef[] {
  return normalizeAgents(raw).map(({ id, provider, title, cwd }) => ({ id, provider, title, cwd }));
}

const PAGE_LIMIT = 200;
/** 25 pages of 200: far past any real directory, short of looping on a server that never ends. */
const MAX_PAGES = 25;

type AgentPage = { pageInfo?: { hasMore?: boolean; nextCursor?: string | null } };

/**
 * Every agent the daemon lists, page by page. A page that repeats its cursor
 * ends the walk instead of looping.
 */
export async function listAgents(paseo: Pick<PluginHandlerContext["paseo"], "agents">): Promise<AgentRef[]> {
  let page = await paseo.agents.list({ page: { limit: PAGE_LIMIT } });
  const agents = toAgentRefs(page);
  for (let count = 1; count < MAX_PAGES; count += 1) {
    const { hasMore, nextCursor } = (page as AgentPage).pageInfo ?? {};
    if (!hasMore || !nextCursor) break;
    const next = await paseo.agents.list({ page: { limit: PAGE_LIMIT, cursor: nextCursor } });
    if ((next as AgentPage).pageInfo?.nextCursor === nextCursor) break;
    agents.push(...toAgentRefs(next));
    page = next;
  }
  return agents;
}

/**
 * Provider-and-cwd matching for daemon children that carry no id, reduced to
 * the ones whose binary could be a provider at all, so `lsof` runs rarely.
 */
export function fallbackCandidates(
  children: readonly RawProcess[],
  agents: readonly AgentRef[],
  envIds: ReadonlyMap<number, string>,
  inheritedId: string | null,
): RawProcess[] {
  const providers = [...new Set(agents.map((agent) => agent.provider))];
  return children.filter((child) => {
    const id = envIds.get(child.pid);
    if (id && id !== inheritedId && agents.some((agent) => agent.id === id)) return false;
    const binary = (child.command.split("/").pop() ?? "").toLowerCase();
    return providers.some((provider) => binaryMatchesProvider(binary, provider));
  });
}

export async function attributeCpuHandler(_input: unknown, context: PluginHandlerContext): Promise<Output> {
  const notes: string[] = [];
  const table = parsePsTable(await run("/bin/ps", [...PS_ARGS], 10_000));
  const daemonPid = process.ppid;

  let agents: AgentRef[] = [];
  try {
    agents = await listAgents(context.paseo);
  } catch (error) {
    notes.push(`Agent list unavailable, so no CPU is attributed to agents: ${describeError(error)}`);
  }

  // Only busy processes matter here, plus the chains above them, where an id
  // may sit on an ancestor instead.
  const wanted = new Set<number>();
  for (const entry of table) {
    if (entry.cpuPercent <= 0 && entry.ppid !== daemonPid) continue;
    for (const pid of ancestorsOf(entry.pid, table)) if (pid > 1) wanted.add(pid);
  }
  const envIds = agents.length > 0 ? await readAgentIds([...wanted]) : new Map<number, string>();
  const inheritedId = process.env.PASEO_AGENT_ID ?? null;

  const children = table.filter((entry) => entry.ppid === daemonPid);
  const fallbackRoots = new Map<number, string>();
  const candidates = fallbackCandidates(children, agents, envIds, inheritedId);
  if (candidates.length > 0) {
    const claimed = new Set(envAgentRoots(children, envIds, agents, inheritedId).map((root) => root.id));
    const withCwd = await Promise.all(candidates.map(async (child) => ({ ...child, cwd: await cwdOf(child.pid) })));
    const unclaimed = agents.filter((agent) => !claimed.has(agent.id));
    for (const root of matchAgentRoots(withCwd, unclaimed, new Set([process.pid]))) fallbackRoots.set(root.pid, root.id);
  }

  const owners = ownersByPid({ table, envIds, agents, inheritedId, fallbackRoots });
  const groups = groupCpu(table, owners, { daemonPid, selfPid: process.pid });

  return {
    collectedAt: new Date().toISOString(),
    totalPercent: groups.reduce((sum, group) => sum + group.cpuPercent, 0),
    groups,
    notes,
  };
}
