//! FILENAME: app/extensions/CanvasSheet/__tests__/canvasTabPanel.test.tsx
// PURPOSE: The Canvas tab as a whole (CONTRACT-CANVAS section 1): its six
//          groups in Power BI's order -- Pages, Visuals, Elements, Arrange,
//          Page, View -- with the contract's fold order (View folds first,
//          Pages last); every control id the E2E specs and the contract name
//          is on the band; and no control is labelled exactly "Canvas" (the
//          E2E helpers find the TAB by that word). Also Pages > New Page.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";

const h = vi.hoisted(() => ({
  snapshot: { active: null as unknown, activeSubscribed: false, activeIndex: 2, version: 1 },
}));

vi.mock("../lib/canvasSheetStore", () => ({
  getCanvasSheetSnapshot: () => h.snapshot,
  subscribeCanvasSheets: () => () => {},
}));
vi.mock("@api/controlsService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/controlsService")>()),
  getControlsProvider: () => ({
    listShapeCatalog: () => [
      { id: "rectangle", label: "Rectangle", categoryId: "rectangles", categoryLabel: "Rectangles", defaultWidth: 160, defaultHeight: 100, isLine: false, thumbnail: { viewBox: "0 0 1 1", d: "M0 0 H1 V1 H0 Z" } },
    ],
  }),
}));

import type { PanelSectionProps } from "@api/uiTypes";
import { defaultCanvasLayout } from "@api/canvasSheet";
import { CanvasPanelDefinition } from "../components/CanvasTabSections";
import { CanvasPagesSection } from "../components/CanvasPagesSection";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { byTestId, click, drawsIcon, maybeTestId, mountHarness, type Harness } from "./tabHarness";

const PROPS = { placement: "ribbon" } as unknown as PanelSectionProps;

let hn: Harness;

beforeEach(() => {
  h.snapshot = {
    active: { index: 2, name: "Report", layout: defaultCanvasLayout() },
    activeSubscribed: false,
    activeIndex: 2,
    version: 1,
  };
  hn = mountHarness();
});

afterEach(() => hn.unmount());

function renderWholeTab(): void {
  hn.render(
    <div>
      {CanvasPanelDefinition.sections.map((s) => {
        const Section = s.component as React.ComponentType<PanelSectionProps>;
        return (
          <div key={s.id} data-section={s.id}>
            <Section {...PROPS} />
          </div>
        );
      })}
    </div>,
    "band",
  );
}

