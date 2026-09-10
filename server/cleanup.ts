import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
import type { applyCleanup, CleanupTargetSchema, planCleanup } from "../shared/contracts";
import { describeError, runTolerant } from "./exec";

type CleanupTarget = z.output<typeof CleanupTargetSchema>;
type PlanOutput = z.output<typeof planCleanup.output>;
type ApplyInput = z.output<typeof applyCleanup.input>;
type ApplyOutput = z.output<typeof applyCleanup.output>;

interface TargetDefinition {
  id: string;
  label: string;
  hint: string;
  /** Checked in order; the first one that exists wins. Tools move their caches between versions. */
  candidates: string[];
}

const home = (...segments: string[]): string => path.join(os.homedir(), ...segments);

/**
 * Only these paths can ever be emptied. Every entry is a package-manager or
 * build cache that its tool recreates on demand, so removing it costs a
 * re-download rather than data. `~/Library/Caches` as a whole is deliberately
 * absent: it also holds application state that does not regenerate.
 */
const TARGET_DEFINITIONS: readonly TargetDefinition[] = [
  {
    id: "npm",
    label: "npm cache",
    hint: "Re-downloaded on the next install",
    candidates: [home(".npm", "_cacache")],
  },
  {
    id: "pnpm",
    label: "pnpm store",
    hint: "Rebuilt on the next pnpm install",
    candidates: [home("Library", "pnpm", "store"), home(".local", "share", "pnpm", "store"), home(".pnpm-store")],
  },
  {
    id: "yarn",
    label: "Yarn cache",
    hint: "Re-downloaded on the next install",
    candidates: [home("Library", "Caches", "Yarn")],
  },
  {
    id: "bun",
    label: "Bun install cache",
    hint: "Re-downloaded on the next bun install",
    candidates: [home(".bun", "install", "cache")],
  },
  {
    id: "turbo",
    label: "Turbo cache",
    hint: "Next turbo run rebuilds instead of replaying",
    candidates: [home(".cache", "turbo")],
  },
  {
    id: "xcode-derived-data",
    label: "Xcode DerivedData",
    hint: "Next Xcode build is a full rebuild",
    candidates: [home("Library", "Developer", "Xcode", "DerivedData")],
  },
  {
    id: "cargo",
    label: "Cargo registry cache",
    hint: "Re-downloaded on the next cargo build",
    candidates: [home(".cargo", "registry", "cache")],
  },
  {
    id: "go-build",
    label: "Go build cache",
    hint: "Next go build is a full rebuild",
    candidates: [home("Library", "Caches", "go-build")],
  },
  {
    id: "pip",
    label: "pip cache",
    hint: "Re-downloaded on the next pip install",
    candidates: [home("Library", "Caches", "pip")],
  },
  {
    id: "uv",
    label: "uv cache",
    hint: "Re-downloaded on the next uv sync",
    candidates: [home(".cache", "uv")],
  },
];

async function exists(target: string): Promise<boolean> {
  try {
    const stats = await fs.stat(target);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function resolveCandidate(definition: TargetDefinition): Promise<{ path: string; exists: boolean }> {
  for (const candidate of definition.candidates) {
    if (await exists(candidate)) return { path: candidate, exists: true };
  }
  return { path: definition.candidates[0], exists: false };
}

/**
 * The last line of defence before anything is removed. Resolves symlinks first,
 * so a link planted inside a cache directory cannot redirect the deletion, then
 * requires the result to sit at least two levels below the real home directory.
 */
export async function assertSafePath(target: string): Promise<string> {
  const realHome = await fs.realpath(os.homedir());
  const resolved = await fs.realpath(target);
  const relative = path.relative(realHome, resolved);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to touch ${resolved}: it is not inside the home directory`);
  }
  if (relative.split(path.sep).filter(Boolean).length < 2) {
    throw new Error(`refusing to touch ${resolved}: too close to the home directory root`);
  }
  return resolved;
}

async function directorySizeBytes(target: string): Promise<number> {
  const raw = await runTolerant("/usr/bin/du", ["-s", "-k", target], 120_000);
  const match = raw.match(/^\s*(\d+)/);
  return match ? Number(match[1]) * 1024 : 0;
}

/** Removes the directory's contents but keeps the directory, which several tools expect to exist. */
export async function emptyDirectory(target: string): Promise<void> {
  const entries = await fs.readdir(target);
  const batchSize = 32;
  for (let index = 0; index < entries.length; index += batchSize) {
    await Promise.all(
      entries
        .slice(index, index + batchSize)
        .map((entry) => fs.rm(path.join(target, entry), { recursive: true, force: true })),
    );
  }
}

export async function planCleanupHandler(): Promise<PlanOutput> {
  const targets: CleanupTarget[] = await Promise.all(
    TARGET_DEFINITIONS.map(async (definition): Promise<CleanupTarget> => {
      const resolved = await resolveCandidate(definition);
      const base = {
        id: definition.id,
        label: definition.label,
        hint: definition.hint,
        path: resolved.path,
        exists: resolved.exists,
      };
      if (!resolved.exists) return { ...base, sizeBytes: 0, error: null };
      try {
        await assertSafePath(resolved.path);
        return { ...base, sizeBytes: await directorySizeBytes(resolved.path), error: null };
      } catch (error) {
        return { ...base, sizeBytes: 0, error: describeError(error) };
      }
    }),
  );

  return {
    scannedAt: new Date().toISOString(),
    targets,
    totalBytes: targets.reduce((sum, target) => sum + target.sizeBytes, 0),
  };
}

export async function applyCleanupHandler({ targetIds }: ApplyInput): Promise<ApplyOutput> {
  const requested = new Set(targetIds);
  const selected = TARGET_DEFINITIONS.filter((definition) => requested.has(definition.id));

  const unknown = [...requested].filter(
    (id) => !TARGET_DEFINITIONS.some((definition) => definition.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown cleanup target: ${unknown.join(", ")}`);
  }

  const results = await Promise.all(
    selected.map(async (definition) => {
      const resolved = await resolveCandidate(definition);
      if (!resolved.exists) {
        return { id: definition.id, label: definition.label, ok: true, freedBytes: 0, error: null };
      }
      try {
        // Re-validate at apply time: the plan may be minutes old.
        const safePath = await assertSafePath(resolved.path);
        const before = await directorySizeBytes(safePath);
        await emptyDirectory(safePath);
        const after = await directorySizeBytes(safePath);
        return {
          id: definition.id,
          label: definition.label,
          ok: true,
          freedBytes: Math.max(0, before - after),
          error: null,
        };
      } catch (error) {
        console.error(`[machine-status] cleanup failed for ${definition.id}`, error);
        return {
          id: definition.id,
          label: definition.label,
          ok: false,
          freedBytes: 0,
          error: describeError(error),
        };
      }
    }),
  );

  return {
    appliedAt: new Date().toISOString(),
    freedBytes: results.reduce((sum, result) => sum + result.freedBytes, 0),
    results,
  };
}
