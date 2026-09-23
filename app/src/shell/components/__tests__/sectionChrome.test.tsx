// The ribbon CLUSTER chrome (SectionChrome) and the two renderers built on it.
//
// Contracts pinned here:
// - [data-section-cell]'s lastElementChild is the caption text, in BOTH label
//   modes and for launcher cells too (shapes-hometab and the width probes read
//   a cell's label that way);
// - the card is role=group named by the label, and carries the label as its
//   title only while captions are hidden;
// - captionMode "always" keeps the caption through the hide preference;
// - cellChromeWidth is the card padding plus the gap unless last;
// - nothing the chrome renders paints with a hardcoded colour, in a band or a
//   panel layout.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SectionChrome, cellChromeWidth } from "../SectionChrome";
import { SectionCell } from "../SectionCell";
import { SectionSidebarRenderer, clearSectionWidthCaches } from "../SectionRenderers";
import { clearSectionFitCache } from "../useSectionFit";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  CLUSTER_GAP,
  CLUSTER_PAD,
} from "../../../api/layout";
import { setRibbonLabelMode } from "../../../api/appearance";
import { RibbonIcon } from "../../../api/ribbonIcons";
import type { PanelSection, SectionRibbonPresentation } from "../../../api/uiTypes";

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  clearSectionFitCache();
  clearSectionWidthCaches();
  setRibbonLabelMode("show");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  setRibbonLabelMode("show");
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function render(node: React.ReactElement): void {
  act(() => {
    root.render(node);
  });
}

function cell(): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-section-cell]");
  if (!el) throw new Error("no [data-section-cell]");
  return el;
}

function card(): HTMLElement {
  return cell().firstElementChild as HTMLElement;
}

function caption(): HTMLElement {
  return cell().lastElementChild as HTMLElement;
}

/** The declared rule text of every class on an element (jsdom's computed
 *  style resolves plain lengths, but reading the rule is the stable check). */
function ruleTextFor(el: Element): string {
  const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  document.querySelectorAll("style").forEach((s) => {
    const sheet = (s as HTMLStyleElement).sheet;
    const texts: string[] = [];
    if (s.textContent) texts.push(s.textContent);
    if (sheet) {
      try {
        for (const r of Array.from(sheet.cssRules)) texts.push(r.cssText);
      } catch {
        /* detached */
      }
    }
    for (const t of texts) {
      for (const c of classes) if (t.includes(`.${c}`)) out.push(t);
    }
  });
  return out.join("\n");
}

function Body(): React.ReactElement {
  return <div data-testid="body">content</div>;
}

function section(
  id: string,
  presentation: SectionRibbonPresentation = "inline",
  extra: Partial<PanelSection> = {},
): PanelSection {
  return {
    id,
    label: `Label ${id}`,
    icon: <RibbonIcon.Group size={24} />,
    component: Body,
    ribbonPresentation: presentation,
    ...extra,
  };
}

// ============================================================================
// cellChromeWidth
// ============================================================================

describe("cellChromeWidth", () => {
  it("is 2 * CLUSTER_PAD + CLUSTER_GAP, without the gap on the last cell", () => {
    expect(cellChromeWidth(true, false)).toBe(2 * CLUSTER_PAD + CLUSTER_GAP);
    expect(cellChromeWidth(false, false)).toBe(2 * CLUSTER_PAD + CLUSTER_GAP);
    expect(cellChromeWidth(false, true)).toBe(2 * CLUSTER_PAD);
    expect(cellChromeWidth(true, true)).toBe(2 * CLUSTER_PAD);
  });

  it("is 22 / 16 at today's tokens", () => {
    expect(cellChromeWidth(false, false)).toBe(22);
    expect(cellChromeWidth(false, true)).toBe(16);
  });
});

// ============================================================================
// SectionChrome DOM
// ============================================================================

