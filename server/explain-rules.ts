import type { Explanation } from "../shared/explain";
import { formatDuration } from "../shared/format";

/**
 * Turns gathered evidence into a verdict.
 *
 * Runtime-neutral and pure: every rule here is a statement about evidence the
 * panel already measured, so all of it is testable without a machine. Nothing in
 * this file guesses from a name alone — the name only ever adds description to a
 * conclusion that structure and timing already reached.
 */

export interface ProcessEvidence {
  name: string;
  pid: number;
  command: string;
  cpuPercent: number;
  memoryBytes: number;
  elapsedSeconds: number | null;
  elapsed: string | null;
  /** Cumulative CPU time across its threads; null when ps did not report it. */
  cpuSeconds: number | null;
  cwd: string | null;
  parents: { pid: number; name: string }[];
  children: { pid: number; name: string; cpuPercent: number }[];
  ports: { port: number; protocol: string; scope: string }[];
  isAppleSystemBinary: boolean;
  /**
   * The agent this process belongs to by the id in its environment, and whether
   * it still sits under that agent's process tree. Null when no agent owns it.
   */
  agent?: { title: string; provider: string; inTree: boolean } | null;
  machine: {
    cores: number;
    /** Utilisation across all cores, 0–100; null when it could not be measured. */
    usagePercent: number | null;
    pressurePercent: number | null;
    swapUsedBytes: number;
    swapTotalBytes: number;
  };
}

const GB = 1024 ** 3;
const MB = 1024 * 1024;

const size = (bytes: number): string =>
  bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;

/** Documented behaviour of macOS components people actually see at the top of a CPU list. */
const KNOWN: Record<string, { what: string; trigger?: string }> = {
  mds_stores: { what: "Spotlight's index store", trigger: "indexing after a lot of files changed" },
  mds: { what: "the Spotlight metadata server", trigger: "indexing work" },
  mdworker_shared: { what: "a Spotlight indexing worker", trigger: "indexing work" },
  mdsync: { what: "a Spotlight index sync worker", trigger: "indexing work" },
  kernel_task: { what: "the kernel's own task, which also absorbs CPU deliberately to cool the machine" },
  WindowServer: { what: "the compositor every window on screen draws through" },
  loginwindow: { what: "the manager of your login session" },
  backupd: { what: "Time Machine", trigger: "a scheduled or manual backup" },
  photoanalysisd: { what: "Photos' library analysis", trigger: "new photos to scan for faces and scenes" },
  bird: { what: "iCloud Drive's file sync" },
  cloudd: { what: "iCloud sync" },
  syspolicyd: { what: "Gatekeeper's policy service", trigger: "first launch of a newly downloaded app" },
  trustd: { what: "certificate validation" },
  coreaudiod: { what: "the system audio server" },
  XprotectService: { what: "XProtect's scanning service", trigger: "a scheduled malware check" },
  "com.apple.Virtualization.VirtualMachine": { what: "a virtual machine, usually the one Docker runs Linux in" },
};

const DEV_RUNTIMES = new Set([
  "node", "bun", "deno", "esbuild", "vite", "next-server", "turbo", "tsx", "webpack",
  "python", "python3", "ruby", "java", "go", "cargo", "php",
]);

/** Recognises the per-family remediator binaries without pretending to know each family. */
export function describeKnown(name: string): { what: string; trigger?: string } | null {
  const remediator = /^XProtectRemediator(.+)$/.exec(name);
  if (remediator) {
    return {
      what: `XProtect Remediator, Apple's built-in malware remediation, running its ${remediator[1]} check`,
      trigger: "a scheduled scan, or one queued after a definition update",
    };
  }
  return KNOWN[name] ?? null;
}

