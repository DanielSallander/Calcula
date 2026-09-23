// The legacy ribbon API routed onto panels (bootstrap.ts legacyRibbonRouting).
//
// Why this exists: a legacy group registered BEFORE its tab is parked in
// ExtensionRegistryImpl, and RibbonContainer used to render parked groups
// through a direct path of its own — no measurement, no demotion, and it
// replaced the tab's measured sections outright. That path is deleted; these
// tests pin that every route that can park a group ALSO adopts it into the
// panel as a measured section and drains it from the Impl, so a raw group can
// never render outside the section renderer.

import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { legacyRibbonRouting } from "../../bootstrap";
import { panelRegistry, initPanelRegistry } from "../panelRegistry";
import { ExtensionRegistry as ExtensionRegistryImpl } from "../ExtensionRegistry";
import { usePanelPlacementStore } from "../usePanelPlacementStore";
import type {
  AddInManifest,
  RibbonGroupDefinition,
  RibbonTabDefinition,
} from "../../../api/extensions";
import type { ShellPanelSection } from "../../components/SectionRenderers";

const TAB_ID = "legacy.tab";

function RawTab(): React.ReactElement {
  return React.createElement("div", null, "raw tab");
}

function RawGroup(): React.ReactElement {
  return React.createElement("div", null, "raw group");
}

function makeTab(id = TAB_ID, order = 50): RibbonTabDefinition {
  return {
    id,
    label: `Tab ${id}`,
    order,
    component: RawTab as unknown as RibbonTabDefinition["component"],
  };
}

function makeGroup(id: string, tabId = TAB_ID, order = 10): RibbonGroupDefinition {
  return {
    id,
    tabId,
    label: `Group ${id}`,
    order,
    component: RawGroup as unknown as RibbonGroupDefinition["component"],
  };
}

function sectionIds(panelId = TAB_ID): string[] {
  return (panelRegistry.getPanel(panelId)?.sections ?? []).map((s) => s.id);
}

beforeEach(() => {
  ExtensionRegistryImpl.clear();
  panelRegistry.clear();
  usePanelPlacementStore.setState({ placements: {} });
  // Project the ribbon into the REAL Impl, as bootstrap does, so a test can
  // see exactly what RibbonContainer would read.
  initPanelRegistry({
    activityBar: { registerView: () => {}, unregisterView: () => {} },
    extensionRegistry: {
      registerRibbonTab: (tab) => ExtensionRegistryImpl.registerRibbonTab(tab),
      unregisterRibbonTab: (id) => ExtensionRegistryImpl.unregisterRibbonTab(id),
    },
    getActivityBarStore: () => ({ openView: () => {}, close: () => {}, activeViewId: null }),
  });
});

describe("group registered BEFORE its tab", () => {
  it("parks the group, then the tab adopts it as a section and drains it", () => {
    legacyRibbonRouting.registerRibbonGroup(makeGroup("g1"));
    expect(panelRegistry.getPanel(TAB_ID)).toBeUndefined();
    expect(ExtensionRegistryImpl.getRibbonGroupsForTab(TAB_ID).map((g) => g.id)).toEqual(["g1"]);

    legacyRibbonRouting.registerRibbonTab(makeTab());

    expect(sectionIds()).toEqual(["g1"]);
    expect(
      ExtensionRegistryImpl.getRibbonGroupsForTab(TAB_ID),
      "a parked group left in the Impl would be a raw group nothing measures",
    ).toEqual([]);
  });

  it("adopts several parked groups in their declared order", () => {
    legacyRibbonRouting.registerRibbonGroup(makeGroup("late", TAB_ID, 30));
    legacyRibbonRouting.registerRibbonGroup(makeGroup("early", TAB_ID, 10));
    legacyRibbonRouting.registerRibbonGroup(makeGroup("other-tab", "some.other.tab", 5));

    legacyRibbonRouting.registerRibbonTab(makeTab());

    expect(sectionIds()).toEqual(["early", "late"]);
    // Only this tab's groups are drained.
    expect(ExtensionRegistryImpl.getRibbonGroupsForTab("some.other.tab").map((g) => g.id)).toEqual([
      "other-tab",
    ]);
  });

  it("a group registered AFTER the tab still joins it (unchanged behaviour)", () => {
    legacyRibbonRouting.registerRibbonGroup(makeGroup("g1", TAB_ID, 10));
    legacyRibbonRouting.registerRibbonTab(makeTab());
    legacyRibbonRouting.registerRibbonGroup(makeGroup("g2", TAB_ID, 20));
    expect(sectionIds()).toEqual(["g1", "g2"]);
    expect(ExtensionRegistryImpl.getRibbonGroupsForTab(TAB_ID)).toEqual([]);
  });

  it("the tab projected into the ribbon is the panel's measured renderer, not the raw tab", () => {
    legacyRibbonRouting.registerRibbonGroup(makeGroup("g1"));
    legacyRibbonRouting.registerRibbonTab(makeTab());
    const projected = ExtensionRegistryImpl.getRibbonTab(TAB_ID);
    expect(projected).toBeDefined();
    expect(projected!.component).not.toBe(RawTab);
  });
});

