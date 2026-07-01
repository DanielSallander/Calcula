// Tests for the panel placement contract: a panel can declare which surfaces
// (sidebar / ribbon) it supports, and the registry must never project or move
// it into an unsupported surface. This guards the Animation-in-ribbon bug where
// a tall, sidebar-authored panel blew up the ribbon's fixed-height band.

import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { panelRegistry, getSupportedPlacements, initPanelRegistry } from "../panelRegistry";
import { usePanelPlacementStore } from "../usePanelPlacementStore";
import type { PanelDefinition } from "../../../api/uiTypes";

const noop = () => {};

beforeEach(() => {
  // Stub the downstream registries so projection is inert in the test.
  initPanelRegistry({
    activityBar: { registerView: noop, unregisterView: noop },
    extensionRegistry: { registerRibbonTab: noop, unregisterRibbonTab: noop },
    getActivityBarStore: () => ({ openView: noop, close: noop, activeViewId: null }),
  });
  usePanelPlacementStore.setState({ placements: {} });
  panelRegistry.clear();
});

function makePanel(over: Partial<PanelDefinition> = {}): PanelDefinition {
  return {
    id: "test.panel",
    title: "Test",
    icon: React.createElement("span"),
    sections: [{ id: "s", label: "S", component: () => null }],
    defaultPlacement: "sidebar",
    ...over,
  };
}

describe("getSupportedPlacements", () => {
  it("defaults to both surfaces when unset", () => {
    expect(getSupportedPlacements(makePanel())).toEqual(["sidebar", "ribbon"]);
  });

  it("defaults to both when the declared list is empty", () => {
    expect(getSupportedPlacements(makePanel({ supportedPlacements: [] }))).toEqual(["sidebar", "ribbon"]);
  });

  it("respects a declared subset", () => {
    expect(getSupportedPlacements(makePanel({ supportedPlacements: ["sidebar"] }))).toEqual(["sidebar"]);
  });
});

describe("panelRegistry placement enforcement", () => {
  it("allows moving a both-surface panel to the ribbon", () => {
    panelRegistry.registerPanel(makePanel());
    expect(panelRegistry.canMoveTo("test.panel", "ribbon")).toBe(true);
    panelRegistry.setPlacement("test.panel", "ribbon");
    expect(panelRegistry.getPlacement("test.panel")).toBe("ribbon");
  });

  it("refuses to move a sidebar-only panel to the ribbon", () => {
    panelRegistry.registerPanel(makePanel({ supportedPlacements: ["sidebar"] }));
    expect(panelRegistry.canMoveTo("test.panel", "ribbon")).toBe(false);
    panelRegistry.setPlacement("test.panel", "ribbon");
    expect(panelRegistry.getPlacement("test.panel")).toBe("sidebar");
  });

  it("never reports a non-movable panel as movable", () => {
    panelRegistry.registerPanel(makePanel({ movable: false }));
    expect(panelRegistry.canMoveTo("test.panel", "ribbon")).toBe(false);
  });

  it("clamps a stale persisted placement to a supported surface on register", () => {
    // Simulate a panel that was moved to the ribbon in a previous session and
    // has since been declared sidebar-only.
    usePanelPlacementStore.setState({ placements: { "test.panel": "ribbon" } });
    panelRegistry.registerPanel(makePanel({ supportedPlacements: ["sidebar"] }));
    expect(panelRegistry.getPlacement("test.panel")).toBe("sidebar");
    // The invalid override is cleared from the store, not just masked.
    expect(usePanelPlacementStore.getState().placements["test.panel"]).toBeUndefined();
  });
});
