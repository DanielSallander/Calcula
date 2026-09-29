//! FILENAME: app/extensions/Pivot/__tests__/pivotManifest.test.ts
// PURPOSE: The two contextual pivot panels' metadata after the Clusters
//          redesign: every section and panel carries a duotone RibbonIcon
//          element (24 for a section, 20 for a panel) instead of an emoji or a
//          unicode glyph string, the tab accent is the skin's pivot token, and
//          the titles the contextual-ribbon-tabs invariant keys on are intact.

/* eslint-disable @typescript-eslint/naming-convention --
 * The doubles below stand in for React components, whose real export names are
 * PascalCase, and the expected-icon table is keyed by the real section ids
 * ("pivot-design.name"); renaming either would stop them being what they test. */

import { describe, it, expect, vi } from "vitest";
import React from "react";

// The panel definitions reference the section components by identity only;
// the dialogs and panes the manifest also registers are other files' concern
// and heavy to import, so they are stood in for.
vi.mock("@api", () => ({ emitAppEvent: vi.fn() }));
vi.mock("../components/PivotEditorView", () => ({ PivotEditorView: () => null }));
vi.mock("../components/CreatePivotDialog", () => ({ CreatePivotDialog: () => null }));
vi.mock("../components/GroupDialog", () => ({ GroupDialog: () => null }));
vi.mock("../components/FieldSettingsDialog", () => ({ FieldSettingsDialog: () => null }));
vi.mock("../components/PivotOptionsDialog", () => ({ PivotOptionsDialog: () => null }));
vi.mock("../components/DrillThroughBehaviorDialog", () => ({ default: () => null }));
vi.mock("../components/FilterDropdown", () => ({ FilterDropdown: () => null }));
vi.mock("../components/PivotHeaderFilterDropdown", () => ({ PivotHeaderFilterDropdown: () => null }));
vi.mock("../components/PivotDesignSections", () => ({
  DesignNameSection: () => null,
  DesignGrandTotalsSection: () => null,
  DesignStylesSection: () => null,
  DesignReportLayoutSection: () => null,
  DesignDisplaySection: () => null,
}));
vi.mock("../components/PivotAnalyzeSections", () => ({
  AnalyzePivotTableSection: () => null,
  AnalyzeDataSection: () => null,
  AnalyzeActionsSection: () => null,
  AnalyzeCalculationsSection: () => null,
}));

import type { DialogProps } from "@api";
import { RibbonIcon } from "@api/ribbonIcons";
import {
  PivotAnalyzePanelDefinition,
  PivotDesignPanelDefinition,
  PivotDialogDefinition,
  PIVOT_ANALYZE_TAB_ID,
  PIVOT_DESIGN_TAB_ID,
} from "../manifest";

const ICON_FUNCTIONS = new Set<unknown>(Object.values(RibbonIcon));

function iconKey(node: React.ReactNode): string | undefined {
  if (!React.isValidElement(node)) return undefined;
  return Object.entries(RibbonIcon).find(([, fn]) => fn === node.type)?.[0];
}

function iconSize(node: React.ReactNode): unknown {
  return React.isValidElement(node) ? (node.props as { size?: number }).size : undefined;
}

describe("pivot contextual panels", () => {
  const panels = [PivotAnalyzePanelDefinition, PivotDesignPanelDefinition];

  it("keep the ids and the exact titles the contextual-tab invariant keys on", () => {
    expect(PivotAnalyzePanelDefinition.id).toBe(PIVOT_ANALYZE_TAB_ID);
    expect(PivotDesignPanelDefinition.id).toBe(PIVOT_DESIGN_TAB_ID);
    expect(PivotAnalyzePanelDefinition.title).toBe("Pivot Table");
    expect(PivotDesignPanelDefinition.title).toBe("Pivot Table Design");
  });

  it("paint the tab accent with the skin's pivot token", () => {
    for (const panel of panels) {
      expect(panel.ribbonColor).toBe("var(--tab-accent-pivot, #217346)");
    }
  });

  it("carry a RibbonIcon at 20 as the panel icon", () => {
    for (const panel of panels) {
      expect(ICON_FUNCTIONS.has((panel.icon as React.ReactElement).type)).toBe(true);
      expect(iconKey(panel.icon)).toBe("Pivot");
      expect(iconSize(panel.icon)).toBe(20);
    }
  });

  it("give every section a RibbonIcon at 24 — never an emoji or glyph string", () => {
    for (const panel of panels) {
      for (const section of panel.sections ?? []) {
        expect(typeof section.icon, section.id).not.toBe("string");
        expect(iconKey(section.icon), section.id).toBeDefined();
        expect(iconSize(section.icon), section.id).toBe(24);
      }
    }
  });

  it("map each section to the icon that names it", () => {
    // Compared by drawing, not by key: some keys share one drawing (Pencil is
    // also EditChart), so a reverse lookup could name either.
    const expected: Record<string, keyof typeof RibbonIcon> = {
      "pivot-analyze.pivotTable": "Pivot",
      "pivot-analyze.data": "Refresh",
      "pivot-analyze.actions": "Lightning",
      "pivot-analyze.calculations": "Fx",
      "pivot-design.name": "Pencil",
      "pivot-design.grandTotals": "GrandTotals",
      "pivot-design.styles": "TableStyle",
      "pivot-design.reportLayout": "ReportLayout",
      "pivot-design.display": "Eye",
    };
    const sections = panels.flatMap((p) => p.sections ?? []);
    expect(sections.map((s) => s.id).sort()).toEqual(Object.keys(expected).sort());
    for (const section of sections) {
      expect((section.icon as React.ReactElement).type, section.id).toBe(RibbonIcon[expected[section.id]]);
    }
  });

  it("keep the section labels, order and collapse priorities", () => {
    expect(PivotAnalyzePanelDefinition.sections?.map((s) => [s.label, s.collapsePriority])).toEqual([
      ["PivotTable", 1],
      ["Data", 3],
      ["Actions", 2],
      ["Calculations", 4],
    ]);
    expect(PivotDesignPanelDefinition.sections?.map((s) => [s.label, s.collapsePriority])).toEqual([
      ["PivotTable Name", 1],
      ["Grand Totals", 2],
      ["PivotTable Styles", 100],
      ["Report Layout", 3],
      ["Display", 4],
    ]);
  });
});

// Wave D, X3 (completes W24): Insert > PivotTable opens with
// `{ suppressAutoRange: true }` while a selection owner (a floating grid)
// holds the selection -- Core's selection is then a cell HIDDEN under it. The
// dialog wrapper dropped the flag, so the dialog prefilled from that cell.
describe("the Create PivotTable dialog registration", () => {
  // The wrapper is a function component: called directly, it returns the
  // element it renders, whose props are what the dialog receives.
  type Wrapper = (props: DialogProps) => React.ReactElement<Record<string, unknown>>;
  const render = (data?: Record<string, unknown>) =>
    (PivotDialogDefinition.component as Wrapper)({ isOpen: true, onClose: () => {}, data });

  it("hands the opener's suppressAutoRange to the dialog", () => {
    expect(render({ suppressAutoRange: true }).props.suppressAutoRange).toBe(true);
  });

  it("reads anything but true as not asked", () => {
    expect(render().props.suppressAutoRange).toBe(false);
    expect(render({ suppressAutoRange: "yes" }).props.suppressAutoRange).toBe(false);
  });
});
