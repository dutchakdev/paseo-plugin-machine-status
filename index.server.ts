import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerAgentTools } from "./server/agent-tools";
import { attributeCpuHandler } from "./server/attribution";
import { applyCleanupHandler, planCleanupHandler } from "./server/cleanup";
import {
  controlContainerHandler,
  controlEngineHandler,
  pruneDockerHandler,
  readContainerLogsHandler,
  readDockerHandler,
  removeImageHandler,
} from "./server/docker";
import { explainProcessHandler } from "./server/explain";
import { readMetricsHandler } from "./server/metrics";
import { killProcessHandler, listProcessesHandler } from "./server/processes";
import { readServicesHandler } from "./server/services";
import { attributeCpu } from "./shared/attribution";
import { applyCleanup, killProcess, listProcesses, planCleanup, readMetrics } from "./shared/contracts";
import { controlContainer, controlEngine, pruneDocker, readContainerLogs, readDocker, removeImage } from "./shared/docker";
import { explainProcess } from "./shared/explain";
import { readServices } from "./shared/services";

/**
 * The daemon half of the plugin. Every shell command, path and signal stays
 * here, behind a Zod contract the app calls over RPC; nothing under `client/`
 * can touch the machine directly.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(readMetrics, readMetricsHandler);
  server.handle(attributeCpu, attributeCpuHandler);
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
  server.handle(removeImage, removeImageHandler);

  // On Paseo 0.14 and newer every agent gets machine_status and
  // machine_explain_process; older daemons send no tool list and get nothing.
  const stopTools = registerAgentTools(server);

  // No timers, watchers or sockets are created at registration time; the one
  // hook is released here, and Paseo removes the handlers itself.
  return () => stopTools();
}
