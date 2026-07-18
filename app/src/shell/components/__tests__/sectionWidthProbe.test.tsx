// Regression tests for the ribbon width-fit probe: every inline-rendered
// section — declared "inline" AND default "auto" — must report its natural
// width to the renderer. When declared-inline sections were skipped, the
// width-overflow collapse under-counted them at launcher width and strips
// dominated by wide inline sections (the contextual Chart Design tab)
// overflowed the window instead of folding sections into launchers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SectionCell } from "../SectionCell";
import { SectionRibbonRenderer } from "../SectionRenderers";
import { clearSectionFitCache } from "../useSectionFit";
import type { PanelSection, SectionRibbonPresentation } from "../../../api/uiTypes";

// ============================================================================
// ResizeObserver mock (jsdom has none): capture instances, fire manually
// ============================================================================

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  observed: Element[] = [];
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(el: Element): void {
    this.observed = this.observed.filter((o) => o !== el);
  }
  disconnect(): void {
    this.observed = [];
  }
  /** Fire a size for the observed element; no-op once disconnected. */
  fire(size: { width: number; height: number }): void {
    if (this.observed.length === 0) return;
    act(() => {
      this.callback(
        [{ contentRect: size } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    });
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  MockResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  clearSectionFitCache();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// ============================================================================
// Helpers
// ============================================================================

function Content(): React.ReactElement {
  return <div>content</div>;
}

function makeSection(
  id: string,
  presentation: SectionRibbonPresentation,
  collapsePriority?: number,
): PanelSection {
  return {
    id,
    label: id,
    component: Content,
    ribbonPresentation: presentation,
    ...(collapsePriority !== undefined ? { collapsePriority } : {}),
  };
}

function renderCell(
  section: PanelSection,
  onNaturalWidth: (id: string, w: number) => void,
  widthDemoted = false,
): void {
  act(() => {
    root.render(
      <SectionCell
        panelId="test-panel"
        section={section}
        isFirst
        isLast
        widthDemoted={widthDemoted}
        onNaturalWidth={onNaturalWidth}
      />,
    );
  });
}

function launcherFor(id: string): Element | null {
  return container.querySelector(`[data-testid="section-launcher-${id}"]`);
}

function activeProbes(): MockResizeObserver[] {
  return MockResizeObserver.instances.filter((o) => o.observed.length > 0);
}

// ============================================================================
// SectionCell: per-presentation probe behavior
// ============================================================================

describe("SectionCell width probe", () => {
  it('reports natural width for a declared-"inline" section (regression)', () => {
    const widths: Array<[string, number]> = [];
    renderCell(makeSection("inline-a", "inline"), (id, w) => widths.push([id, w]));

    const probe = activeProbes()[0];
    expect(probe).toBeDefined();
    probe.fire({ width: 340, height: 60 });
    expect(widths).toContainEqual(["inline-a", 340]);
  });

  it('never height-demotes an "inline" section, even when it measures tall', () => {
    renderCell(makeSection("inline-b", "inline"), () => {});
    activeProbes()[0].fire({ width: 200, height: 400 });
    expect(launcherFor("inline-b")).toBeNull();
  });

  it('height-demotes a too-tall "auto" section, after reporting its width', () => {
    const widths: number[] = [];
    renderCell(makeSection("auto-a", "auto"), (_id, w) => widths.push(w));
    activeProbes()[0].fire({ width: 200, height: 400 });
    expect(widths).toContain(200);
    expect(launcherFor("auto-a")).not.toBeNull();
  });

  it('renders an "inline" section as a launcher when the renderer width-demotes it', () => {
    renderCell(makeSection("inline-c", "inline"), () => {}, true);
    expect(launcherFor("inline-c")).not.toBeNull();
  });

  it('never probes a declared-"launcher" section', () => {
    renderCell(makeSection("launcher-a", "launcher"), () => {});
    expect(activeProbes().length).toBe(0);
    expect(launcherFor("launcher-a")).not.toBeNull();
  });
});

// ============================================================================
// SectionRibbonRenderer: strip-level width collapse counts inline sections
// ============================================================================

describe("SectionRibbonRenderer width collapse", () => {
  it("folds lowest-priority sections when inline widths overflow the band", () => {
    const sections: PanelSection[] = [
      makeSection("type", "inline", 6),
      makeSection("elements", "auto", 5),
      makeSection("colors", "inline", 4),
    ];
    act(() => {
      root.render(<SectionRibbonRenderer sections={sections} panelId="p" />);
    });

    const stripEl = container.firstElementChild as Element;
    const stripObserver = MockResizeObserver.instances.find((o) =>
      o.observed.includes(stripEl),
    );
    expect(stripObserver).toBeDefined();
    const probes = MockResizeObserver.instances.filter(
      (o) => o !== stripObserver && o.observed.length > 0,
    );
    // The fix: declared-inline sections are probed too (3 probes, not 1).
    expect(probes.length).toBe(3);

    // Measure everything at a generous width first: all sections stay inline.
    stripObserver!.fire({ width: 2000, height: 92 });
    probes[0].fire({ width: 340, height: 60 }); // type (inline, wide)
    probes[1].fire({ width: 180, height: 60 }); // elements (auto)
    probes[2].fire({ width: 240, height: 60 }); // colors (inline, wide)
    expect(launcherFor("type")).toBeNull();
    expect(launcherFor("elements")).toBeNull();
    expect(launcherFor("colors")).toBeNull();

    // Shrink the band: measured totals (incl. cell chrome) exceed 500px, so
    // the two lowest collapsePriority sections — colors(4) then elements(5),
    // one of each presentation — must fold; type(6) stays inline.
    stripObserver!.fire({ width: 500, height: 92 });
    expect(launcherFor("colors")).not.toBeNull();
    expect(launcherFor("elements")).not.toBeNull();
    expect(launcherFor("type")).toBeNull();
  });
});
