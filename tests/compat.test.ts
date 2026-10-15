import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";

// The real module is supplied by the Paseo app; only the shape matters here.
vi.mock("@getpaseo/plugin/client/ui", () => ({}));

const { openMachineScreen, registerMachineScreen, supportsScreenParams } = await import("../client/compat");

const Screen = () => null;

/** A 0.8–0.10 app: surfaces only, no screen methods on the object at all. */
function legacyClient() {
  return {
    addSurface: vi.fn(),
    addSidebarItem: vi.fn(),
    openSurface: vi.fn(),
  };
}

/** A 0.11+ app: both APIs present, the old ones deprecated. */
function modernClient() {
  return {
    ...legacyClient(),
    addScreen: vi.fn(),
    addSidebarHeaderItem: vi.fn(),
    openScreen: vi.fn(),
  };
}

const asClient = (client: object) => client as unknown as PluginClientContext;

describe("registerMachineScreen", () => {
  it("uses screens and a header item on 0.11+, and never the deprecated calls", () => {
    const client = modernClient();
    registerMachineScreen(asClient(client), Screen);

    expect(client.addScreen).toHaveBeenCalledWith({ id: "main", title: "Machine", Component: Screen });
    expect(client.addSidebarHeaderItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "main", title: "Machine" }),
    );
    expect(client.addSurface).not.toHaveBeenCalled();
    expect(client.addSidebarItem).not.toHaveBeenCalled();
  });

  it("falls back to a surface and sidebar item on older apps", () => {
    const client = legacyClient();
    registerMachineScreen(asClient(client), Screen);

    expect(client.addSurface).toHaveBeenCalledWith("main", Screen);
    expect(client.addSidebarItem).toHaveBeenCalledWith({
      id: "main",
      title: "Machine",
      icon: "Activity",
      surface: "main",
    });
  });

  it("does not mix APIs when only half of the screen API is present", () => {
    const client = { ...legacyClient(), addScreen: vi.fn() };
    registerMachineScreen(asClient(client), Screen);

    expect(client.addScreen).not.toHaveBeenCalled();
    expect(client.addSurface).toHaveBeenCalledOnce();
  });
});

describe("openMachineScreen", () => {
  it("opens the screen with a tab on 0.11+", () => {
    const client = modernClient();
    openMachineScreen(asClient(client), { tab: "docker" });

    expect(client.openScreen).toHaveBeenCalledWith({ screenId: "main", params: { tab: "docker" } });
    expect(client.openSurface).not.toHaveBeenCalled();
  });

  it("passes no params key when none are given", () => {
    const client = modernClient();
    openMachineScreen(asClient(client));

    expect(client.openScreen).toHaveBeenCalledWith({ screenId: "main" });
  });

  it("opens the surface on older apps and drops the tab", () => {
    const client = legacyClient();
    openMachineScreen(asClient(client), { tab: "docker" });

    expect(client.openSurface).toHaveBeenCalledWith("main");
  });
});

describe("supportsScreenParams", () => {
  it("follows openScreen", () => {
    expect(supportsScreenParams(asClient(modernClient()))).toBe(true);
    expect(supportsScreenParams(asClient(legacyClient()))).toBe(false);
  });
});
