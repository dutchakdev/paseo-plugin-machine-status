import type {
  PluginClientContext,
  PluginCommandCapabilities,
  PluginHostProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import * as ui from "@getpaseo/plugin/client/ui";
import type { ComponentType, FunctionComponent } from "react";

/**
 * Paseo 0.11 replaced surfaces with screens: `addScreen`, `addSidebarHeaderItem`
 * and `openScreen`. The manifest still admits 0.8, and every connected app runs
 * this entry against its own version, so each call checks for the new method and
 * falls back to the old one.
 *
 * The SDK stays pinned to 0.8.0 so typechecking proves the rest of the plugin
 * uses only the oldest supported API. The 0.11 additions are described here,
 * from the 0.11 SDK declarations, and are reachable only behind a runtime check.
 */

const SCREEN_ID = "main";
const TITLE = "Machine";
const ICON = "Activity";

/** String keys and values: 0.11 carries them in the screen's URL. */
export type ScreenParams = Record<string, string>;

interface OpenScreenInput {
  screenId: string;
  params?: ScreenParams;
}

interface SidebarItemProps extends PluginHostProps {
  currentScreen: { screenId: string; params: ScreenParams } | null;
  openScreen(input: OpenScreenInput): void;
}

/** What 0.11 adds to the client context. */
interface ScreenApi {
  addScreen(contribution: {
    id: string;
    title: string;
    Component: ComponentType<MachineScreenProps>;
  }): () => void;
  addSidebarHeaderItem(contribution: {
    id: string;
    title: string;
    Component: ComponentType<SidebarItemProps>;
  }): () => void;
}

/** What 0.11 adds to command and slash-command callbacks. */
interface OpenScreenApi {
  openScreen(input: OpenScreenInput): void;
}

/** `@getpaseo/plugin/client/ui` gained this in 0.11; the older app runtime has no such export. */
type SidebarRowComponent = ComponentType<{ icon?: string; active?: boolean; onPress(): void }>;

/** What the screen receives on either API: 0.11 adds `params`, older hosts do not. */
export type MachineScreenProps = PluginSurfaceProps & { params?: ScreenParams };

function screenApi(client: PluginClientContext): ScreenApi | null {
  const candidate = client as PluginClientContext & Partial<ScreenApi>;
  return typeof candidate.addScreen === "function" && typeof candidate.addSidebarHeaderItem === "function"
    ? (candidate as PluginClientContext & ScreenApi)
    : null;
}

function openScreenApi(capabilities: object): OpenScreenApi | null {
  const candidate = capabilities as Partial<OpenScreenApi>;
  return typeof candidate.openScreen === "function" ? (candidate as OpenScreenApi) : null;
}

export function registerMachineScreen(
  client: PluginClientContext,
  Component: FunctionComponent<MachineScreenProps>,
): void {
  const screens = screenApi(client);
  if (screens) {
    screens.addScreen({ id: SCREEN_ID, title: TITLE, Component });
    // Same id as the old sidebar item, so saved `/plugin/machine-status/main` links keep working.
    screens.addSidebarHeaderItem({ id: SCREEN_ID, title: TITLE, Component: MachineSidebarItem });
    return;
  }
  client.addSurface(SCREEN_ID, Component);
  client.addSidebarItem({ id: SCREEN_ID, title: TITLE, icon: ICON, surface: SCREEN_ID });
}

function MachineSidebarItem({ currentScreen, openScreen }: SidebarItemProps) {
  // Read off the namespace: the 0.8–0.10 ui runtime has no SidebarRow, and the
  // item renders nothing rather than crash.
  const SidebarRow = (ui as { SidebarRow?: SidebarRowComponent }).SidebarRow;
  if (!SidebarRow) return null;
  return (
    <SidebarRow
      icon={ICON}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

/**
 * Opens the Machine screen, on a tab when the host can carry params. Pre-0.11
 * hosts open the surface on its default tab.
 */
export function openMachineScreen(
  capabilities: Pick<PluginCommandCapabilities, "openSurface">,
  params?: ScreenParams,
): void {
  const screens = openScreenApi(capabilities);
  if (screens) {
    screens.openScreen(params ? { screenId: SCREEN_ID, params } : { screenId: SCREEN_ID });
    return;
  }
  capabilities.openSurface(SCREEN_ID);
}

/** True on 0.11+ apps, where a command can land on a specific tab. */
export function supportsScreenParams(client: PluginClientContext): boolean {
  return openScreenApi(client) !== null;
}
