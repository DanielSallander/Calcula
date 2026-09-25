//! FILENAME: app/src/shell/registries/__tests__/panelActivateOnRegister.test.ts
// PURPOSE: A PanelDefinition's `ribbonActivateOnRegister` must reach the ribbon
//          TAB the registry projects it into -- that projection is the only
//          path from the Canvas tab's definition to RibbonContainer's "select
//          on arrival, restore on removal" rule, and it applies to CONTEXTUAL
//          tabs only (a coloured tab).

import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { panelRegistry, initPanelRegistry } from "../panelRegistry";
import { usePanelPlacementStore } from "../usePanelPlacementStore";
import type { PanelDefinition } from "../../../api/uiTypes";
import type { RibbonTabDefinition } from "../../../api/extensions";

const noop = () => {};
let tabs: RibbonTabDefinition[];

beforeEach(() => {
  tabs = [];
  initPanelRegistry({
    activityBar: { registerView: noop, unregisterView: noop },
    extensionRegistry: {
      registerRibbonTab: (tab) => tabs.push(tab as RibbonTabDefinition),
      unregisterRibbonTab: noop,
    },
    getActivityBarStore: () => ({ openView: noop, close: noop, activeViewId: null }),
  });
  usePanelPlacementStore.setState({ placements: {} });
  panelRegistry.clear();
});

function ribbonPanel(over: Partial<PanelDefinition> = {}): PanelDefinition {
  return {
    id: "canvas.test",
    title: "Canvas",
    icon: React.createElement("span"),
    sections: [{ id: "s", label: "S", component: () => null }],
    defaultPlacement: "ribbon",
    ...over,
  };
}

describe("ribbonActivateOnRegister reaches the projected ribbon tab", () => {
  it("a contextual (coloured) panel that asks for it gets activateOnRegister", () => {
    panelRegistry.registerPanel(
      ribbonPanel({ ribbonColor: "var(--tab-accent-canvas, #b0245f)", ribbonActivateOnRegister: true }),
    );
    expect(tabs).toHaveLength(1);
    expect(tabs[0].activateOnRegister).toBe(true);
  });

  it("a non-contextual panel never does (only a contextual tab may take the selection)", () => {
    panelRegistry.registerPanel(ribbonPanel({ ribbonActivateOnRegister: true }));
    expect(tabs[0].activateOnRegister).toBe(false);
  });

  it("a contextual panel that does not ask keeps today's behaviour", () => {
    panelRegistry.registerPanel(ribbonPanel({ ribbonColor: "var(--tab-accent-pivot, #1a7a43)" }));
    expect(tabs[0].activateOnRegister).toBe(false);
  });
});
