import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DockerContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  /** Docker's own word: running, exited, paused, created, restarting, dead. */
  state: z.string(),
  status: z.string(),
  ports: z.array(z.number()),
  running: z.boolean(),
});

export const DockerUsageRowSchema = z.object({
  label: z.string(),
  total: z.number(),
  active: z.number(),
  sizeBytes: z.number(),
  reclaimableBytes: z.number(),
  /** Volumes hold data; reclaiming them is never offered as a one-click action. */
  safeToReclaim: z.boolean(),
});

/**
 * The ids this plugin hands the client come from `{{.ID}}` in `docker ps` and
 * `docker images`: hex, 12 characters, or 64 untruncated. Anything else, such
 * as `--force`, would reach the Docker CLI as an argument, so it is refused at
 * the contract rather than trusted because the client normally sends an id.
 */
export const DockerIdSchema = z.string().regex(/^[0-9a-f]{12,64}$/, "Expected a Docker id");

export const DockerImageSchema = z.object({
  id: z.string(),
  reference: z.string(),
  sizeBytes: z.number(),
  created: z.string(),
  dangling: z.boolean(),
});

export const EngineSchema = z.object({
  /** `missing` means no engine is installed at all, not merely stopped. */
  state: z.enum(["running", "stopped", "missing"]),
  version: z.string().nullable(),
  /** The app this panel can launch, when it found one. */
  app: z.string().nullable(),
});

export const readDocker = defineRpc({
  name: "docker.read",
  input: z.object({}),
  output: z.object({
    engine: EngineSchema,
    available: z.boolean(),
    reason: z.string().nullable(),
    collectedAt: z.string(),
    containers: z.array(DockerContainerSchema),
    images: z.array(DockerImageSchema),
    usage: z.array(DockerUsageRowSchema),
    notes: z.array(z.string()),
  }),
});

export const controlEngine = defineRpc({
  name: "docker.engine",
  input: z.object({ action: z.enum(["start", "quit"]) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const readContainerLogs = defineRpc({
  name: "docker.logs",
  input: z.object({
    id: DockerIdSchema,
    lines: z.number().int().min(10).max(500).default(120),
  }),
  output: z.object({ ok: z.boolean(), text: z.string(), error: z.string().nullable() }),
});

export const removeImage = defineRpc({
  name: "docker.image.remove",
  input: z.object({ id: DockerIdSchema }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const controlContainer = defineRpc({
  name: "docker.control",
  input: z.object({
    id: DockerIdSchema,
    action: z.enum(["start", "stop", "restart", "remove"]),
  }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const pruneDocker = defineRpc({
  name: "docker.prune",
  input: z.object({ target: z.enum(["containers", "images"]) }),
  output: z.object({ ok: z.boolean(), reclaimedBytes: z.number(), error: z.string().nullable() }),
});

export type DockerContainer = z.output<typeof DockerContainerSchema>;
export type DockerImage = z.output<typeof DockerImageSchema>;
export type DockerEngine = z.output<typeof EngineSchema>;
export type DockerUsageRow = z.output<typeof DockerUsageRowSchema>;
