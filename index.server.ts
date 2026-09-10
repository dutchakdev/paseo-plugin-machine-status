import type { PluginServerContext } from "@getpaseo/plugin/server";
import { applyCleanupHandler, planCleanupHandler } from "./server/cleanup";
import {
  controlContainerHandler,
  controlEngineHandler,
  pruneDockerHandler,
  readContainerLogsHandler,
  readDockerHandler,
} from "./server/docker";
import { explainProcessHandler } from "./server/explain";
import { readMetricsHandler } from "./server/metrics";
import { killProcessHandler, listProcessesHandler } from "./server/processes";
import { readServicesHandler } from "./server/services";
import { applyCleanup, killProcess, listProcesses, planCleanup, readMetrics } from "./shared/contracts";
import { controlContainer, controlEngine, pruneDocker, readContainerLogs, readDocker } from "./shared/docker";
import { explainProcess } from "./shared/explain";
import { readServices } from "./shared/services";

/**
 * The daemon half of the plugin. Every shell command, path and signal stays
 * here, behind a Zod contract the app calls over RPC; nothing under `client/`
 * can touch the machine directly.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(readMetrics, readMetricsHandler);
  server.handle(planCleanup, planCleanupHandler);
  server.handle(applyCleanup, applyCleanupHandler);
  server.handle(listProcesses, listProcessesHandler);
  server.handle(killProcess, killProcessHandler);
  server.handle(readServices, readServicesHandler);
  server.handle(explainProcess, explainProcessHandler);
  server.handle(readDocker, readDockerHandler);
  server.handle(controlContainer, controlContainerHandler);
  server.handle(controlEngine, controlEngineHandler);
  server.handle(readContainerLogs, readContainerLogsHandler);
  server.handle(pruneDocker, pruneDockerHandler);

  // No timers, watchers or sockets are created at registration time, so there is
  // nothing to release. Paseo removes the handlers and stops the subprocess.
  return () => {};
}