describe("SectionChrome", () => {
  it("renders cell > card[role=group][aria-label] + caption, caption LAST", () => {
    render(
      <SectionChrome label="Font" isFirst isLast={false}>
        <Body />
      </SectionChrome>,
    );
    expect(cell().children).toHaveLength(2);
    expect(card().getAttribute("role")).toBe("group");
    expect(card().getAttribute("aria-label")).toBe("Font");
    expect(card().querySelector("[data-testid='body']")).not.toBeNull();
    expect(caption().textContent).toBe("Font");
    // Captions are shown by default, so the card needs no title.
    expect(card().hasAttribute("title")).toBe(false);
  });

  it("puts the cluster gap INSIDE the cell (padding-right), none on the last cell", () => {
    render(
      <>
        <SectionChrome label="A" isFirst isLast={false}>
          <Body />
        </SectionChrome>
        <SectionChrome label="B" isFirst={false} isLast>
          <Body />
        </SectionChrome>
      </>,
    );
    const cells = container.querySelectorAll<HTMLElement>("[data-section-cell]");
    expect(cells[0].style.paddingRight).toBe(`${CLUSTER_GAP}px`);
    expect(cells[1].style.paddingRight).toBe("0px");
  });

  it("pads the card on all four sides and paints it with cluster tokens", () => {
    render(
      <SectionChrome label="Font" isFirst isLast>
        <Body />
      </SectionChrome>,
    );
    const rules = ruleTextFor(card());
    expect(rules).toMatch(new RegExp(`padding:\\s*${CLUSTER_PAD}px`));
    expect(rules).toContain("--ribbon-cluster-bg");
    expect(rules).toContain("--radius-cluster");
    expect(rules).toContain("--ribbon-cluster-border-hover");
    // The divider of the old chrome is gone.
    expect(cell().getAttribute("style") ?? "").not.toMatch(/border-image|linear-gradient/);
  });

  it("styles the caption 11px/500 on 13px in the group-label token", () => {
    render(
      <SectionChrome label="Font" isFirst isLast>
        <Body />
      </SectionChrome>,
    );
    const rules = ruleTextFor(caption());
    expect(rules).toMatch(/font-size:\s*11px/);
    expect(rules).toMatch(/font-weight:\s*500/);
    expect(rules).toMatch(/line-height:\s*13px/);
    expect(rules).toContain("--ribbon-group-label-fg");
  });

  it("hide mode: the caption stays the last child with its text, collapses, and the card takes a title", () => {
    setRibbonLabelMode("hide");
    render(
      <SectionChrome label="Alignment" isFirst isLast>
        <Body />
      </SectionChrome>,
    );
    expect(caption().textContent).toBe("Alignment");
    expect(cell().lastElementChild).toBe(caption());
    expect(card().getAttribute("title")).toBe("Alignment");
    expect(card().getAttribute("aria-label")).toBe("Alignment");
    expect(getComputedStyle(caption()).height).toBe("0px");
  });

  it("follows the preference LIVE, both ways", () => {
    render(
      <SectionChrome label="Number" isFirst isLast>
        <Body />
      </SectionChrome>,
    );
    expect(card().hasAttribute("title")).toBe(false);
    act(() => setRibbonLabelMode("hide"));
    expect(card().getAttribute("title")).toBe("Number");
    expect(getComputedStyle(caption()).height).toBe("0px");
    expect(caption().textContent).toBe("Number");
    act(() => setRibbonLabelMode("show"));
    expect(card().hasAttribute("title")).toBe(false);
    expect(getComputedStyle(caption()).height).not.toBe("0px");
  });

  it('captionMode "always" keeps the caption visible when labels are hidden', () => {
    setRibbonLabelMode("hide");
    render(
      <SectionChrome label="From: Acme Add-in" isFirst isLast captionMode="always">
        <Body />
      </SectionChrome>,
    );
    expect(caption().textContent).toBe("From: Acme Add-in");
    expect(card().hasAttribute("title")).toBe(false);
    expect(getComputedStyle(caption()).height).not.toBe("0px");
  });

  for (const [name, layout] of [
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ] as const) {
    it(`paints no hardcoded colour (${name} layout, both label modes)`, () => {
      render(
        <SurfaceLayoutProvider value={layout}>
          <SectionChrome label="Clipboard" isFirst isLast={false}>
            <Body />
          </SectionChrome>
        </SurfaceLayoutProvider>,
      );
      expect(findHardcodedColours(container)).toEqual([]);
      act(() => setRibbonLabelMode("hide"));
      expect(findHardcodedColours(container)).toEqual([]);
    });
  }
});

