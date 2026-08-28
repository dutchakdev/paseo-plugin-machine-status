import type { PluginContext } from "@getpaseo/plugin";
import { applyCleanupHandler, planCleanupHandler } from "./cleanup.server";
import { applyCleanup, killProcess, listProcesses, planCleanup, readMetrics } from "./contracts.shared";
import {
  controlContainerHandler,
  pruneDockerHandler,
  readDockerHandler,
} from "./docker.server";
import { controlContainer, pruneDocker, readDocker } from "./docker.shared";
import { explainProcessHandler } from "./explain.server";
import { explainProcess } from "./explain.shared";
import { readMetricsHandler } from "./metrics.server";
import { killProcessHandler, listProcessesHandler } from "./processes.server";
import { readServicesHandler } from "./services.server";
import { readServices } from "./services.shared";
import { MachineStatusSurface } from "./status.client";

export default function contribute(plugin: PluginContext) {
  // Daemon-side work: every shell command, path and signal stays on this side.
  plugin.handle(readMetrics, readMetricsHandler);
  plugin.handle(planCleanup, planCleanupHandler);
  plugin.handle(applyCleanup, applyCleanupHandler);
  plugin.handle(listProcesses, listProcessesHandler);
  plugin.handle(killProcess, killProcessHandler);
  plugin.handle(readServices, readServicesHandler);
  plugin.handle(explainProcess, explainProcessHandler);
  plugin.handle(readDocker, readDockerHandler);
  plugin.handle(controlContainer, controlContainerHandler);
  plugin.handle(pruneDocker, pruneDockerHandler);

  plugin.addSurface("main", MachineStatusSurface);

  plugin.addSidebarItem({
    id: "main",
    title: "Machine",
    icon: "Activity",
    surface: "main",
  });

  plugin.addCommandCenterItem({
    id: "open-machine-status",
    title: "Machine status",
    icon: "Activity",
    keywords: ["cpu", "memory", "disk", "swap", "battery", "thermal", "ports", "services"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("main");
    },
  });

  // No timers, watchers or sockets are created at registration time, so there is
  // nothing to release. Paseo removes the contributions and stops the subprocess.
  return () => {};
}
