//! FILENAME: app/extensions/Reports/__tests__/reportTabSection.test.tsx
// PURPOSE: The contextual Report tab after the Calcula Clusters rebuild:
//          CommandButton heroes with RibbonIcons, a token accent, and no
//          hardcoded chrome colours on either surface.
// CONTEXT: Also pins the E2E contract the tab lives under — the tab itself is
//          found as the only <button> whose text is exactly "Report", so no hero
//          may carry that label — and that the old emoji / unicode glyph icons
//          are gone for good.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { ReportInfo } from "../types";

const REPORT: ReportInfo = {
  id: "r1",
  name: "Quarterly sales",
  dslText: "ROWS: Region",
  connectionId: "c1",
  sheetIndex: 0,
  anchorRow: 3,
  anchorCol: 1,
  endRow: 10,
  endCol: 4,
};

const mocks = vi.hoisted(() => ({
  activeReport: null as ReportInfo | null,
  showDialog: vi.fn(),
  refreshOneReport: vi.fn(),
  deleteReport: vi.fn(),
  refreshReportRegions: vi.fn(),
  confirmAsync: vi.fn(),
  alertAsync: vi.fn(),
}));

vi.mock("@api", () => ({ showDialog: mocks.showDialog }));
vi.mock("@api/dialogs", () => ({
  confirmAsync: mocks.confirmAsync,
  alertAsync: mocks.alertAsync,
}));
vi.mock("../lib/reportRefresh", () => ({
  refreshOneReport: mocks.refreshOneReport,
  deleteReport: mocks.deleteReport,
}));
vi.mock("../lib/reportRegions", () => ({ refreshReportRegions: mocks.refreshReportRegions }));
vi.mock("../lib/reportSelectionHandler", () => ({
  ACTIVE_REPORT_CHANGED: "reports:active-report-changed-test",
  getActiveReport: () => mocks.activeReport,
}));

import {
  ReportActionsSection,
  ReportInfoSection,
  ReportPanelDefinition,
} from "../components/ReportTabSection";
import { EDIT_DIALOG_ID, MANAGE_DIALOG_ID } from "../dialogIds";

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode, layout: SurfaceLayout): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function byTestId(id: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

/** Emoji and the old unicode glyph icons (pencil, arrows, trash, hamburger). */
const GLYPH_ICONS = /[\u{1F300}-\u{1FAFF}☀-➿↻☰✎]/u;

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.activeReport = REPORT;
  mocks.showDialog.mockReset();
  mocks.refreshOneReport.mockReset().mockResolvedValue({ ok: true });
  mocks.deleteReport.mockReset().mockResolvedValue(undefined);
  mocks.refreshReportRegions.mockReset().mockResolvedValue(undefined);
  mocks.confirmAsync.mockReset().mockReturnValue(Promise.resolve(false));
  mocks.alertAsync.mockReset().mockReturnValue(Promise.resolve());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Report tab — info section", () => {
  it.each(LAYOUTS)("shows the report and an Edit Query hero in the %s, token-painted", (_n, layout) => {
    render(<ReportInfoSection placement="ribbon" />, layout);

    expect(container.textContent).toContain("Quarterly sales");
    expect(container.textContent).toContain("at B4");
    const edit = byTestId("report-tab-edit-query");
    expect(edit.textContent).toBe("Edit Query");
    expect(edit.querySelector("svg")).not.toBeNull();
    expect(GLYPH_ICONS.test(container.textContent ?? "")).toBe(false);

    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("Edit Query opens the edit dialog for the active report", () => {
    render(<ReportInfoSection placement="ribbon" />, bandLayout());
    click(byTestId("report-tab-edit-query"));
    expect(mocks.showDialog).toHaveBeenCalledWith(EDIT_DIALOG_ID, { reportId: "r1" });
  });

  it("renders nothing without an active report", () => {
    mocks.activeReport = null;
    render(<ReportInfoSection placement="ribbon" />, bandLayout());
    expect(container.innerHTML).toBe("");
  });
});

describe("Report tab — actions section", () => {
  it.each(LAYOUTS)("renders Refresh / Delete / Manage heroes in the %s, token-painted", (_n, layout) => {
    render(<ReportActionsSection placement="ribbon" />, layout);

    const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Refresh", "Delete", "Manage"]);
    for (const b of Array.from(container.querySelectorAll("button"))) {
      expect(b.querySelector("svg")).not.toBeNull();
    }
    expect(GLYPH_ICONS.test(container.textContent ?? "")).toBe(false);
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("no hero in either section is labelled exactly 'Report' (the tab's E2E selector)", () => {
    render(
      <>
        <ReportInfoSection placement="ribbon" />
        <ReportActionsSection placement="ribbon" />
      </>,
      bandLayout(),
    );
    const exact = Array.from(container.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === "Report",
    );
    expect(exact).toHaveLength(0);
  });

  it("Refresh re-runs the report and refreshes the region cache", async () => {
    render(<ReportActionsSection placement="ribbon" />, bandLayout());
    click(byTestId("report-tab-refresh"));
    await flush();
    expect(mocks.refreshOneReport).toHaveBeenCalledWith(REPORT);
    expect(mocks.refreshReportRegions).toHaveBeenCalled();
  });

  it("Delete asks first and does nothing on refusal (the Tauri Promise shape)", async () => {
    render(<ReportActionsSection placement="ribbon" />, bandLayout());
    click(byTestId("report-tab-delete"));
    await flush();
    expect(mocks.confirmAsync).toHaveBeenCalled();
    expect(mocks.deleteReport).not.toHaveBeenCalled();
  });

  it("Delete deletes on consent", async () => {
    mocks.confirmAsync.mockReturnValue(Promise.resolve(true));
    render(<ReportActionsSection placement="ribbon" />, bandLayout());
    click(byTestId("report-tab-delete"));
    await flush();
    await flush();
    expect(mocks.deleteReport).toHaveBeenCalledWith("r1");
  });

  it("Manage opens the manage dialog", () => {
    render(<ReportActionsSection placement="ribbon" />, bandLayout());
    click(byTestId("report-tab-manage"));
    expect(mocks.showDialog).toHaveBeenCalledWith(MANAGE_DIALOG_ID, {});
  });
});

describe("Report tab — panel definition", () => {
  it("uses the report accent token with the old green as its fallback", () => {
    expect(ReportPanelDefinition.ribbonColor).toBe("var(--tab-accent-report, #2e7d5b)");
  });

  it("carries a panel icon and a RibbonIcon (never an emoji string) on every section", () => {
    expect(React.isValidElement(ReportPanelDefinition.icon)).toBe(true);
    for (const section of ReportPanelDefinition.sections) {
      expect(React.isValidElement(section.icon)).toBe(true);
      expect(typeof section.icon).not.toBe("string");
    }
  });
});
