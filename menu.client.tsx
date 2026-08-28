import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { useChromeStyles, type Chrome } from "./ui.client";
import { paletteFor } from "./viz.shared";

/**
 * A floating context menu, opened by right-click on desktop and by long-press on
 * touch.
 *
 * React Native has no context-menu primitive and no portals here, so the menu is
 * rendered by a provider that sits at the surface root, as a sibling *after* the
 * scrolling content. Rendering it inside the list would clip it to the row and
 * scroll it away with the content.
 */

export interface ContextMenuItem {
  id: string;
  label: string;
  tone?: "danger";
  disabled?: boolean;
  onSelect(): void;
}

export interface ContextMenuRequest {
  /** Page coordinates of the click; the provider converts them to its own space. */
  x: number;
  y: number;
  title?: string;
  items: ContextMenuItem[];
}

const OpenMenu = createContext<(request: ContextMenuRequest) => void>(() => {});

export const useContextMenu = () => useContext(OpenMenu);

const MENU_WIDTH = 248;
const ITEM_HEIGHT = 36;
const EDGE_GAP = 8;

export function ContextMenuProvider({
  chrome,
  children,
}: {
  chrome: Chrome;
  children: React.ReactNode;
}) {
  const styles = useChromeStyles(chrome);
  const palette = paletteFor(chrome.theme.colors.surface0);
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const origin = useRef({ x: 0, y: 0 });
  const root = useRef<View>(null);

  // Click coordinates are page-relative while the overlay is positioned inside
  // this view, so the view's own page offset has to be subtracted.
  const measure = useCallback(() => {
    root.current?.measureInWindow?.((x, y, width, height) => {
      origin.current = { x, y };
      setSize({ width, height });
    });
  }, []);

  const close = useCallback(() => setRequest(null), []);

  const position = useMemo(() => {
    if (!request) return { left: 0, top: 0 };
    const height = (request.items.length + (request.title ? 1 : 0)) * ITEM_HEIGHT + 16;
    const left = request.x - origin.current.x;
    const top = request.y - origin.current.y;
    return {
      left: Math.max(EDGE_GAP, Math.min(left, Math.max(EDGE_GAP, size.width - MENU_WIDTH - EDGE_GAP))),
      top: Math.max(EDGE_GAP, Math.min(top, Math.max(EDGE_GAP, size.height - height - EDGE_GAP))),
    };
  }, [request, size]);

  return (
    <OpenMenu.Provider value={setRequest}>
      <View ref={root} style={{ flex: 1 }} onLayout={measure} collapsable={false}>
        {children}

        {request ? (
          <View style={StyleSheet.absoluteFill}>
            {/* Any click outside dismisses, which is what a context menu does. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close menu"
              onPress={close}
              style={StyleSheet.absoluteFill}
            />
            <View
              accessibilityRole="menu"
              style={{
                position: "absolute",
                left: position.left,
                top: position.top,
                width: MENU_WIDTH,
                borderRadius: 12,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: palette.borderStrong,
                backgroundColor: chrome.theme.colors.surface0,
                paddingVertical: 6,
                // The menu floats over content, so it needs a shadow to read as
                // a layer rather than as part of the list.
                shadowColor: "#000",
                shadowOpacity: 0.4,
                shadowRadius: 24,
                shadowOffset: { width: 0, height: 12 },
                elevation: 12,
              }}
            >
              {request.title ? (
                <Text style={[styles.axis, { paddingHorizontal: 14, paddingVertical: 8 }]} numberOfLines={1}>
                  {request.title}
                </Text>
              ) : null}

              {request.items.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.label}
                  accessibilityState={{ disabled: item.disabled }}
                  disabled={item.disabled}
                  onPress={() => {
                    close();
                    item.onSelect();
                  }}
                  style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
                    height: ITEM_HEIGHT,
                    justifyContent: "center",
                    paddingHorizontal: 14,
                    marginHorizontal: 6,
                    borderRadius: 8,
                    opacity: item.disabled ? 0.4 : 1,
                    backgroundColor: pressed || hovered ? palette.border : "transparent",
                  })}
                >
                  <Text
                    style={
                      item.tone === "danger"
                        ? { color: chrome.theme.colors.statusDanger, fontSize: chrome.compact ? 13 : 14 }
                        : styles.value
                    }
                  >
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
      </View>
    </OpenMenu.Provider>
  );
}

/**
 * Props that make any Pressable open a context menu.
 *
 * `onContextMenu` is a DOM event that react-native-web forwards but React
 * Native's types do not declare, so it is attached only on web and cast. Touch
 * platforms get the long-press equivalent instead.
 */
export function contextMenuTriggers(open: (x: number, y: number) => void) {
  const fromTouch = (event: GestureResponderEvent) => {
    const { pageX, pageY } = event.nativeEvent;
    open(pageX, pageY);
  };

  const web =
    Platform.OS === "web"
      ? ({
          onContextMenu: (event: { preventDefault?(): void; pageX?: number; pageY?: number }) => {
            event.preventDefault?.();
            open(event.pageX ?? 0, event.pageY ?? 0);
          },
        } as Record<string, unknown>)
      : {};

  return { onLongPress: fromTouch, ...web };
}