function kindOf(evidence: ProcessEvidence): Explanation["kind"] {
  // Structural first: anything under the Paseo daemon was started by an agent,
  // whatever it happens to be called.
  if (evidence.agent || evidence.parents.some((parent) => parent.name === "Paseo Daemon")) return "agent-spawned";
  if (evidence.isAppleSystemBinary) return "apple-system";
  if (/^com\.docker/.test(evidence.name)) return "container";
  if (DEV_RUNTIMES.has(evidence.name) || evidence.ports.some((port) => port.scope === "local")) {
    return "dev-runtime";
  }
  if (evidence.command.startsWith("/Applications/")) return "user-app";
  return "unknown";
}

/** Same arithmetic as server/processes, kept here so the rules stay runtime-neutral. */
function lifetimeOf(evidence: ProcessEvidence): number | null {
  const { cpuSeconds, elapsedSeconds } = evidence;
  if (cpuSeconds === null || elapsedSeconds === null || elapsedSeconds <= 0) return null;
  return (cpuSeconds / elapsedSeconds) * 100;
}

/**
 * Below a quarter of the current rate, most of the process's life was spent
 * near idle: whatever it is doing now started recently. Above it, the current
 * rate is roughly how it always runs.
 */
const BURST_RATIO = 0.25;

function stateOf(evidence: ProcessEvidence): Explanation["state"] {
  const young = evidence.elapsedSeconds !== null && evidence.elapsedSeconds < 180;
  if (young && evidence.cpuPercent > 40) return "just-started";
  if (evidence.cpuPercent > 50 && !young) {
    // The snapshot says busy; only the lifetime says for how long. Uptime alone
    // would call a three-day-old Finder that woke an hour ago "three days of load".
    const lifetime = lifetimeOf(evidence);
    if (lifetime !== null && lifetime < evidence.cpuPercent * BURST_RATIO) return "recent-burst";
    return "sustained-load";
  }
  if (evidence.memoryBytes > GB && evidence.cpuPercent < 5) return "memory-heavy";
  return "steady";
}

