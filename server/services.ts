import os from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import { describeError, run, tryRun } from "./exec";
import { ancestorsOf, parsePsTable, type RawProcess } from "./processes";
import {
  classifyRelevance,
  friendlyName,
  httpUrlFor,
  normalizeAgents,
  parseLsofAddress,
  parseNetstatAddress,
  portKey,
  scopeOf,
} from "../shared/services-classify";
import type { PortRow, ServiceRow, readServices } from "../shared/services";

type Output = z.output<typeof readServices.output>;

/* -------------------------------------------------------------------------- */
/* Parsers                                                                      */
/* -------------------------------------------------------------------------- */

export interface Listener {
  protocol: "tcp" | "udp";
  address: string;
  port: number;
}

/**
 * netstat sees every listener on the machine, including other users'. lsof sees
 * only what this user may inspect. netstat therefore defines the list and lsof
 * fills in ownership, so a root-owned port is reported as unattributable rather
 * than omitted.
 */
export function parseNetstatListeners(raw: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^(tcp|udp)\S*\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s*(\S*)\s*$/);
    if (!match) continue;
    const [, protocol, local, foreign, state] = match;
    if (protocol === "tcp" && state !== "LISTEN") continue;
    if (protocol === "udp" && foreign !== "*.*") continue;
    const parsed = parseNetstatAddress(local);
    if (!parsed) continue;
    listeners.push({ protocol: protocol as "tcp" | "udp", ...parsed });
  }
  return listeners;
}

export interface LsofSocket extends Listener {
  pid: number;
  command: string;
}

/**
 * Reads `lsof -F` field output. Fields arrive as a stream: `p` opens a process,
 * `c` names it, and every following `n` is one socket belonging to it.
 * `+c 0` is required, or commands are truncated to nine characters.
 */
export function parseLsofSockets(raw: string, protocol: "tcp" | "udp"): LsofSocket[] {
  const sockets: LsofSocket[] = [];
  let pid: number | null = null;
  let command = "";

  for (const line of raw.split("\n")) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      command = "";
    } else if (tag === "c") {
      command = value;
    } else if (tag === "n" && pid !== null) {
      const parsed = parseLsofAddress(value);
      if (parsed) sockets.push({ protocol, pid, command, ...parsed });
    }
  }
  return sockets;
}

export interface DockerContainer {
  name: string;
  image: string;
  ports: number[];
}

export function parseDockerPs(raw: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const line of raw.split("\n")) {
    const [name, image, ports] = line.split("\t");
    if (!name || !image) continue;
    const published = new Set<number>();
    // "0.0.0.0:5653->5432/tcp, [::]:5653->5432/tcp" — only the published side matters.
    for (const match of (ports ?? "").matchAll(/:(\d+)->/g)) published.add(Number(match[1]));
    containers.push({ name, image, ports: [...published].sort((a, b) => a - b) });
  }
  return containers;
}

/* -------------------------------------------------------------------------- */
/* Process-tree attribution                                                     */
/* -------------------------------------------------------------------------- */

/** Every process below `pid`, excluding `pid` itself. */
export function descendantsOf(pid: number, table: readonly RawProcess[]): RawProcess[] {
  const children = new Map<number, RawProcess[]>();
  for (const entry of table) {
    const bucket = children.get(entry.ppid);
    if (bucket) bucket.push(entry);
    else children.set(entry.ppid, [entry]);
  }

  const found: RawProcess[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
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

export interface AgentRoot {
  pid: number;
  provider: string;
  title: string;
  cwd: string;
  command: string;
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
      pid: child.pid,
      provider: agent.provider,
      title: agent.title,
      cwd: child.cwd || agent.cwd,
      command: child.command,
    });
  }
  return roots;
}

const SCOPE_WIDTH = { public: 3, lan: 2, local: 1 } as const;

/**
 * One process bound to one port on both IPv4 and IPv6 is one service, and
 * `kubectl port-forward` produces exactly that. Rows are collapsed per process,
 * keeping the widest bind, because that is the one that decides reachability.
 * Sockets with no visible owner stay separate: without a PID there is no evidence
 * they are the same thing.
 */
