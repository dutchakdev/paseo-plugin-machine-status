import { defineRpc } from "@getpaseo/plugin/server";
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
    id: z.string().min(1),
    lines: z.number().int().min(10).max(500).default(120),
  }),
  output: z.object({ ok: z.boolean(), text: z.string(), error: z.string().nullable() }),
});

export const removeImage = defineRpc({
  name: "docker.image.remove",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const controlContainer = defineRpc({
  name: "docker.control",
  input: z.object({
    id: z.string().min(1),
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