export function classify(evidence: ProcessEvidence): Explanation {
  const kind = kindOf(evidence);
  const state = stateOf(evidence);
  const known = describeKnown(evidence.name);
  const findings: string[] = [];
  const advice: string[] = [];

  if (known) {
    findings.push(`${evidence.name} is ${known.what}.${known.trigger ? ` It runs on ${known.trigger}.` : ""}`);
  } else if (kind === "apple-system") {
    findings.push(`It ships with macOS — the binary lives under a system path — but this panel has no description for it.`);
  }

  if (evidence.elapsed) {
    findings.push(
      state === "just-started"
        ? `It started ${evidence.elapsed} ago, so this burst is it starting up or working through a task, not a process that has hung.`
        : `It has been running for ${evidence.elapsed}.`,
    );
  }

  if (evidence.parents.length > 0) {
    findings.push(`It was started by ${evidence.parents[0].name}.`);
  }
  const agent = evidence.agent;
  if (agent) {
    const name = agent.title ? `"${agent.title}" (${agent.provider})` : `a ${agent.provider} agent`;
    findings.push(
      agent.inTree
        ? `It belongs to the agent ${name}.`
        : `It belongs to the agent ${name} but has left that agent's process tree, so ending the agent will not stop it.`,
    );
  }
  if (evidence.children.length > 0) {
    findings.push(
      `It has ${evidence.children.length} child process${evidence.children.length === 1 ? "" : "es"}, so quitting it takes them too.`,
    );
  }
  if (evidence.ports.length > 0) {
    findings.push(`It is serving ${evidence.ports.map((port) => `:${port.port}`).join(", ")}.`);
  }

  findings.push(`Right now: ${evidence.cpuPercent.toFixed(1)}% CPU and ${size(evidence.memoryBytes)} of memory.`);

  const lifetime = lifetimeOf(evidence);
  if (lifetime !== null && state === "recent-burst" && evidence.cpuSeconds !== null) {
    const ceiling = evidence.cpuSeconds / (evidence.cpuPercent / 100);
    findings.push(
      `Over its whole life it averaged ${lifetime.toFixed(0)}% CPU. All the CPU time it has used, spent at today's rate, comes to at most ${formatDuration(ceiling)}, so it cannot have been this busy for longer than that.`,
    );
  } else if (lifetime !== null && state === "sustained-load") {
    findings.push(`It has averaged ${lifetime.toFixed(0)}% over its whole life, so this is how it runs, not a spike.`);
  }

  let headline: string;
  let concern: Explanation["concern"] = "none";

  if (state === "just-started" && kind === "apple-system") {
    headline = `${evidence.name} is doing scheduled system work and will finish on its own.`;
    advice.push("Wait. It is seconds old, and killing it only makes macOS start it again later.");
  } else if (state === "just-started") {
    headline = `${evidence.name} has only just started — this is startup work, not a stuck process.`;
    advice.push("Give it a minute and look again before doing anything.");
  } else if (state === "recent-burst") {
    headline = `${evidence.name} became busy recently; for most of its life it was close to idle.`;
    concern = "watch";
    advice.push("Look again in a few minutes before acting: a burst that ends on its own needs nothing.");
    if (kind === "apple-system") {
      advice.push(
        known?.trigger
          ? `If it stays busy, look for what triggered it — usually ${known.trigger}.`
          : "If it stays busy, look for what triggered it; system components work when something asked them to.",
      );
    } else if (kind === "agent-spawned") {
      advice.push("It belongs to one of your coding agents, so the burst is likely that agent's current task.");
    } else {
      advice.push("If it stays busy, quit it the normal way; terminate it from this list only if that does not work.");
    }
  } else if (state === "sustained-load" && kind === "apple-system") {
    headline = `${evidence.name} has been busy for a while; it is a macOS component, not something to kill.`;
    concern = "watch";
    advice.push(
      known?.trigger
        ? `Look for what triggered it — usually ${known.trigger}.`
        : "Look for what triggered it; system components work when something asked them to.",
      "If it is Spotlight, excluding large build directories from indexing stops the recurrence.",
    );
  } else if (state === "sustained-load") {
    headline = `${evidence.name} has held ${evidence.cpuPercent.toFixed(0)}% CPU well past startup.`;
    concern = evidence.cpuPercent > 80 ? "act" : "watch";
    if (kind === "agent-spawned") {
      advice.push(
        agent && !agent.inTree
          ? "It outlived its place under the agent, so stop it here rather than by closing the agent."
          : "It belongs to one of your coding agents — closing that session releases it.",
      );
    }
    if (evidence.ports.length > 0) {
      advice.push(`It is serving ${evidence.ports.map((port) => `:${port.port}`).join(", ")}; stop that dev server if you are not using it.`);
    }
    advice.push("Quit it the normal way first; terminate it from this list only if that does not work.");
  } else if (state === "memory-heavy") {
    headline = `${evidence.name} is idle but holding ${size(evidence.memoryBytes)}.`;
    concern = evidence.memoryBytes > 2 * GB ? "watch" : "none";
    advice.push(`Quitting it frees ${size(evidence.memoryBytes)}.`);
    if (kind === "container") advice.push("Stopping Docker releases the whole VM, not just one container.");
  } else {
    headline = `${evidence.name} is behaving normally.`;
    advice.push("Nothing to do.");
  }

  // Machine-level context changes what the advice is worth.
  const swapPercent =
    evidence.machine.swapTotalBytes > 0
      ? (evidence.machine.swapUsedBytes / evidence.machine.swapTotalBytes) * 100
      : 0;
  if (swapPercent > 50 && state !== "just-started") {
    findings.push(
      `The machine is swapping (${size(evidence.machine.swapUsedBytes)} in use), so memory is the tighter constraint right now, not CPU.`,
    );
  }
  const usage = evidence.machine.usagePercent;
  if (usage !== null && usage < 60 && state === "sustained-load") {
    findings.push(
      `The machine overall is not saturated (${usage.toFixed(0)}% of ${evidence.machine.cores} cores busy), so this one process is the outlier rather than a general overload.`,
    );
  }

  return { headline, kind, state, concern, findings, advice };
}