describe("tab without groups", () => {
  it("wraps the whole tab as one section, which a later group replaces", () => {
    legacyRibbonRouting.registerRibbonTab(makeTab());
    expect(sectionIds()).toEqual([`${TAB_ID}.main`]);
    legacyRibbonRouting.registerRibbonGroup(makeGroup("g1"));
    expect(sectionIds()).toEqual(["g1"]);
  });

  it("synthesized sections are legacy-flagged, inline, and carry the group icon", () => {
    legacyRibbonRouting.registerRibbonTab(makeTab());
    const section = panelRegistry.getPanel(TAB_ID)!.sections[0] as ShellPanelSection;
    expect(section.legacyRibbonDom).toBe(true);
    expect(section.ribbonPresentation).toBe("inline");
    expect(React.isValidElement(section.icon)).toBe(true);
    expect(React.isValidElement(panelRegistry.getPanel(TAB_ID)!.icon)).toBe(true);
  });
});

describe("AddInManifest route", () => {
  function manifest(over: Partial<AddInManifest> = {}): AddInManifest {
    return {
      id: "acme.addin",
      name: "Acme",
      version: "1.0.0",
      ribbonTabs: [makeTab()],
      ribbonGroups: [makeGroup("m2", TAB_ID, 20), makeGroup("m1", TAB_ID, 10)],
      ...over,
    };
  }

  it("drains the manifest's own groups AND earlier-parked ones into the panel", () => {
    legacyRibbonRouting.registerRibbonGroup(makeGroup("parked", TAB_ID, 15));
    legacyRibbonRouting.registerAddIn(manifest());

    expect(sectionIds()).toEqual(["m1", "parked", "m2"]);
    expect(ExtensionRegistryImpl.getRibbonGroupsForTab(TAB_ID)).toEqual([]);
    expect(ExtensionRegistryImpl.getRibbonTab(TAB_ID)?.component).not.toBe(RawTab);
    expect(ExtensionRegistryImpl.hasAddIn("acme.addin")).toBe(true);
  });

  it("leaves no raw tab behind when the panel lives in the sidebar", () => {
    usePanelPlacementStore.setState({ placements: { [TAB_ID]: "sidebar" } });
    legacyRibbonRouting.registerAddIn(manifest());
    expect(sectionIds()).toEqual(["m1", "m2"]);
    expect(
      ExtensionRegistryImpl.getRibbonTab(TAB_ID),
      "the Impl's raw tab would render in the ribbon beside the sidebar panel",
    ).toBeUndefined();
  });

  it("adds a group aimed at another add-in's registered tab to THAT panel, and removes it on unregister", () => {
    legacyRibbonRouting.registerRibbonTab(makeTab("host.tab", 10));
    legacyRibbonRouting.registerRibbonGroup(makeGroup("host.g", "host.tab", 10));

    legacyRibbonRouting.registerAddIn(
      manifest({
        ribbonTabs: [],
        ribbonGroups: [makeGroup("guest.g", "host.tab", 20)],
      }),
    );
    expect(sectionIds("host.tab")).toEqual(["host.g", "guest.g"]);
    expect(ExtensionRegistryImpl.getRibbonGroupsForTab("host.tab")).toEqual([]);

    legacyRibbonRouting.unregisterAddIn("acme.addin");
    expect(sectionIds("host.tab")).toEqual(["host.g"]);
    expect(ExtensionRegistryImpl.hasAddIn("acme.addin")).toBe(false);
  });

  it("parks a group aimed at a tab that is not registered yet, and adopts it when the tab arrives", () => {
    legacyRibbonRouting.registerAddIn(
      manifest({ ribbonTabs: [], ribbonGroups: [makeGroup("early.g", "future.tab", 10)] }),
    );
    expect(ExtensionRegistryImpl.getRibbonGroupsForTab("future.tab").map((g) => g.id)).toEqual([
      "early.g",
    ]);
    legacyRibbonRouting.registerRibbonTab(makeTab("future.tab", 60));
    expect(sectionIds("future.tab")).toEqual(["early.g"]);
    expect(ExtensionRegistryImpl.getRibbonGroupsForTab("future.tab")).toEqual([]);
  });

  it("unregistering removes the add-in's own panels", () => {
    legacyRibbonRouting.registerAddIn(manifest());
    legacyRibbonRouting.unregisterAddIn("acme.addin");
    expect(panelRegistry.getPanel(TAB_ID)).toBeUndefined();
    expect(ExtensionRegistryImpl.getRibbonTab(TAB_ID)).toBeUndefined();
  });
});
