import path from "node:path";
import type { z } from "zod";
import type { killProcess, listProcesses, ProcessSchema } from "../shared/contracts";
import { describeError, run, tryRun } from "./exec";

type ProcessEntry = z.output<typeof ProcessSchema>;
type ListInput = z.output<typeof listProcesses.input>;
type ListOutput = z.output<typeof listProcesses.output>;
type KillInput = z.output<typeof killProcess.input>;
type KillOutput = z.output<typeof killProcess.output>;

export interface RawProcess {
  pid: number;
  ppid: number;
  cpuPercent: number;
  memoryBytes: number;
  command: string;
  /** Cumulative CPU time across all threads, from `time=`. */
  cpuSeconds?: number;
  /** Wall-clock time since start, from `etime=`. */
  elapsedSeconds?: number;
}

/**
 * The one column set every `ps` read here uses. `comm` stays last because it
 * keeps its spaces; `time` and `etime` are what separate a process that has just
 * become busy from one that has always been busy.
 */
export const PS_ARGS = ["-Ao", "pid=,ppid=,pcpu=,rss=,time=,etime=,comm="] as const;

const CPU_TIME = String.raw`\d+:\d{2}\.\d{2}`;
const ELAPSED = String.raw`(?:\d+-)?(?:\d+:)?\d+:\d{2}`;
const ROW = new RegExp(
  String.raw`^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(?:(${CPU_TIME})\s+(${ELAPSED})\s+)?(.+?)\s*$`,
);

/**
 * Reads the table `PS_ARGS` asks for. The command column is last and keeps its
 * spaces ("Paseo Daemon", "/Applications/...app/Contents/MacOS/..."), so the
 * leading numeric columns are split off and the remainder is taken whole. The
 * older five-column form, without `time` and `etime`, still parses.
 */
export function parsePsTable(raw: string): RawProcess[] {
  const items: RawProcess[] = [];
  for (const line of raw.split("\n")) {
    const match = ROW.exec(line);
    if (!match) continue;
    const entry: RawProcess = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      memoryBytes: Number(match[4]) * 1024,
      command: match[7],
    };
    const cpuSeconds = match[5] ? parseCpuTime(match[5]) : null;
    const elapsedSeconds = match[6] ? parseElapsedSeconds(match[6]) : null;
    if (cpuSeconds !== null) entry.cpuSeconds = cpuSeconds;
    if (elapsedSeconds !== null) entry.elapsedSeconds = elapsedSeconds;
    items.push(entry);
  }
  return items;
}

/**
 * `ps -o time=` on macOS prints `MMM:SS.cc`: minutes, never hours, so launchd
 * reads `3387:08.30` after 80 days. Anything else is not a format this was shown.
 */
export function parseCpuTime(value: string): number | null {
  const match = /^(\d+):(\d{2})\.(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 100;
}

/**
 * Average CPU over the process's whole life, on the same scale as `pcpu`: 100 is
 * one core, and a process that keeps several cores busy reads above 100.
 */
export function lifetimeCpuPercent(cpuSeconds: number | null, elapsedSeconds: number | null): number | null {
  if (cpuSeconds === null || elapsedSeconds === null || elapsedSeconds <= 0) return null;
  return (cpuSeconds / elapsedSeconds) * 100;
}

/**
 * The longest a process can have been running at `cpuPercent`: its whole CPU
 * time spent at that rate. An upper bound from arithmetic, not an estimate, so a
 * busy process three days old that has used four hours of CPU cannot have been
 * pinned for more than four hours.
 */
export function burstCeilingSeconds(cpuSeconds: number | null, cpuPercent: number): number | null {
  if (cpuSeconds === null || !(cpuPercent > 0)) return null;
  return cpuSeconds / (cpuPercent / 100);
}

/**
 * Walks the parent chain from `pid` upwards, including `pid` itself. The visited
 * set doubles as cycle protection: a reparented process can otherwise produce a
 * loop in a snapshot taken while the table was changing.
 */
export function ancestorsOf(pid: number, table: readonly RawProcess[]): Set<number> {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const chain = new Set<number>();
  let current = byPid.get(pid);
  while (current && !chain.has(current.pid)) {
    chain.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return chain;
}

/**
 * PIDs this plugin must never signal. The plugin runs as a child of the Paseo
 * daemon, so its own ancestor chain is exactly the set of processes whose death
 * would take Paseo — and this plugin — down with it.
 */
export function guardedPids(table: readonly RawProcess[], selfPid: number): Set<number> {
  const guarded = ancestorsOf(selfPid, table);
  guarded.add(0);
  guarded.add(1);
  return guarded;
}

/**
 * `ps -o etime=` prints elapsed time as `MM:SS`, `HH:MM:SS` or `DD-HH:MM:SS`.
 * The distinction decides whether a busy process is a passing scan or something
 * that has been pinned at full CPU for a day.
 */
export function parseElapsedSeconds(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/** A process's working directory, or "" when lsof cannot say. */
export async function cwdOf(pid: number): Promise<string> {
  const raw = await tryRun("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], 3_000);
  const line = raw?.split("\n").find((entry) => entry.startsWith("n"));
  return line ? line.slice(1) : "";
}

export function processName(command: string): string {
  const base = path.basename(command);
  return base.length > 0 ? base : command;
}

export function toEntries(table: readonly RawProcess[], guarded: ReadonlySet<number>): ProcessEntry[] {
  return table.map((entry) => ({
    pid: entry.pid,
    ppid: entry.ppid,
    cpuPercent: entry.cpuPercent,
    memoryBytes: entry.memoryBytes,
    command: entry.command,
    name: processName(entry.command),
    guarded: guarded.has(entry.pid),
    elapsedSeconds: entry.elapsedSeconds ?? null,
    lifetimeCpuPercent: lifetimeCpuPercent(entry.cpuSeconds ?? null, entry.elapsedSeconds ?? null),
  }));
}

export function sortEntries(entries: ProcessEntry[], sortBy: "cpu" | "memory"): ProcessEntry[] {
  return [...entries].sort((left, right) =>
    sortBy === "cpu"
      ? right.cpuPercent - left.cpuPercent
      : right.memoryBytes - left.memoryBytes,
  );
}

async function readTable(): Promise<RawProcess[]> {
  return parsePsTable(await run("/bin/ps", [...PS_ARGS], 10_000));
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function listProcessesHandler({ sortBy, limit }: ListInput): Promise<ListOutput> {
  const table = await readTable();
  const entries = toEntries(table, guardedPids(table, process.pid));
  return {
    collectedAt: new Date().toISOString(),
    items: sortEntries(entries, sortBy).slice(0, limit),
  };
}

export async function killProcessHandler({ pid, signal }: KillInput): Promise<KillOutput> {
  // The guard is recomputed from a fresh table on every call. The client's view
  // may be stale, and a PID it believes is safe may have been reused since.
  const table = await readTable();
  const guarded = guardedPids(table, process.pid);
  const target = table.find((entry) => entry.pid === pid);

  const refuse = (error: string): KillOutput => ({
    ok: false,
    pid,
    signal,
    stillRunning: target !== undefined,
    error,
  });

  if (guarded.has(pid)) {
    return refuse("refused: this process is Paseo itself or one of its parents");
  }
  if (!target) {
    return refuse("no such process");
  }

  try {
    process.kill(pid, signal === "KILL" ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    console.error(`[machine-status] failed to signal ${pid}`, error);
    return refuse(describeError(error));
  }

  // SIGTERM is a request. Report honestly whether the process actually went away.
  await wait(400);
  return { ok: true, pid, signal, stillRunning: isAlive(pid), error: null };
}
