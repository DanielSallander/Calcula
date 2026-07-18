// Regression tests for the ribbon width-fit system: every inline-rendered
// section — declared "inline" AND default "auto" — must report its natural
// width, every CELL (inline or launcher) must report its real rendered width,
// and the strip-level collapse must fold sections into launchers whenever the
// modeled or REAL total exceeds the band. The original bug class: strips
// dominated by wide sections (the contextual Chart Design tab) overflowed the
// window instead of folding, because launcher cells were modeled at a 64px
// token while really rendering ~2x wider, and nothing checked the DOM truth.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SectionCell } from "../SectionCell";
import { SectionRibbonRenderer, clearSectionWidthCaches } from "../SectionRenderers";
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
    const target = this.observed[0];
    act(() => {
      this.callback(
        [{ contentRect: size, target } as unknown as ResizeObserverEntry],
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
  clearSectionWidthCaches();
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

/** The active observer watching a given element, if any. */
function observerOf(el: Element | null | undefined): MockResizeObserver | undefined {
  if (!el) return undefined;
  return MockResizeObserver.instances.find((o) => o.observed.includes(el));
}

/** Active observers on inline natural-width sizers (data-section-sizer). */
function sizerProbes(): MockResizeObserver[] {
  return MockResizeObserver.instances.filter((o) =>
    o.observed.some((el) => el.hasAttribute("data-section-sizer")),
  );
}

/** The sizer observer of the idx-th currently-inline cell, in DOM order. */
function sizerProbeAt(idx: number): MockResizeObserver {
  const sizers = Array.from(container.querySelectorAll("[data-section-sizer]"));
  const probe = observerOf(sizers[idx]);
  if (!probe) throw new Error(`no sizer probe at index ${idx}`);
  return probe;
}

/** The cell-width observer of the idx-th cell (inline OR launcher), DOM order. */
function cellProbeAt(idx: number): MockResizeObserver {
  const cells = Array.from(container.querySelectorAll("[data-section-cell]"));
  const probe = observerOf(cells[idx]);
  if (!probe) throw new Error(`no cell probe at index ${idx}`);
  return probe;
}

/** The strip container's own width observer. */
function stripObserver(): MockResizeObserver {
  const probe = observerOf(container.firstElementChild);
  if (!probe) throw new Error("no strip observer");
  return probe;
}

// ============================================================================
// SectionCell: per-presentation probe behavior
// ============================================================================

describe("SectionCell width probe", () => {
  it('reports natural width for a declared-"inline" section (regression)', () => {
    const widths: Array<[string, number]> = [];
    renderCell(makeSection("inline-a", "inline"), (id, w) => widths.push([id, w]));

    const probe = sizerProbes()[0];
    expect(probe).toBeDefined();
    probe.fire({ width: 340, height: 60 });
    expect(widths).toContainEqual(["inline-a", 340]);
  });

  it('never height-demotes an "inline" section, even when it measures tall', () => {
    renderCell(makeSection("inline-b", "inline"), () => {});
    sizerProbes()[0].fire({ width: 200, height: 400 });
    expect(launcherFor("inline-b")).toBeNull();
  });

  it('height-demotes a too-tall "auto" section, after reporting its width', () => {
    const widths: number[] = [];
    renderCell(makeSection("auto-a", "auto"), (_id, w) => widths.push(w));
    sizerProbes()[0].fire({ width: 200, height: 400 });
    expect(widths).toContain(200);
    expect(launcherFor("auto-a")).not.toBeNull();
  });

  it('renders an "inline" section as a launcher when the renderer width-demotes it', () => {
    renderCell(makeSection("inline-c", "inline"), () => {}, true);
    expect(launcherFor("inline-c")).not.toBeNull();
  });

  it('never probes the content of a declared-"launcher" section', () => {
    renderCell(makeSection("launcher-a", "launcher"), () => {});
    // The inline content never mounts, so there is no natural-width sizer;
    // the CELL itself is still measured (its real launcher width feeds the
    // strip's width math).
    expect(sizerProbes().length).toBe(0);
    expect(container.querySelectorAll("[data-section-sizer]").length).toBe(0);
    expect(launcherFor("launcher-a")).not.toBeNull();
  });
});

// ============================================================================
// SectionRibbonRenderer: strip-level width collapse
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

    // The fix: declared-inline sections are probed too (3 sizers, not 1).
    expect(sizerProbes().length).toBe(3);

    // Measure everything at a generous width first: all sections stay inline.
    stripObserver().fire({ width: 2000, height: 92 });
    sizerProbeAt(0).fire({ width: 340, height: 60 }); // type (inline, wide)
    sizerProbeAt(1).fire({ width: 180, height: 60 }); // elements (auto)
    sizerProbeAt(2).fire({ width: 240, height: 60 }); // colors (inline, wide)
    expect(launcherFor("type")).toBeNull();
    expect(launcherFor("elements")).toBeNull();
    expect(launcherFor("colors")).toBeNull();

    // Shrink the band: measured totals (incl. cell chrome) exceed 500px, so
    // the two lowest collapsePriority sections — colors(4) then elements(5),
    // one of each presentation — must fold; type(6) stays inline.
    stripObserver().fire({ width: 500, height: 92 });
    expect(launcherFor("colors")).not.toBeNull();
    expect(launcherFor("elements")).not.toBeNull();
    expect(launcherFor("type")).toBeNull();
  });

  it("re-runs demotion when measurements arrive AFTER the band width is known", () => {
    // Task scenario (a): sections registered with no measurements yet. The
    // optimistic pre-measure model must not overflow-lock: once the probes
    // report, the collapse must re-run and fold.
    const sections: PanelSection[] = [
      makeSection("wide-a", "inline", 2),
      makeSection("wide-b", "auto", 1),
    ];
    act(() => {
      root.render(<SectionRibbonRenderer sections={sections} panelId="p-late" />);
    });

    // Band width arrives first; nothing measured -> optimistic, all inline.
    stripObserver().fire({ width: 400, height: 92 });
    expect(launcherFor("wide-a")).toBeNull();
    expect(launcherFor("wide-b")).toBeNull();

    // Natural widths arrive late: 321 + 321 > 400 -> wide-b (priority 1)
    // folds; wide-a (321) + launcher (64) fits.
    sizerProbeAt(0).fire({ width: 300, height: 60 });
    sizerProbeAt(1).fire({ width: 300, height: 60 });
    expect(launcherFor("wide-b")).not.toBeNull();
    expect(launcherFor("wide-a")).toBeNull();
  });

  it("window shrink demotes progressively more", () => {
    // Task scenario (b).
    const sections: PanelSection[] = [
      makeSection("s1", "inline", 3),
      makeSection("s2", "auto", 2),
      makeSection("s3", "auto", 1),
    ];
    act(() => {
      root.render(<SectionRibbonRenderer sections={sections} panelId="p-shrink" />);
    });

    stripObserver().fire({ width: 2000, height: 92 });
    sizerProbeAt(0).fire({ width: 300, height: 60 });
    sizerProbeAt(1).fire({ width: 300, height: 60 });
    sizerProbeAt(2).fire({ width: 300, height: 60 });
    expect(container.querySelectorAll("[data-testid^='section-launcher-']").length).toBe(0);

    // 3 x 321 = 963 > 700: fold s3 -> 321 + 321 + 64 = 706 > 700: fold s2 too
    // -> 321 + 64 + 64 = 449 fits.
    stripObserver().fire({ width: 700, height: 92 });
    expect(launcherFor("s3")).not.toBeNull();
    expect(launcherFor("s2")).not.toBeNull();
    expect(launcherFor("s1")).toBeNull();

    // Shrink further: everything demotable folds.
    stripObserver().fire({ width: 260, height: 92 });
    expect(launcherFor("s1")).not.toBeNull();
    expect(launcherFor("s2")).not.toBeNull();
    expect(launcherFor("s3")).not.toBeNull();
  });

  it("a tab 3x wider than the band folds everything demotable, high priority included", () => {
    // Task scenario (c): no demotion floor — even a collapsePriority-100
    // "keep me inline" section folds when that is what fitting takes.
    const sections: PanelSection[] = [
      makeSection("g1", "inline", 100),
      makeSection("g2", "auto", 3),
      makeSection("g3", "inline", 2),
      makeSection("g4", "auto", 1),
    ];
    act(() => {
      root.render(<SectionRibbonRenderer sections={sections} panelId="p-3x" />);
    });

    stripObserver().fire({ width: 500, height: 92 });
    for (let i = 0; i < 4; i++) {
      sizerProbeAt(0).fire({ width: 480, height: 60 });
    }
    // Each section wants ~501px in a 500px band: all four must be launchers
    // (4 x 64 = 256 fits), and no inline sizer remains mounted.
    expect(launcherFor("g1")).not.toBeNull();
    expect(launcherFor("g2")).not.toBeNull();
    expect(launcherFor("g3")).not.toBeNull();
    expect(launcherFor("g4")).not.toBeNull();
    expect(container.querySelectorAll("[data-section-sizer]").length).toBe(0);
  });

  it("measured real launcher widths demote MORE than the 64px token (root-cause regression)", () => {
    // THE Chart Design bug: launchers really render ~2x the 64px token. With
    // b folded and modeled at 64 the strip "fits" (300+21+64 = 385 <= 500 is
    // false here: 321+64 = 385... use numbers that flip the verdict).
    const sections: PanelSection[] = [
      makeSection("a", "inline", 2),
      makeSection("b", "auto", 1),
    ];
    act(() => {
      root.render(<SectionRibbonRenderer sections={sections} panelId="p-real" />);
    });

    stripObserver().fire({ width: 500, height: 92 });
    sizerProbeAt(0).fire({ width: 340, height: 60 }); // a: demand 361
    sizerProbeAt(1).fire({ width: 300, height: 60 }); // b: demand 321
    // 361 + 321 = 682 > 500 -> fold b; at the 64px token 361 + 64 = 425 "fits".
    expect(launcherFor("b")).not.toBeNull();
    expect(launcherFor("a")).toBeNull();

    // Now b's REAL launcher cell reports 220px: 361 + 220 = 581 > 500, so the
    // model must fold a as well (a-launcher unmeasured -> 64; 64 + 220 fits).
    // Cell order in the DOM: a first, b second.
    cellProbeAt(1).fire({ width: 220, height: 92 });
    expect(launcherFor("a")).not.toBeNull();
    expect(launcherFor("b")).not.toBeNull();
  });

  it("never demotes a section narrower than its launcher (no-savings guard)", () => {
    const sections: PanelSection[] = [
      makeSection("tiny", "inline", 1), // 40px natural + 21 chrome = 61 < 64 launcher
      makeSection("big", "auto", 2),
    ];
    act(() => {
      root.render(<SectionRibbonRenderer sections={sections} panelId="p-tiny" />);
    });

    stripObserver().fire({ width: 100, height: 92 });
    sizerProbeAt(0).fire({ width: 40, height: 60 });
    sizerProbeAt(1).fire({ width: 400, height: 60 });
    // big folds (its launcher is narrower); tiny folding would GROW the strip,
    // so it stays inline even though the total still exceeds the band.
    expect(launcherFor("big")).not.toBeNull();
    expect(launcherFor("tiny")).toBeNull();
  });

  it("DOM-truth backstop: folds more when the strip really overflows despite the model", () => {
    const sections: PanelSection[] = [
      makeSection("m1", "inline", 2),
      makeSection("m2", "auto", 1),
    ];
    act(() => {
      root.render(<SectionRibbonRenderer sections={sections} panelId="p-dom" />);
    });

    stripObserver().fire({ width: 500, height: 92 });
    sizerProbeAt(0).fire({ width: 200, height: 60 });
    sizerProbeAt(1).fire({ width: 200, height: 60 });
    // Model: 221 + 221 = 442 <= 500 -> nothing folds.
    expect(container.querySelectorAll("[data-testid^='section-launcher-']").length).toBe(0);

    // Reality disagrees (fonts, chrome drift, lost probe): the strip's DOM
    // reports overflowing content. The next pass must escalate demotions.
    const strip = container.firstElementChild as HTMLElement;
    Object.defineProperty(strip, "scrollWidth", { value: 700, configurable: true });
    Object.defineProperty(strip, "clientWidth", { value: 500, configurable: true });
    // Any re-render triggers the layout-effect check; a 1px-different width
    // report is the cheapest realistic trigger.
    sizerProbeAt(0).fire({ width: 202, height: 60 });

    // The static mock keeps claiming overflow, so escalation runs to the cap:
    // everything demotable folds — and never oscillates back.
    expect(launcherFor("m2")).not.toBeNull();
    expect(launcherFor("m1")).not.toBeNull();
  });

  it("a re-registered tab computes demotions on its FIRST render from remembered widths", () => {
    // Task scenario (a)/(re-register): contextual tabs (Chart Design) remount
    // on selection changes. The remount must not paint an overflowing strip
    // while waiting for probes — remembered widths + band width fold known
    // sections immediately.
    const sections: PanelSection[] = [
      makeSection("r-a", "inline", 2),
      makeSection("r-b", "auto", 1),
    ];
    act(() => {
      root.render(<SectionRibbonRenderer sections={sections} panelId="p-remount" />);
    });

    stripObserver().fire({ width: 400, height: 92 });
    // Report real rendered CELL widths (the cache-fed channel).
    cellProbeAt(0).fire({ width: 321, height: 92 });
    cellProbeAt(1).fire({ width: 321, height: 92 });
    // 642 > 400 -> r-b folds.
    expect(launcherFor("r-b")).not.toBeNull();

    // Unmount (tab unregisters) and remount fresh (tab re-registers).
    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <SectionRibbonRenderer
          sections={sections.map((s) => ({ ...s }))}
          panelId="p-remount"
        />,
      );
    });

    // NO observer has fired for the new mount: the first render alone must
    // already fold r-b (remembered band width 400 + remembered cell widths).
    expect(launcherFor("r-b")).not.toBeNull();
    expect(launcherFor("r-a")).toBeNull();
  });
});
