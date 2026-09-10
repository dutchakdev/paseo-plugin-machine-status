import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ExplanationSchema = z.object({
  headline: z.string(),
  kind: z.enum(["apple-system", "agent-spawned", "container", "dev-runtime", "user-app", "unknown"]),
  state: z.enum(["just-started", "sustained-load", "memory-heavy", "steady"]),
  concern: z.enum(["none", "watch", "act"]),
  findings: z.array(z.string()),
  advice: z.array(z.string()),
});

export const explainProcess = defineRpc({
  name: "process.explain",
  input: z.object({ pid: z.number().int().min(0) }),
  output: z.object({
    found: z.boolean(),
    name: z.string(),
    pid: z.number(),
    explanation: ExplanationSchema,
  }),
});

export type Explanation = z.output<typeof ExplanationSchema>;
