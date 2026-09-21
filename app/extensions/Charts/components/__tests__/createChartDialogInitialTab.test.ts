//! FILENAME: app/extensions/Charts/components/__tests__/createChartDialogInitialTab.test.ts
// PURPOSE: The chart dialog opens on the tab the opener asked for.
// CONTEXT: The chart context menu has always passed `initialTab` — "design" for
//          "Change Chart Type...", "data" for "Select Data..." — and
//          CreateChartDialog ignored the prop entirely, so the one menu item
//          whose whole purpose is the mark picker opened on the range editor.
//          Pivot mode does not RENDER a Data tab (the pivot is the source), so a
//          request for it there has to degrade rather than select a tab whose
//          button does not exist.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { resolveInitialTab } from "../CreateChartDialog";

const SOURCE = readFileSync(
  path.resolve(__dirname, "../CreateChartDialog.tsx"),
  "utf8",
);

describe("resolveInitialTab", () => {
  it("honours the tab the opener asked for", () => {
    expect(resolveInitialTab("design", false)).toBe("design");
    expect(resolveInitialTab("data", false)).toBe("data");
    expect(resolveInitialTab("spec", false)).toBe("spec");
  });

  it("falls back to Data when nothing was asked for", () => {
    expect(resolveInitialTab(undefined, false)).toBe("data");
    expect(resolveInitialTab(null, false)).toBe("data");
  });

  it("never lands on Data in pivot mode, where that tab is not rendered", () => {
    expect(resolveInitialTab("data", true)).toBe("design");
    expect(resolveInitialTab(undefined, true)).toBe("design");
  });

  it("keeps Design and Spec in pivot mode", () => {
    expect(resolveInitialTab("design", true)).toBe("design");
    expect(resolveInitialTab("spec", true)).toBe("spec");
  });

  it("ignores a tab id that does not exist", () => {
    expect(resolveInitialTab("formatting", false)).toBe("data");
    expect(resolveInitialTab(7, false)).toBe("data");
    expect(resolveInitialTab("formatting", true)).toBe("design");
  });
});

describe("the dialog is actually WIRED to it", () => {
  // A pure resolver nothing calls is the defect this item fixed, one level up:
  // the prop was already arriving and was already correct, and the component
  // simply never read it. So the open-effect's use of the resolver is pinned in
  // source, and so is the fact that `initialTab` is read off the dialog data at
  // all. Rendering this dialog in jsdom pulls the Monaco spec editor, the BI
  // connection list and the live preview canvas; the two lines that matter are
  // cheaper to hold here than a mocked mount is to maintain.
  it("reads initialTab off the dialog data", () => {
    expect(SOURCE).toContain('dialogData?.initialTab');
  });

  it("opens on the resolved tab rather than a hard-coded one", () => {
    expect(SOURCE).toContain("setActiveTab(resolveInitialTab(requestedTab, isPivotMode))");
    expect(SOURCE).not.toContain('setActiveTab(isPivotMode ? "design" : "data")');
  });
});
