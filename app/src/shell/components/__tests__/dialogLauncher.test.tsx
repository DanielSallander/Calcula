// Group DIALOG LAUNCHERS (Home tab = Excel's Home tab, CONTRACT 6.5): a section
// declares `dialogLauncher` and the SHELL draws Excel's small corner-arrow
// button for it — never the section itself, so every surface the section can
// land on shows the same door:
//
// - the ribbon caption cell: bottom-right, a SIBLING between the card and the
//   caption, so the caption stays the cell's LAST element child (shapes-hometab,
//   ribbon-tabs and the width probes read a cell's label that way) and stays
//   centred (symmetric caption padding, only while a launcher is present);
// - hidden group labels: the caption collapses to zero height, but the launcher
//   is not inside it, so it stays on screen and reachable (it moves into the
//   card's free bottom strip);
// - a COLLAPSED group: the launcher moves to the launcher flyout's heading (the
//   collapsed cell itself keeps its exact width and DOM);
// - the sidebar: a SIBLING of the section's header button (a button cannot
//   contain a button).
//
// And the guard the goldens depend on: a section WITHOUT a launcher renders
// exactly as before — no extra element, no positioning context, no caption
// padding — so nothing in today's ribbon moves by a pixel.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The tooltip chip is read from the live keybinding registry; pinned here to
// the one binding the launchers name (Format Cells, Ctrl+1) so the test does
// not depend on the registry being initialised.
vi.mock("../../../api/keybindings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const bindings = [{ id: "core.formatCells", combo: "Ctrl+1", commandId: "core.format.cells" }];
  return {
    ...actual,
    getEffectiveCombo: (id: string) => bindings.find((b) => b.id === id)?.combo ?? "",
    getAllKeybindings: () => bindings,
  };
});

import { SectionChrome, dialogLauncherTestId } from "../SectionChrome";
import { SectionCell } from "../SectionCell";
import { SectionSidebarRenderer, clearSectionWidthCaches } from "../SectionRenderers";
import { clearSectionFitCache } from "../useSectionFit";
import {
  Launcher,
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  CLUSTER_GAP,
  TOOLTIP_DELAY_MS,
} from "../../../api/layout";
import {
  DIALOG_LAUNCHER_CAPTION_PAD,
  DIALOG_LAUNCHER_HEIGHT,
  DIALOG_LAUNCHER_HIDDEN_INSET,
  DIALOG_LAUNCHER_WIDTH,
} from "../../../api/layout/primitives/Launcher";
import { setRibbonLabelMode } from "../../../api/appearance";
import { RibbonIcon } from "../../../api/ribbonIcons";
import type {
  PanelSection,
  PanelSectionDialogLauncher,
  SectionRibbonPresentation,
} from "../../../api/uiTypes";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// ============================================================================
// Helpers
// ============================================================================