describe("the panel definition", () => {
  it("six groups in Power BI's order, with the contract's ids and labels", () => {
    expect(CanvasPanelDefinition.sections.map((s) => [s.id, s.label])).toEqual([
      ["canvas-tab.pages", "Pages"],
      ["canvas-tab.visuals", "Visuals"],
      ["canvas-tab.elements", "Elements"],
      ["canvas-tab.arrange", "Arrange"],
      ["canvas-tab.page", "Page"],
      ["canvas-tab.view", "View"],
    ]);
  });

  it("folds View first and Pages last (a lower collapsePriority folds first)", () => {
    expect(CanvasPanelDefinition.sections.map((s) => s.collapsePriority)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("is still the contextual Canvas tab: title, accent, activate on register", () => {
    expect(CanvasPanelDefinition.title).toBe("Canvas");
    expect(CanvasPanelDefinition.ribbonActivateOnRegister).toBe(true);
    expect(CanvasPanelDefinition.ribbonColor).toBe("var(--tab-accent-canvas, #b0245f)");
  });

  it("the tab and the folded groups draw report pictures, never Layout or a bare Plus", () => {
    hn.render(
      <div>
        <span data-k="tab">{CanvasPanelDefinition.icon}</span>
        {CanvasPanelDefinition.sections.map((s) => (
          <span key={s.id} data-k={s.id}>
            {s.icon}
          </span>
        ))}
      </div>,
    );
    const at = (k: string) => hn.container.querySelector(`[data-k="${k}"]`)!;
    expect(drawsIcon(at("tab"), "Report")).toBe(true);
    expect(drawsIcon(at("canvas-tab.pages"), "NewPage")).toBe(true);
    expect(drawsIcon(at("canvas-tab.visuals"), "ChartColumn")).toBe(true);
    expect(drawsIcon(at("canvas-tab.elements"), "Shapes")).toBe(true);
    expect(drawsIcon(at("canvas-tab.page"), "PageSize")).toBe(true);
    expect(drawsIcon(at("canvas-tab.view"), "FitToPage")).toBe(true);
    for (const k of ["tab", ...CanvasPanelDefinition.sections.map((s) => s.id)]) {
      expect(drawsIcon(at(k), "Layout"), k).toBe(false);
      expect(drawsIcon(at(k), "Plus"), k).toBe(false);
      expect(drawsIcon(at(k), "Gridlines"), k).toBe(false);
    }
  });
});

describe("the rendered tab", () => {
  // Kept from the old tab (live E2E specs and the contract press them).
  const KEPT = [
    "canvas-insert-pivot", "canvas-insert-slicer", "canvas-insert-floatingGrid", "canvas-insert-textBox",
    "canvas-insert-shape", "canvas-insert-picture", "canvas-insert-button",
    "canvas-arrange-forward", "canvas-arrange-backward", "canvas-arrange-align", "canvas-arrange-lock",
    "canvas-arrange-size-position",
    "canvas-snap-to-grid", "canvas-grid-size", "canvas-show-grid", "canvas-page-size", "canvas-page-background",
    "canvas-design-mode",
  ];
  // New in the contract.
  const NEW = [
    "canvas-new-page", "canvas-all-visuals", "canvas-buttons", "canvas-shapes", "canvas-page-wallpaper",
    "canvas-themes", "canvas-page-view", "canvas-lock-objects",
  ];

  it("carries every kept and every new control id", () => {
    renderWholeTab();
    for (const id of [...KEPT, ...NEW]) expect(maybeTestId(id, hn.container), id).not.toBeNull();
  });

  it("no control is labelled exactly 'Canvas'", () => {
    renderWholeTab();
    for (const el of hn.container.querySelectorAll<HTMLElement>("button, [role], input")) {
      expect((el.textContent ?? "").trim()).not.toBe("Canvas");
      expect(el.getAttribute("aria-label") ?? "").not.toBe("Canvas");
    }
  });

  it("each group renders into the band (no group is empty on a canvas)", () => {
    renderWholeTab();
    for (const s of CanvasPanelDefinition.sections) {
      const box = hn.container.querySelector(`[data-section="${s.id}"]`)!;
      expect(box.querySelector("button, input"), s.id).not.toBeNull();
    }
  });
});

describe("Pages > New Page", () => {
  // New Page runs the public sheet command (core.sheet.insert, a canvas at
  // the end); the recorded calls stand in for the strip.
  let seen: unknown[] = [];
  beforeEach(() => {
    seen = [];
    vi.spyOn(CommandRegistry, "execute").mockImplementation(async (id: string, args?: unknown) => {
      if (id === CoreCommands.SHEET_INSERT) seen.push(args);
      return undefined as never;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("a hero with the NewPage picture that adds a blank canvas page", () => {
    hn.render(<CanvasPagesSection {...PROPS} />, "band");
    const hero = byTestId("canvas-new-page", hn.container);
    expect(hero.textContent).toContain("New Page");
    expect(drawsIcon(hero, "NewPage")).toBe(true);
    click(hero);
    expect(seen).toEqual([{ kind: "canvas", atEnd: true }]);
  });

  it("works from a subscribed canvas too (a new page is not the publisher's layout)", () => {
    h.snapshot = { ...h.snapshot, activeSubscribed: true };
    hn.render(<CanvasPagesSection {...PROPS} />, "band");
    const hero = byTestId("canvas-new-page", hn.container);
    expect(hero.disabled).toBe(false);
    click(hero);
    expect(seen).toHaveLength(1);
  });

  it("is not shown off a canvas", () => {
    h.snapshot = { active: null, activeSubscribed: false, activeIndex: 0, version: 1 };
    hn.render(<CanvasPagesSection {...PROPS} />, "band");
    expect(hn.container.innerHTML).toBe("");
  });
});
