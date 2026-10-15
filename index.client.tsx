import type { PluginClientContext } from "@getpaseo/plugin/client";
import { openMachineScreen, registerMachineScreen, supportsScreenParams } from "./client/compat";
import { contributePills } from "./client/pill";
import { MachineStatusSurface } from "./client/status";

/**
 * The app half of the plugin: the Machine screen, the ways into it from the
 * sidebar and the Command Center, and the load pill beside each agent's composer.
 */
export default function contribute(client: PluginClientContext) {
  registerMachineScreen(client, MachineStatusSurface);

  client.addCommandCenterItem({
    id: "open-machine-status",
    title: "Machine status",
    icon: "Activity",
    keywords: ["cpu", "memory", "disk", "swap", "battery", "thermal", "ports", "services"],
    context: "global",
    onSelect(capabilities) {
      openMachineScreen(capabilities);
    },
  });

  // Straight to a tab needs screen params. On older apps these would open the
  // overview under a misleading title, so they are not offered there.
  if (supportsScreenParams(client)) {
    client.addCommandCenterItem({
      id: "open-machine-services",
      title: "Machine: ports & services",
      icon: "Network",
      keywords: ["ports", "listening", "lsof", "dev server"],
      context: "global",
      onSelect(capabilities) {
        openMachineScreen(capabilities, { tab: "services" });
      },
    });
    client.addCommandCenterItem({
      id: "open-machine-docker",
      title: "Machine: Docker",
      icon: "Container",
      keywords: ["docker", "containers", "orbstack", "rancher"],
      context: "global",
      onSelect(capabilities) {
        openMachineScreen(capabilities, { tab: "docker" });
      },
    });
  }

  return contributePills(client);
}
