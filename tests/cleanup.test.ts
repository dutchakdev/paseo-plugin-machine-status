import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafePath, emptyDirectory } from "../cleanup.server";

/**
 * These tests exercise the guard that stands between the plugin and `fs.rm`.
 * The sandbox lives under the real home directory because that is exactly the
 * condition the guard checks.
 */
const sandbox = path.join(os.homedir(), ".cache", `machine-status-tests-${process.pid}`);
const outside = path.join(os.tmpdir(), `machine-status-outside-${process.pid}`);

beforeAll(async () => {
  await fs.mkdir(sandbox, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
});

afterAll(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("assertSafePath", () => {
  it("accepts a cache directory well below the home directory", async () => {
    await expect(assertSafePath(sandbox)).resolves.toContain("machine-status-tests");
  });

  it("refuses the home directory itself", async () => {
    await expect(assertSafePath(os.homedir())).rejects.toThrow(/not inside the home directory/);
  });

  it("refuses a directory only one level below home", async () => {
    const shallow = path.join(os.homedir(), `.machine-status-shallow-${process.pid}`);
    await fs.mkdir(shallow, { recursive: true });
    try {
      await expect(assertSafePath(shallow)).rejects.toThrow(/too close to the home directory root/);
    } finally {
      await fs.rm(shallow, { recursive: true, force: true });
    }
  });

  it("refuses a path outside the home directory", async () => {
    await expect(assertSafePath(outside)).rejects.toThrow(/not inside the home directory/);
  });

  it("refuses a symlink that escapes the home directory", async () => {
    // Without realpath resolution this link would pass the prefix check and the
    // deletion would land in /tmp instead of the cache.
    const escape = path.join(sandbox, "escape-hatch");
    await fs.symlink(outside, escape);
    await expect(assertSafePath(escape)).rejects.toThrow(/not inside the home directory/);
  });

  it("refuses a path that does not exist", async () => {
    await expect(assertSafePath(path.join(sandbox, "missing"))).rejects.toThrow();
  });
});

describe("emptyDirectory", () => {
  it("removes every child but keeps the directory itself", async () => {
    const target = path.join(sandbox, "cache-a");
    await fs.mkdir(path.join(target, "nested", "deeper"), { recursive: true });
    await fs.writeFile(path.join(target, "index.json"), "{}");
    await fs.writeFile(path.join(target, "nested", "deeper", "blob"), "x".repeat(1024));

    await emptyDirectory(target);

    await expect(fs.readdir(target)).resolves.toEqual([]);
    await expect(fs.stat(target)).resolves.toBeDefined();
  });

  it("removes a symlink without touching what it points at", async () => {
    const target = path.join(sandbox, "cache-b");
    const keeper = path.join(outside, "keep-me.txt");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(keeper, "survivor");
    await fs.symlink(keeper, path.join(target, "link-to-outside"));

    await emptyDirectory(target);

    await expect(fs.readdir(target)).resolves.toEqual([]);
    await expect(fs.readFile(keeper, "utf8")).resolves.toBe("survivor");
  });

  it("handles more children than one batch", async () => {
    const target = path.join(sandbox, "cache-c");
    await fs.mkdir(target, { recursive: true });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        fs.writeFile(path.join(target, `entry-${index}`), String(index)),
      ),
    );

    await emptyDirectory(target);

    await expect(fs.readdir(target)).resolves.toEqual([]);
  });

  it("is a no-op on an already empty directory", async () => {
    const target = path.join(sandbox, "cache-d");
    await fs.mkdir(target, { recursive: true });
    await expect(emptyDirectory(target)).resolves.toBeUndefined();
  });
});
