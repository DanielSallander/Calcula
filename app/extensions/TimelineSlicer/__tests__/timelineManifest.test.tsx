//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineManifest.test.tsx
// PURPOSE: The contextual Timeline panel definition after the Clusters
//          redesign: the tab keeps its exact label "Timeline" (the
//          contextual-ribbon-tabs invariant keys on it), its id, order and
//          section ids; the accent is the skin's slicer token with the
//          historical colour as the fallback (never null, so the tab stays
//          contextual); and the panel and every section carry an icon from the
//          one icon set (20 for the panel, 24 for a section).

import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TIMELINE_OPTIONS_TAB_ID, TimelineOptionsPanelDefinition } from "../manifest";

function svgOf(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

describe("TimelineOptionsPanelDefinition", () => {
  it("keeps the tab's identity: id, label, order, section ids", () => {
    expect(TimelineOptionsPanelDefinition.id).toBe(TIMELINE_OPTIONS_TAB_ID);
    expect(TimelineOptionsPanelDefinition.title).toBe("Timeline");
    expect(TimelineOptionsPanelDefinition.ribbonOrder).toBe(500);
    expect(TimelineOptionsPanelDefinition.defaultPlacement).toBe("ribbon");
    expect(TimelineOptionsPanelDefinition.sections.map((s) => [s.id, s.label, s.collapsePriority])).toEqual([
      ["timeline-slicer-options.level", "Level", 3],
      ["timeline-slicer-options.filter", "Filter", 2],
      ["timeline-slicer-options.timeline", "Timeline", 1],
    ]);
  });

  it("paints its accent from the slicer token, with the old blue as the fallback", () => {
    expect(TimelineOptionsPanelDefinition.ribbonColor).toBe("var(--tab-accent-slicer, #4472C4)");
  });

  it("has a 20px panel icon and a 24px icon on every section, all from the 24-grid set", () => {
    const panel = svgOf(TimelineOptionsPanelDefinition.icon);
    expect(panel).toContain('viewBox="0 0 24 24"');
    expect(panel).toContain('width="20"');
    for (const section of TimelineOptionsPanelDefinition.sections) {
      expect(section.icon, section.id).toBeTruthy();
      const svg = svgOf(section.icon);
      expect(svg, section.id).toContain('viewBox="0 0 24 24"');
      expect(svg, section.id).toContain('width="24"');
    }
  });
});
