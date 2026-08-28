import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const PortSchema = z.object({
  id: z.string(),
  port: z.number(),
  protocol: z.enum(["tcp", "udp"]),
  address: z.string(),
  scope: z.enum(["public", "lan", "local"]),
  pid: z.number().nullable(),
  command: z.string().nullable(),
  /** "other" means the socket exists but belongs to a user we cannot inspect. */
  owner: z.enum(["you", "other"]),
  /** Whether this port belongs to development work or to the OS. */
  relevance: z.enum(["dev", "system"]),
  attribution: z
    .object({
      kind: z.enum(["agent", "agent-child", "docker", "process"]),
      label: z.string(),
      detail: z.string(),
    })
    .nullable(),
  url: z.string().nullable(),
});

export const ServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  subtitle: z.string(),
  ports: z.array(z.number()),
  status: z.enum(["running", "stopped"]),
  source: z.enum(["agent", "agent-child", "docker", "listener"]),
  relevance: z.enum(["dev", "system"]),
  pid: z.number().nullable(),
});

export const readServices = defineRpc({
  name: "services.read",
  input: z.object({}),
  output: z.object({
    collectedAt: z.string(),
    ports: z.array(PortSchema),
    services: z.array(ServiceSchema),
    /** Anything the collection could not see, stated rather than silently dropped. */
    notes: z.array(z.string()),
  }),
});

export type PortRow = z.output<typeof PortSchema>;
export type ServiceRow = z.output<typeof ServiceSchema>;

export * from "./services.classify";