export function collapseDuplicateBinds<T extends { protocol: string; port: number; pid: number | null; address: string; scope: "public" | "lan" | "local" }>(
  rows: readonly T[],
): T[] {
  const widest = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.protocol}:${row.port}:${row.pid ?? `@${row.address}`}`;
    const current = widest.get(key);
    if (!current) {
      widest.set(key, row);
      continue;
    }
    const better =
      SCOPE_WIDTH[row.scope] > SCOPE_WIDTH[current.scope] ||
      (SCOPE_WIDTH[row.scope] === SCOPE_WIDTH[current.scope] &&
        !row.address.includes(":") &&
        current.address.includes(":"));
    if (better) widest.set(key, row);
  }
  return [...widest.values()];
}

/* -------------------------------------------------------------------------- */
/* Collection                                                                   */
/* -------------------------------------------------------------------------- */

async function cwdOf(pid: number): Promise<string> {
  const raw = await tryRun("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], 3_000);
  const line = raw?.split("\n").find((entry) => entry.startsWith("n"));
  return line ? line.slice(1) : "";
}

export async function readServicesHandler(
  _input: unknown,
  context: PluginHandlerContext,
): Promise<Output> {
  if (process.platform !== "darwin") {
    throw new Error(
      `machine-status inspects ports through macOS tools; this daemon runs on ${process.platform}.`,
    );
  }

  const notes: string[] = [];

  const [netstatTcp, netstatUdp, lsofTcp, lsofUdp, psRaw, dockerRaw] = await Promise.all([
    tryRun("/usr/sbin/netstat", ["-an", "-p", "tcp"], 8_000),
    tryRun("/usr/sbin/netstat", ["-an", "-p", "udp"], 8_000),
    tryRun("/usr/sbin/lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "+c", "0", "-Fpcn"], 8_000),
    tryRun("/usr/sbin/lsof", ["-iUDP", "-P", "-n", "+c", "0", "-Fpcn"], 8_000),
    run("/bin/ps", ["-Ao", "pid=,ppid=,pcpu=,rss=,comm="], 10_000),
    tryRun("/usr/local/bin/docker", ["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}"], 4_000),
  ]);

  const table = parsePsTable(psRaw);
  // lsof's command column is a bare name; `ps` has the full path, and the path is
  // what separates /System/Library/... from ~/.venv/bin/python.
  const commandByPid = new Map(table.map((entry) => [entry.pid, entry.command]));
  const home = os.homedir();
  const sockets = [
    ...parseLsofSockets(lsofTcp ?? "", "tcp"),
    ...parseLsofSockets(lsofUdp ?? "", "udp"),
  ];
  const byKey = new Map(sockets.map((socket) => [portKey(socket.protocol, socket.address, socket.port), socket]));

  // --- agent roots -----------------------------------------------------------
  const daemonPid = process.ppid;
  const ownChain = ancestorsOf(process.pid, table);

  let agents: ReturnType<typeof normalizeAgents> = [];
  try {
    agents = normalizeAgents(await context.paseo.agents.list());
  } catch (error) {
    notes.push(`Agent list unavailable, so ports are not attributed to agents: ${describeError(error)}`);
  }

  const children = table.filter((entry) => entry.ppid === daemonPid);
  const withCwd = await Promise.all(
    children.map(async (child) => ({ ...child, cwd: await cwdOf(child.pid) })),
  );
  const roots = matchAgentRoots(withCwd, agents, ownChain);

  /** pid -> the agent it ultimately belongs to. */
  const ownerByPid = new Map<number, AgentRoot>();
  const childrenByRoot = new Map<number, RawProcess[]>();
  for (const root of roots) {
    ownerByPid.set(root.pid, root);
    const descendants = descendantsOf(root.pid, table);
    childrenByRoot.set(root.pid, descendants);
    for (const descendant of descendants) ownerByPid.set(descendant.pid, root);
  }

  const containers = parseDockerPs(dockerRaw ?? "");
  const dockerByPort = new Map<number, DockerContainer>();
  for (const container of containers) {
    for (const port of container.ports) dockerByPort.set(port, container);
  }

  // --- ports -----------------------------------------------------------------
  const listeners = [
    ...parseNetstatListeners(netstatTcp ?? ""),
    ...parseNetstatListeners(netstatUdp ?? ""),
  ];
  const seen = new Set<string>();
  const ports: PortRow[] = [];
  let hidden = 0;

  for (const listener of listeners) {
    const key = portKey(listener.protocol, listener.address, listener.port);
    if (seen.has(key)) continue;
    seen.add(key);

    const socket = byKey.get(key) ?? null;
    const scope = scopeOf(listener.address);
    const owner = socket ? ("you" as const) : ("other" as const);
    if (!socket) hidden += 1;

    const agent = socket ? ownerByPid.get(socket.pid) : undefined;
    const container = dockerByPort.get(listener.port);

    const attribution = agent
      ? {
          kind: (agent.pid === socket?.pid ? "agent" : "agent-child") as "agent" | "agent-child",
          label: agent.title || agent.provider,
          detail:
            agent.pid === socket?.pid
              ? `${agent.provider} agent`
              : `started by the ${agent.provider} agent in ${path.basename(agent.cwd) || agent.cwd}`,
        }
      : container
        ? { kind: "docker" as const, label: container.name, detail: container.image }
        : socket
          ? { kind: "process" as const, label: friendlyName(socket.command), detail: socket.command }
          : null;

    const resolvedCommand =
      (socket ? commandByPid.get(socket.pid) : undefined) ?? socket?.command ?? "";

    ports.push({
      id: key,
      port: listener.port,
      protocol: listener.protocol,
      address: listener.address,
      scope,
      pid: socket?.pid ?? null,
      command: socket?.command ?? null,
      owner,
      relevance: classifyRelevance({
        kind: attribution?.kind ?? null,
        command: resolvedCommand,
        owner,
        home,
      }),
      attribution,
      url: httpUrlFor({ protocol: listener.protocol, scope, port: listener.port }),
    });
  }
  const collapsed = collapseDuplicateBinds(ports).sort((left, right) => left.port - right.port);

  if (hidden > 0) {
    notes.push(
      `${hidden} listening socket${hidden === 1 ? "" : "s"} belong to another user; run with elevated rights to attribute them.`,
    );
  }
  if (dockerRaw === null) notes.push("Docker was not reachable, so containers are not listed.");

  // --- services --------------------------------------------------------------
  const portsByPid = new Map<number, number[]>();
  for (const row of collapsed) {
    if (row.pid === null) continue;
    portsByPid.set(row.pid, [...(portsByPid.get(row.pid) ?? []), row.port]);
  }

  const services: ServiceRow[] = [];
  for (const root of roots) {
    services.push({
      id: `agent-${root.pid}`,
      name: root.title || `${root.provider} agent`,
      subtitle: `${root.provider} · ${path.basename(root.cwd) || root.cwd}`,
      ports: portsByPid.get(root.pid) ?? [],
      status: "running",
      source: "agent",
      relevance: "dev",
      pid: root.pid,
    });
    for (const child of childrenByRoot.get(root.pid) ?? []) {
      services.push({
        id: `agent-child-${child.pid}`,
        name: friendlyName(child.command),
        subtitle: `background process of the ${root.provider} agent`,
        ports: portsByPid.get(child.pid) ?? [],
        status: "running",
        source: "agent-child",
        relevance: "dev",
        pid: child.pid,
      });
    }
  }
  for (const container of containers) {
    services.push({
      id: `docker-${container.name}`,
      name: container.name,
      subtitle: container.image,
      ports: container.ports,
      status: "running",
      source: "docker",
      relevance: "dev",
      pid: null,
    });
  }
  for (const [pid, list] of portsByPid) {
    if (ownerByPid.has(pid)) continue;
    const socket = sockets.find((entry) => entry.pid === pid);
    if (!socket) continue;
    const command = commandByPid.get(pid) ?? socket.command;
    services.push({
      id: `listener-${pid}`,
      name: friendlyName(command),
      subtitle: `PID ${pid}`,
      ports: [...new Set(list)].sort((a, b) => a - b),
      status: "running",
      source: "listener",
      relevance: classifyRelevance({ kind: "process", command, owner: "you", home }),
      pid,
    });
  }

  return { collectedAt: new Date().toISOString(), ports: collapsed, services, notes };
}
