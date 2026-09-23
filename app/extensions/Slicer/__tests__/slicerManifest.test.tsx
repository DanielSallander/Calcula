//! FILENAME: app/extensions/Slicer/__tests__/slicerManifest.test.tsx
// PURPOSE: The contextual Slicer panel definition after the Clusters redesign:
//          the tab keeps its label, id, order and section ids (E2E invariants
//          and saved panel placements key on them); the accent is the
//          skin's slicer token with the historical colour as the fallback, so
//          the tab stays contextual (non-null accent) on every skin; and the
//          panel and every section carry an icon from the one icon set at the
//          sizes the shell expects (20 for a panel, 24 for a section).

import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SLICER_OPTIONS_TAB_ID, SlicerOptionsPanelDefinition } from "../manifest";

function svgOf(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

describe("SlicerOptionsPanelDefinition", () => {
  it("keeps the tab's identity: id, label, order, section ids", () => {
    expect(SlicerOptionsPanelDefinition.id).toBe(SLICER_OPTIONS_TAB_ID);
    expect(SlicerOptionsPanelDefinition.title).toBe("Slicer");
    expect(SlicerOptionsPanelDefinition.ribbonOrder).toBe(499);
    expect(SlicerOptionsPanelDefinition.defaultPlacement).toBe("ribbon");
    expect(SlicerOptionsPanelDefinition.sections.map((s) => [s.id, s.label, s.collapsePriority])).toEqual([
      ["slicer-options.properties", "Properties", 4],
      ["slicer-options.buttons", "Buttons", 3],
      ["slicer-options.styles", "Slicer Styles", 0],
      ["slicer-options.size", "Size", 2],
      ["slicer-options.actions", "Actions", 1],
    ]);
  });

  it("paints its accent from the slicer token, with the old green as the fallback", () => {
    expect(SlicerOptionsPanelDefinition.ribbonColor).toBe("var(--tab-accent-slicer, #548235)");
  });

  it("has a 20px panel icon and a 24px icon on every section, all from the 24-grid set", () => {
    const panel = svgOf(SlicerOptionsPanelDefinition.icon);
    expect(panel).toContain('viewBox="0 0 24 24"');
    expect(panel).toContain('width="20"');
    for (const section of SlicerOptionsPanelDefinition.sections) {
      expect(section.icon, section.id).toBeTruthy();
      const svg = svgOf(section.icon);
      expect(svg, section.id).toContain('viewBox="0 0 24 24"');
      expect(svg, section.id).toContain('width="24"');
    }
  });
});
