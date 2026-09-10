import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePills } from "./client/pill";
import { MachineStatusSurface } from "./client/status";

/**
 * The app half of the plugin: the Machine surface, the ways into it from the
 * sidebar and the Command Center, and the load pill beside each agent's composer.
 */
export default function contribute(client: PluginClientContext) {
  client.addSurface("main", MachineStatusSurface);

  client.addSidebarItem({
    id: "main",
    title: "Machine",
    icon: "Activity",
    surface: "main",
  });

  client.addCommandCenterItem({
    id: "open-machine-status",
    title: "Machine status",
    icon: "Activity",
    keywords: ["cpu", "memory", "disk", "swap", "battery", "thermal", "ports", "services"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("main");
    },
  });

  return contributePills(client);
}
