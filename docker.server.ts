import type { z } from "zod";
import { describeError, run, runStreams, tryRun } from "./exec.server";
import type {
  controlContainer,
  controlEngine,
  pruneDocker,
  readContainerLogs,
  readDocker,
  removeImage,
  DockerContainer,
  DockerEngine,
  DockerImage,
  DockerUsageRow,
} from "./docker.shared";

type ReadOutput = z.output<typeof readDocker.output>;
type ControlInput = z.output<typeof controlContainer.input>;
type PruneInput = z.output<typeof pruneDocker.input>;
type EngineInput = z.output<typeof controlEngine.input>;
type LogsInput = z.output<typeof readContainerLogs.input>;
type ImageInput = z.output<typeof removeImage.input>;

const DOCKER = "/usr/local/bin/docker";
const PS_FORMAT = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}";

/**
 * Docker reports sizes in SI units in `system df` (`5.874GB`) and binary units in
 * `stats` (`31.39MiB`). Both appear, so both are read.
 */
const UNITS: Record<string, number> = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

export function parseDockerSize(value: string): number {
  const match = /^\s*([\d.]+)\s*([A-Za-z]*)\s*$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * (UNITS[match[2].toUpperCase()] ?? 1);
}

export function parseContainers(raw: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const line of raw.split("\n")) {
    const [id, name, image, state, status, ports] = line.split("\t");
    if (!id || !name) continue;
    const published = new Set<number>();
    // "0.0.0.0:5653->5432/tcp, [::]:5653->5432/tcp" — the published side is what
    // is reachable from this machine.
    for (const match of (ports ?? "").matchAll(/:(\d+)->/g)) published.add(Number(match[1]));
    containers.push({
      id,
      name,
      image: image ?? "",
      state: state ?? "",
      status: status ?? "",
      ports: [...published].sort((left, right) => left - right),
      running: state === "running",
    });
  }
  return containers;
}

const VOLUME_LABEL = "Local Volumes";

/**
 * Reads `docker system df`. Volumes are marked unsafe to reclaim: they are where
 * container data lives, and the biggest reclaimable number on a dev machine is
 * usually a database someone still wants.
 */
export function parseSystemDf(raw: string): DockerUsageRow[] {
  const rows: DockerUsageRow[] = [];
  for (const line of raw.split("\n").slice(1)) {
    const match = /^(\S+(?: \S+)?)\s+(\d+)\s+(\d+)\s+([\d.]+\s*\w+)\s+([\d.]+\s*\w+)/.exec(line.trim());
    if (!match) continue;
    const label = match[1];
    rows.push({
      label,
      total: Number(match[2]),
      active: Number(match[3]),
      sizeBytes: parseDockerSize(match[4]),
      reclaimableBytes: parseDockerSize(match[5]),
      safeToReclaim: label !== VOLUME_LABEL,
    });
  }
  return rows;
}

export function parseImages(raw: string): DockerImage[] {
  const images: DockerImage[] = [];
  for (const line of raw.split("\n")) {
    const [id, reference, size, created] = line.split("\t");
    if (!id || !reference) continue;
    images.push({
      id,
      reference,
      sizeBytes: parseDockerSize(size ?? "0B"),
      created: created ?? "",
      // An untagged image is a leftover layer set, which is what prune targets.
      dangling: reference.startsWith("<none>"),
    });
  }
  return images;
}

/** The desktop apps this panel knows how to launch, in the order it prefers them. */
const ENGINE_APPS = ["Docker", "OrbStack", "Rancher Desktop"];

async function installedApp(): Promise<string | null> {
  for (const app of ENGINE_APPS) {
    if (await tryRun("/bin/test", ["-d", `/Applications/${app}.app`], 2_000).then((r) => r !== null)) {
      return app;
    }
  }
  return null;
}

/**
 * Distinguishes "no engine installed" from "installed but not running". Only the
 * second one is worth offering a Start button for.
 */
export async function readEngine(): Promise<DockerEngine> {
  const version = await tryRun(DOCKER, ["version", "--format", "{{.Server.Version}}"], 5_000);
  const app = await installedApp();
  if (version !== null && version.trim().length > 0) {
    return { state: "running", version: version.trim(), app };
  }
  const cli = await tryRun("/bin/test", ["-x", DOCKER], 2_000);
  if (app === null && cli === null) return { state: "missing", version: null, app: null };
  return { state: "stopped", version: null, app };
}

