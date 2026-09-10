/**
 * Runtime-neutral classification for ports and services.
 *
 * This module deliberately imports nothing from `@getpaseo/plugin`: the same
 * rules are used by the Paseo plugin and by the standalone perf-agent, and the
 * agent has no Paseo runtime to load `defineRpc` from.
 */


const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD = new Set(["*", "0.0.0.0", "::", "[::]"]);

/**
 * A wildcard bind is reachable from the network; a loopback bind is not. The
 * distinction is the whole point of the list, so it is computed from the address
 * rather than guessed from the port number.
 */
export function scopeOf(address: string): "public" | "lan" | "local" {
  const value = address.replace(/^\[|\]$/g, "");
  if (WILDCARD.has(value)) return "public";
  if (LOOPBACK.has(value)) return "local";
  return "lan";
}

/** netstat writes `127.0.0.1.49165`, `*.3620`, `::1.15432` — the port is after the last dot. */
export function parseNetstatAddress(field: string): { address: string; port: number } | null {
  const index = field.lastIndexOf(".");
  if (index <= 0) return null;
  const port = Number(field.slice(index + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { address: field.slice(0, index), port };
}

/** lsof writes `*:49258`, `127.0.0.1:15432`, `[::1]:15432` — the port is after the last colon. */
export function parseLsofAddress(name: string): { address: string; port: number } | null {
  if (name.includes("->")) return null; // an established connection, not a bound socket
  const index = name.lastIndexOf(":");
  if (index <= 0) return null;
  const port = Number(name.slice(index + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { address: name.slice(0, index).replace(/^\[|\]$/g, ""), port };
}

export function portKey(protocol: string, address: string, port: number): string {
  return `${protocol}:${address.replace(/^\[|\]$/g, "")}:${port}`;
}

/**
 * `ps` reports commands as a full path, a bare name, or a name with a version
 * suffix (`next-server (v16.3.1)`). All three have to reduce to the same token.
 */
export function executableName(command: string): string {
  const withoutVersion = command.replace(/\s*\(.*\)\s*$/, "").trim();
  return withoutVersion.includes("/")
    ? (withoutVersion.split("/").pop() ?? withoutVersion)
    : withoutVersion;
}

/** Paths macOS reserves for itself. Nothing under these is development work. */
const SYSTEM_PREFIXES = [
  "/System/",
  "/usr/libexec/",
  "/usr/sbin/",
  "/Library/Apple/",
  "/Library/PrivilegedHelperTools/",
];

/** Runtimes and services a developer actually starts. */
const DEV_RUNTIMES = new Set([
  "node", "bun", "deno", "npm", "npx", "pnpm", "yarn", "tsx", "ts-node", "vite",
  "next-server", "next", "esbuild", "webpack", "turbo", "nodemon",
  "python", "python3", "uvicorn", "gunicorn", "flask", "django-admin",
  "ruby", "rails", "puma", "php", "php-fpm", "java", "gradle",
  "go", "air", "cargo", "rustc", "dotnet", "elixir", "beam.smp",
  "postgres", "postmaster", "mysqld", "mongod", "redis-server", "valkey-server",
  "kubectl", "minikube", "ngrok", "cloudflared", "caddy", "nginx",
  "opencode", "claude", "codex", "kimi", "gemini", "aider", "amp", "goose",
  "Paseo Daemon",
]);

export interface RelevanceInput {
  kind: "agent" | "agent-child" | "docker" | "process" | null;
  /** Full path when `ps` knows it; the bare command otherwise. */
  command: string;
  owner: "you" | "other";
  home: string;
}

/**
 * Development ports are identified by evidence, never by port number. Ranges do
 * not separate them: 5000 and 7000 here are AirPlay, while 49165 is a coding
 * agent.
 */
export function classifyRelevance({ kind, command, owner, home }: RelevanceInput): "dev" | "system" {
  if (kind === "agent" || kind === "agent-child" || kind === "docker") return "dev";
  if (owner === "other") return "system";
  if (SYSTEM_PREFIXES.some((prefix) => command.startsWith(prefix))) return "system";

  const name = executableName(command);
  if (DEV_RUNTIMES.has(name)) return "dev";
  if (/^com\.docker/.test(name)) return "dev";

  // Anything the user installed or built under their own home, except the
  // Library tree, which is where macOS keeps per-user daemons.
  if (home.length > 0 && command.startsWith(`${home}/`) && !command.startsWith(`${home}/Library/`)) {
    return "dev";
  }
  return "system";
}

/**
 * Known binaries get a readable name. Everything else keeps the command it
 * actually runs — inventing a plausible service name would make the list read as
 * knowledge it does not have.
 */
const NAMES: readonly (readonly [RegExp, string])[] = [
  [/^vite$|[/\s]vite$/i, "Vite dev server"],
  [/next-server|^next$/i, "Next.js"],
  [/^postgres$|^postmaster$/i, "PostgreSQL"],
  [/^redis-server$/i, "Redis"],
  [/^valkey/i, "Valkey"],
  [/^mysqld$/i, "MySQL"],
  [/^mongod$/i, "MongoDB"],
  [/^sshd$/i, "OpenSSH"],
  [/^tailscaled?$/i, "Tailscale"],
  [/^com\.docke|^docker/i, "Docker"],
  [/^esbuild$/i, "esbuild"],
  [/^ControlCenter$/i, "Control Center"],
  [/^rapportd$/i, "Handoff (rapportd)"],
  [/^kubectl/i, "kubectl port-forward"],
];

export function friendlyName(command: string): string {
  const base = command.split("/").pop() ?? command;
  for (const [pattern, name] of NAMES) {
    if (pattern.test(base)) return name;
  }
  return base;
}

/** Only a locally reachable TCP port can be opened in a browser. */
export function httpUrlFor(row: {
  protocol: string;
  scope: string;
  port: number;
}): string | null {
  if (row.protocol !== "tcp") return null;
  if (row.scope === "lan") return null;
  return `http://127.0.0.1:${row.port}`;
}

/**
 * The SDK's list shape is not pinned down by the docs, so the result is read
 * defensively: an array, or the first array-valued key of an object. A shape
 * change degrades this panel instead of breaking the whole RPC.
 */
export function normalizeAgents(
  raw: unknown,
  /** Expands the `~/…` form the Paseo CLI prints; the SDK returns absolute paths. */
  home = "",
): {
  id: string;
  provider: string;
  cwd: string;
  title: string;
  status: string;
}[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (Object.values(raw as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined) ?? []
      : [];

  return list
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => {
      const config = (entry.config ?? {}) as Record<string, unknown>;
      const provider = String(entry.provider ?? config.provider ?? "");
      const cwd = String(entry.cwd ?? "");
      return {
        id: String(entry.id ?? ""),
        // "codex/gpt-5.5" identifies the binary by its first segment.
        provider: provider.split("/")[0]?.toLowerCase() ?? "",
        cwd: home && cwd.startsWith("~/") ? `${home}/${cwd.slice(2)}` : cwd,
        title: String(entry.title ?? entry.name ?? ""),
        status: String(entry.status ?? ""),
      };
    })
    .filter((agent) => agent.provider.length > 0);
}