function render(node: React.ReactElement): void {
  act(() => {
    root.render(node);
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

function launchers(scope: ParentNode = document): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("[data-dialog-launcher]"));
}

/** The declared rule text of every class on an element (see sectionChrome.test). */
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

function spec(extra: Partial<PanelSectionDialogLauncher> = {}): PanelSectionDialogLauncher & {
  onLaunch: ReturnType<typeof vi.fn>;
} {
  const onLaunch = vi.fn();
  return { label: "Format Cells: Font", onLaunch, ...extra } as PanelSectionDialogLauncher & {
    onLaunch: ReturnType<typeof vi.fn>;
  };
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

function renderCell(s: PanelSection, opts: { widthDemoted?: boolean; isLast?: boolean } = {}): void {
  render(
    <SectionCell
      panelId="dialog-launcher-test"
      section={s}
      isFirst
      isLast={opts.isLast ?? true}
      widthDemoted={opts.widthDemoted ?? false}
      onNaturalWidth={() => {}}
    />,
  );
}

// ============================================================================
// No launcher declared: today's DOM, byte for byte in shape
// ============================================================================

describe("SectionChrome without a dialog launcher (the goldens' guard)", () => {
  it("adds no element, no positioning context and no caption padding", () => {
    render(
      <SectionChrome label="Clipboard" isFirst isLast={false}>
        <Body />
      </SectionChrome>,
    );
    expect(cell().children).toHaveLength(2);
    expect(launchers()).toEqual([]);
    expect(ruleTextFor(cell())).not.toMatch(/position/);
    expect(ruleTextFor(caption())).not.toMatch(/padding/);
    expect(caption().getAttribute("style")).toBeNull();
  });

  it("the same with labels hidden", () => {
    setRibbonLabelMode("hide");
    render(
      <SectionChrome label="Clipboard" isFirst isLast={false}>
        <Body />
      </SectionChrome>,
    );
    expect(cell().children).toHaveLength(2);
    expect(launchers()).toEqual([]);
    expect(ruleTextFor(cell())).not.toMatch(/position/);
    expect(ruleTextFor(caption())).not.toMatch(/padding/);
  });
});

// ============================================================================
// The ribbon caption cell
// ============================================================================

describe("SectionChrome with a dialog launcher", () => {
  it("draws it between the card and the caption, so the caption stays LAST", () => {
    const s = spec({ testId: "dialog-launcher-home.font" });
    render(
      <SectionChrome label="Font" isFirst isLast={false} dialogLauncher={s}>
        <Body />
      </SectionChrome>,
    );
    expect(cell().children).toHaveLength(3);
    expect(card().getAttribute("role")).toBe("group");
    const button = cell().children[1] as HTMLButtonElement;
    expect(button.hasAttribute("data-dialog-launcher")).toBe(true);
    expect(caption().textContent).toBe("Font");
    expect(cell().lastElementChild).toBe(caption());
    // Neither inside the card (role=group queries stay about the controls)
    // nor inside the caption (which collapses to 0 when labels are hidden).
    expect(card().contains(button)).toBe(false);
    expect(caption().contains(button)).toBe(false);
  });

  it("is a named, keyboard-reachable button that runs onLaunch", () => {
    const s = spec({ testId: "dialog-launcher-home.font" });
    render(
      <SectionChrome label="Font" isFirst isLast dialogLauncher={s}>
        <Body />
      </SectionChrome>,
    );
    const [button] = launchers(container);
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Format Cells: Font");
    expect(button.getAttribute("data-testid")).toBe("dialog-launcher-home.font");
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBe(0);
    // Its only content is the glyph: the caption's text is untouched.
    expect(button.textContent).toBe("");
    click(button);
    expect(s.onLaunch).toHaveBeenCalledTimes(1);
  });

  it("draws Excel's corner-arrow glyph as kit chrome: an SVG in currentColor, hidden from AT", () => {
    render(
      <SectionChrome label="Font" isFirst isLast dialogLauncher={spec()}>
        <Body />
      </SectionChrome>,
    );
    const [button] = launchers(container);
    const svgs = button.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    const svg = svgs[0];
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.hasAttribute("data-dialog-launcher-glyph")).toBe(true);
    const paths = Array.from(svg.querySelectorAll("path"));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.getAttribute("stroke")).toBe("currentColor");
  });

  it("anchors it to the bottom-right of the cell's content box (inside the cluster gap)", () => {
    render(
      <>
        <SectionChrome label="Font" isFirst isLast={false} dialogLauncher={spec({ testId: "a" })}>
          <Body />
        </SectionChrome>
        <SectionChrome label="Number" isFirst={false} isLast dialogLauncher={spec({ testId: "b" })}>
          <Body />
        </SectionChrome>
      </>,
    );
    const cells = container.querySelectorAll<HTMLElement>("[data-section-cell]");
    for (const c of Array.from(cells)) {
      expect(getComputedStyle(c).position).toBe("relative");
    }
    const [a, b] = launchers(container);
    for (const l of [a, b]) {
      const cs = getComputedStyle(l);
      expect(cs.position).toBe("absolute");
      expect(l.style.bottom).toBe("0px");
      expect(cs.width).toBe(`${DIALOG_LAUNCHER_WIDTH}px`);
      expect(cs.height).toBe(`${DIALOG_LAUNCHER_HEIGHT}px`);
    }
    // The cell's padding-right IS the gap to the next cluster, so the launcher
    // sits that far in from the cell's edge — over the card's right edge.
    expect(a.style.right).toBe(`${CLUSTER_GAP}px`);
    expect(b.style.right).toBe("0px");
  });

  it("keeps the caption centred: symmetric padding wide enough to clear the launcher", () => {
    render(
      <SectionChrome label="Alignment" isFirst isLast={false} dialogLauncher={spec()}>
        <Body />
      </SectionChrome>,
    );
    const cs = getComputedStyle(caption());
    expect(cs.paddingLeft).toBe(`${DIALOG_LAUNCHER_CAPTION_PAD}px`);
    expect(cs.paddingRight).toBe(`${DIALOG_LAUNCHER_CAPTION_PAD}px`);
    expect(DIALOG_LAUNCHER_CAPTION_PAD).toBeGreaterThanOrEqual(DIALOG_LAUNCHER_WIDTH);
    expect(cs.textAlign).toBe("center");
  });

  it("tooltip = the label plus the LIVE shortcut of commandId", () => {
    vi.useFakeTimers();
    render(
      <SectionChrome
        label="Font"
        isFirst
        isLast
        dialogLauncher={spec({ commandId: "core.format.cells" })}
      >
        <Body />
      </SectionChrome>,
    );
    const [button] = launchers(container);
    act(() => {
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10);
    });
    const tip = document.querySelector<HTMLElement>("[role='tooltip']");
    expect(tip).not.toBeNull();
    expect(tip!.querySelector("span")?.textContent).toBe("Format Cells: Font");
    expect(tip!.querySelector("kbd")?.textContent).toBe("Ctrl+1");
  });

  it("tooltip without commandId is the label alone", () => {
    vi.useFakeTimers();
    render(
      <SectionChrome label="Font" isFirst isLast dialogLauncher={spec()}>
        <Body />
      </SectionChrome>,
    );
    const [button] = launchers(container);
    act(() => {
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 10);
    });
    const tip = document.querySelector<HTMLElement>("[role='tooltip']");
    expect(tip?.textContent).toBe("Format Cells: Font");
    expect(tip?.querySelector("kbd")).toBeNull();
  });

  it("hidden labels: still drawn and reachable, inset into the card's free bottom strip", () => {
    setRibbonLabelMode("hide");
    const s = spec();
    render(
      <SectionChrome label="Alignment" isFirst isLast={false} dialogLauncher={s}>
        <Body />
      </SectionChrome>,
    );
    expect(caption().textContent).toBe("Alignment");
    expect(cell().lastElementChild).toBe(caption());
    expect(getComputedStyle(caption()).height).toBe("0px");
    const [button] = launchers(container);
    expect(button).toBeDefined();
    expect(caption().contains(button)).toBe(false);
    expect(getComputedStyle(button).height).toBe(`${DIALOG_LAUNCHER_HEIGHT}px`);
    expect(button.style.bottom).toBe(`${DIALOG_LAUNCHER_HIDDEN_INSET}px`);
    expect(button.style.right).toBe(`${CLUSTER_GAP + DIALOG_LAUNCHER_HIDDEN_INSET}px`);
    click(button);
    expect(s.onLaunch).toHaveBeenCalledTimes(1);
  });

  it("follows the label preference LIVE", () => {
    render(
      <SectionChrome label="Number" isFirst isLast dialogLauncher={spec()}>
        <Body />
      </SectionChrome>,
    );
    const [button] = launchers(container);
    expect(button.style.bottom).toBe("0px");
    act(() => setRibbonLabelMode("hide"));
    expect(launchers(container)[0]).toBe(button);
    expect(button.style.bottom).toBe(`${DIALOG_LAUNCHER_HIDDEN_INSET}px`);
    act(() => setRibbonLabelMode("show"));
    expect(button.style.bottom).toBe("0px");
  });

  for (const [name, layout] of [
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ] as const) {
    it(`paints no hardcoded colour (${name} layout, both label modes)`, () => {
      render(
        <SurfaceLayoutProvider value={layout}>
          <SectionChrome label="Font" isFirst isLast={false} dialogLauncher={spec()}>
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
// SectionCell: the section's declaration reaches the right surface
// ============================================================================

describe("SectionCell dialog launcher", () => {
  it("default test id is dialog-launcher-<sectionId>", () => {
    expect(dialogLauncherTestId("home.font", spec())).toBe("dialog-launcher-home.font");
    expect(dialogLauncherTestId("home.font", spec({ testId: "custom" }))).toBe("custom");
    renderCell(section("home.font", "inline", { dialogLauncher: spec() }));
    const [button] = launchers(container);
    expect(button.getAttribute("data-testid")).toBe("dialog-launcher-home.font");
    // Never the collapsed-group launcher prefix, never an fmt- id.
    expect(button.getAttribute("data-testid")).not.toMatch(/^(section-launcher-|fmt-)/);
  });

  it("inline: the caption cell carries it, with the section's own testId when given", () => {
    const s = spec({ testId: "my-launcher" });
    renderCell(section("inline", "inline", { dialogLauncher: s }));
    expect(card().querySelector("[data-section-sizer]")).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>("[data-testid='my-launcher']");
    expect(button).not.toBeNull();
    expect(cell().lastElementChild?.textContent).toBe("Label inline");
    click(button!);
    expect(s.onLaunch).toHaveBeenCalledTimes(1);
  });

  it("a section without one renders today's two-child cell", () => {
    renderCell(section("plain"));
    expect(cell().children).toHaveLength(2);
    expect(launchers()).toEqual([]);
  });

  for (const [name, s, demoted] of [
    ["declared launcher", "launcher", false],
    ["width-demoted", "inline", true],
  ] as const) {
    it(`collapsed (${name}): no caption-row launcher; the flyout heading carries it`, () => {
      const dl = spec({ commandId: "core.format.cells" });
      renderCell(section("home.number", s, { dialogLauncher: dl }), { widthDemoted: demoted });
      // The collapsed cell keeps its exact shape (and so its measured width).
      expect(cell().children).toHaveLength(2);
      expect(ruleTextFor(caption())).not.toMatch(/padding/);
      expect(launchers()).toEqual([]);

      const groupButton = container.querySelector<HTMLButtonElement>(
        "[data-testid='section-launcher-home.number']",
      )!;
      click(groupButton);
      const flyout = document.querySelector<HTMLElement>("[data-section-flyout]")!;
      expect(flyout).not.toBeNull();
      const heading = flyout.firstElementChild as HTMLElement;
      expect(heading.textContent).toBe("Label home.number");
      const button = heading.querySelector<HTMLButtonElement>(
        "[data-testid='dialog-launcher-home.number']",
      );
      expect(button).not.toBeNull();
      expect(button!.getAttribute("aria-label")).toBe("Format Cells: Font");
      expect(button!.hasAttribute("data-dialog-launcher")).toBe(true);
      expect(button!.tabIndex).toBe(0);

      // Choosing it closes the flyout (Excel's drop-down closes), hands focus
      // back to the group button, and opens the dialog.
      act(() => button!.focus());
      click(button!);
      expect(dl.onLaunch).toHaveBeenCalledTimes(1);
      expect(document.querySelector("[data-section-flyout]")).toBeNull();
      expect(document.activeElement).toBe(groupButton);
    });
  }
});

// ============================================================================
// Launcher (the kit primitive) heading action
// ============================================================================

describe("Launcher flyout heading", () => {
  it("without a dialog launcher the heading is exactly the label text", () => {
    render(
      <Launcher label="Actions" testId="launch">
        <Body />
      </Launcher>,
    );
    click(container.querySelector("[data-testid='launch']")!);
    const heading = document.querySelector("[data-section-flyout]")!.firstElementChild as HTMLElement;
    expect(heading.textContent).toBe("Actions");
    expect(heading.children).toHaveLength(0);
  });

  it("with one, the heading keeps its text and adds the button after it", () => {
    const dl = spec({ testId: "dl" });
    render(
      <Launcher label="Number" testId="launch" dialogLauncher={dl}>
        <Body />
      </Launcher>,
    );
    click(container.querySelector("[data-testid='launch']")!);
    const flyout = document.querySelector("[data-section-flyout]")!;
    const heading = flyout.firstElementChild as HTMLElement;
    expect(heading.textContent).toBe("Number");
    expect(heading.lastElementChild?.getAttribute("data-testid")).toBe("dl");
    expect(getComputedStyle(heading).fontSize).toBe("11px");
    expect(getComputedStyle(heading).fontWeight).toBe("600");
    expect(findHardcodedColours(document.body)).toEqual([]);
  });
});

// ============================================================================
// The sidebar header
// ============================================================================

describe("SectionSidebarRenderer dialog launcher", () => {
  it("sits BESIDE the header button (a button cannot hold a button)", () => {
    const dl = spec();
    render(
      <SectionSidebarRenderer
        sections={[section("home.font", "inline", { dialogLauncher: dl }), section("two")]}
      />,
    );
    const headers = container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
    expect(headers).toHaveLength(2);
    const header = headers[0];
    expect(header.textContent).toBe("Label home.font");
    const [button] = launchers(container);
    expect(button.getAttribute("data-testid")).toBe("dialog-launcher-home.font");
    expect(button.getAttribute("aria-label")).toBe("Format Cells: Font");
    expect(header.contains(button)).toBe(false);
    expect(button.parentElement).toBe(header.parentElement);
    // The header recipe is unchanged.
    const rules = ruleTextFor(header);
    expect(rules).toMatch(/font-size:\s*12px/);
    expect(rules).toMatch(/font-weight:\s*600/);
    expect(rules).toMatch(/height:\s*36px/);
  });

  it("runs onLaunch without toggling the section", () => {
    const dl = spec();
    render(
      <SectionSidebarRenderer
        sections={[section("home.font", "inline", { dialogLauncher: dl }), section("two")]}
      />,
    );
    const header = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const [button] = launchers(container);
    click(button);
    expect(dl.onLaunch).toHaveBeenCalledTimes(1);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll("[data-testid='body']")).toHaveLength(2);
    // Still there (and still working) while the section is collapsed.
    act(() => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    click(launchers(container)[0]);
    expect(dl.onLaunch).toHaveBeenCalledTimes(2);
  });

  it("a section without one keeps the header button directly in its section div", () => {
    render(<SectionSidebarRenderer sections={[section("one"), section("two")]} />);
    const header = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(header.parentElement?.hasAttribute("data-sidebar-section")).toBe(true);
    expect(launchers(container)).toEqual([]);
  });

  it("paints no hardcoded colour", () => {
    render(
      <SectionSidebarRenderer
        sections={[section("home.font", "inline", { dialogLauncher: spec() }), section("two")]}
      />,
    );
    expect(findHardcodedColours(container)).toEqual([]);
  });
});
