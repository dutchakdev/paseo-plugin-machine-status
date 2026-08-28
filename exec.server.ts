import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs a binary directly, never through a shell. Paths and PIDs flow into these
 * calls, and argv-style invocation removes any chance of shell interpretation.
 */
export async function run(file: string, args: string[], timeoutMs = 5_000): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

/** Same as `run`, but a missing binary or non-zero exit resolves to null instead of throwing. */
export async function tryRun(file: string, args: string[], timeoutMs = 5_000): Promise<string | null> {
  try {
    return await run(file, args, timeoutMs);
  } catch {
    return null;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Returns stdout even when the command exits non-zero. `du` walks unreadable
 * subdirectories, warns on stderr, exits 1, and still prints a usable total.
 */
export async function runTolerant(file: string, args: string[], timeoutMs = 5_000): Promise<string> {
  try {
    return await run(file, args, timeoutMs);
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

/**
 * Returns both streams. `docker logs` writes container stdout and stderr to the
 * matching stream of its own process, so reading only stdout loses the output of
 * every container that logs to stderr — which most of them do.
 */
export async function runStreams(
  file: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return { stdout, stderr };
}