export async function readDockerHandler(): Promise<ReadOutput> {
  const collectedAt = new Date().toISOString();
  const engine = await readEngine();

  if (engine.state !== "running") {
    return {
      engine,
      available: false,
      reason:
        engine.state === "missing"
          ? "No container engine is installed on this machine."
          : `${engine.app ?? "The container engine"} is installed but not running.`,
      collectedAt,
      containers: [],
      images: [],
      usage: [],
      notes: [],
    };
  }

  const [psRaw, dfRaw, imagesRaw] = await Promise.all([
    tryRun(DOCKER, ["ps", "-a", "--format", PS_FORMAT], 10_000),
    tryRun(DOCKER, ["system", "df"], 15_000),
    tryRun(DOCKER, ["images", "--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}"], 10_000),
  ]);

  const containers = parseContainers(psRaw ?? "");
  const usage = parseSystemDf(dfRaw ?? "");
  const notes: string[] = [];

  const volumes = usage.find((row) => row.label === VOLUME_LABEL);
  if (volumes && volumes.reclaimableBytes > 0) {
    notes.push(
      "Unused volumes are counted as reclaimable by Docker, but they hold container data — this panel never offers to remove them.",
    );
  }
  if (dfRaw === null) notes.push("Disk usage was not readable.");

  return {
    engine,
    available: true,
    reason: null,
    collectedAt,
    containers,
    images: parseImages(imagesRaw ?? ""),
    usage,
    notes,
  };
}

/**
 * Starting the engine is a launch, not a daemon command: Docker Desktop owns its
 * own VM and comes up over tens of seconds, so this returns as soon as the app
 * has been asked and the panel polls until the daemon answers.
 */
export async function controlEngineHandler({ action }: EngineInput) {
  const app = (await installedApp()) ?? "Docker";
  try {
    if (action === "start") {
      await run("/usr/bin/open", ["-a", app], 15_000);
    } else {
      await run("/usr/bin/osascript", ["-e", `quit app "${app}"`], 20_000);
    }
    return { ok: true, error: null };
  } catch (error) {
    console.error(`[machine-status] docker engine ${action} failed`, error);
    return { ok: false, error: describeError(error) };
  }
}

export async function readContainerLogsHandler({ id, lines }: LogsInput) {
  try {
    const { stdout, stderr } = await runStreams(
      DOCKER,
      ["logs", "--tail", String(lines), "--timestamps", id],
      20_000,
    );
    return { ok: true, text: `${stdout}${stderr}`.trimEnd(), error: null };
  } catch (error) {
    return { ok: false, text: "", error: describeError(error) };
  }
}

export async function removeImageHandler({ id }: ImageInput) {
  try {
    await run(DOCKER, ["rmi", id], 60_000);
    return { ok: true, error: null };
  } catch (error) {
    console.error(`[machine-status] docker rmi failed for ${id}`, error);
    return { ok: false, error: describeError(error) };
  }
}

export async function controlContainerHandler({ id, action }: ControlInput) {
  try {
    // `remove` is only ever reached through the confirmation menu in the panel.
    const args = action === "remove" ? ["rm", id] : [action, id];
    await run(DOCKER, args, 60_000);
    return { ok: true, error: null };
  } catch (error) {
    console.error(`[machine-status] docker ${action} failed for ${id}`, error);
    return { ok: false, error: describeError(error) };
  }
}

/** Matches the "Total reclaimed space: 1.234GB" line Docker prints after a prune. */
export function parseReclaimed(raw: string): number {
  const match = /Total reclaimed space:\s*([\d.]+\s*\w+)/i.exec(raw);
  return match ? parseDockerSize(match[1]) : 0;
}

export async function pruneDockerHandler({ target }: PruneInput) {
  // Images are pruned dangling-only. `-a` would delete every image not currently
  // in use by a container, which on a dev machine means re-pulling gigabytes.
  const args = target === "containers" ? ["container", "prune", "-f"] : ["image", "prune", "-f"];
  try {
    return { ok: true, reclaimedBytes: parseReclaimed(await run(DOCKER, args, 120_000)), error: null };
  } catch (error) {
    console.error(`[machine-status] docker prune ${target} failed`, error);
    return { ok: false, reclaimedBytes: 0, error: describeError(error) };
  }
}