// ============================================================================
// SectionCell: both forms keep the caption contract
// ============================================================================

describe("SectionCell in cluster chrome", () => {
  function renderCell(s: PanelSection, widthDemoted = false): void {
    render(
      <SectionCell
        panelId="chrome-test"
        section={s}
        isFirst
        isLast
        widthDemoted={widthDemoted}
        onNaturalWidth={() => {}}
      />,
    );
  }

  it("inline: the content sits in the card, the caption is the section label", () => {
    renderCell(section("inline"));
    expect(card().querySelector("[data-section-sizer]")).not.toBeNull();
    expect(caption().textContent).toBe("Label inline");
  });

  it("launcher: the launcher sits in the card and the caption is STILL the section label", () => {
    renderCell(section("launched", "launcher"));
    expect(card().querySelector("[data-testid='section-launcher-launched']")).not.toBeNull();
    expect(cell().lastElementChild?.textContent).toBe("Label launched");
  });

  it("width-demoted: same contract", () => {
    renderCell(section("narrow"), true);
    expect(card().querySelector("[data-testid='section-launcher-narrow']")).not.toBeNull();
    expect(cell().lastElementChild?.textContent).toBe("Label narrow");
  });

  it("passes captionMode through from the section", () => {
    setRibbonLabelMode("hide");
    renderCell(section("addins", "inline", { captionMode: "always" }));
    expect(card().hasAttribute("title")).toBe(false);
    expect(getComputedStyle(caption()).height).not.toBe("0px");
  });

  for (const [name, form] of [
    ["inline", section("c-inline")],
    ["launcher", section("c-launcher", "launcher")],
  ] as const) {
    it(`paints no hardcoded colour (${name})`, () => {
      renderCell(form);
      expect(findHardcodedColours(container)).toEqual([]);
    });
  }
});

// ============================================================================
// SectionSidebarRenderer: the sidebar transposition
// ============================================================================

describe("SectionSidebarRenderer headers", () => {
  it("renders a sentence-case header row with the section icon and a rotating chevron", () => {
    render(<SectionSidebarRenderer sections={[section("one"), section("two")]} />);
    const headers = container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
    expect(headers).toHaveLength(2);
    const first = headers[0];
    expect(first.textContent).toBe("Label one");
    expect(first.getAttribute("aria-expanded")).toBe("true");
    // The icon is rendered (sized to 22 by its wrapper) and hidden from AT.
    expect(first.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
    const rules = ruleTextFor(first);
    expect(rules).toMatch(/font-size:\s*12px/);
    expect(rules).toMatch(/font-weight:\s*600/);
    expect(rules).toMatch(/height:\s*36px/);
    expect(rules).not.toMatch(/text-transform:\s*uppercase/);
    expect(rules).not.toMatch(/letter-spacing/);
  });

  it("collapses and expands a section", () => {
    render(<SectionSidebarRenderer sections={[section("one"), section("two")]} />);
    const first = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(container.querySelectorAll("[data-testid='body']")).toHaveLength(2);
    act(() => first.click());
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll("[data-testid='body']")).toHaveLength(1);
    act(() => first.click());
    expect(container.querySelectorAll("[data-testid='body']")).toHaveLength(2);
  });

  it("keeps a single-section panel chrome-less", () => {
    render(<SectionSidebarRenderer sections={[section("solo")]} />);
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
    expect(container.querySelector("[data-testid='body']")).not.toBeNull();
  });

  it("paints no hardcoded colour", () => {
    render(<SectionSidebarRenderer sections={[section("one"), section("two")]} />);
    expect(findHardcodedColours(container)).toEqual([]);
  });
});
