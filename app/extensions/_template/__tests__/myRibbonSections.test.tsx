//! FILENAME: app/extensions/_template/__tests__/myRibbonSections.test.tsx
// PURPOSE: Keeps the template's ribbon/sidebar example honest: both sections
//          render on both surfaces, paint only with tokens, obey the fill rule,
//          and the controls actually drive the shared option store.
// CONTEXT: The template is what a new extension author copies, so a template
//          that drifts from the design system teaches the drift. These cases
//          pin exactly what its comments claim: a hero row is 61px in the band
//          and a 28px button in the sidebar; the options grid is two 28px rows
//          with the 5px ROW_GAP between them (28 + 5 + 28 = 61); no native
//          <select>; every section carries a RibbonIcon; and activate()
//          registers the panel through the same `context.ui.panels` call the
//          built-in extensions use.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for the CommandRegistry singleton and the
 * AppEvents table, whose real names are PascalCase / UPPER_CASE; a camelCase
 * double would simply not be the export the modules import. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  popoverLayout,
  findHardcodedColours,
  BAND_MAX_CONTENT_HEIGHT,
  CONTROL_HEIGHT_MD,
  ROW_GAP,
  TALL_CONTROL_HEIGHT,
  TOOLTIP_DELAY_MS,
  type SurfaceLayout,
} from "@api/layout";
import type { ExtensionContext } from "@api/contract";
import type { PanelDefinition } from "@api/uiTypes";

const m = vi.hoisted(() => ({
  execute: vi.fn(),
  registerMenuItem: vi.fn(),
  unregisterMenuItem: vi.fn(),
  showToast: vi.fn(),
  offSelection: vi.fn(),
  onAppEvent: vi.fn(),
}));

vi.mock("@api/commands", () => ({
  CommandRegistry: { execute: (id: string) => m.execute(id) },
}));
// The @api barrel pulls in every extension; the template's index.ts only
// needs these five names from it.
vi.mock("@api", () => ({
  registerMenuItem: m.registerMenuItem,
  unregisterMenuItem: m.unregisterMenuItem,
  showToast: m.showToast,
  onAppEvent: m.onAppEvent,
  AppEvents: { SELECTION_CHANGED: "app:selection-changed" },
}));

import {
  TemplateActionsSection,
  TemplateOptionsSection,
  TEMPLATE_RUN_COMMAND,
} from "../components/MyRibbonSections";
import { buildTemplatePanelDefinition, TEMPLATE_PANEL_ID } from "../components/templatePanel";
import {
  DEFAULT_TEMPLATE_OPTIONS,
  describeTemplateRun,
  getTemplateOptions,
  resetTemplateOptions,
  setTemplateOptions,
} from "../lib/templateOptions";
import extension from "../index";

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode, layout: SurfaceLayout): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

function click(el: Element): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string, scope: ParentNode = container): T {
  const el = scope.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  return el;
}

const SURFACES: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
  ["popover", popoverLayout(280)],
];

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  m.execute.mockReset().mockResolvedValue(undefined);
  resetTemplateOptions();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  resetTemplateOptions();
});

// ============================================================================
// The fill rule
// ============================================================================

describe("the fill rule the template teaches", () => {
  it("two 28px rows and one ROW_GAP fill the cluster's content box exactly", () => {
    expect(2 * CONTROL_HEIGHT_MD + ROW_GAP).toBe(BAND_MAX_CONTENT_HEIGHT);
    expect(TALL_CONTROL_HEIGHT).toBe(BAND_MAX_CONTENT_HEIGHT);
  });
});

// ============================================================================
// Actions — one tall row of heroes
// ============================================================================

describe("Actions section", () => {
  it.each(SURFACES)("renders Run / Reset with RibbonIcons in the %s, token-painted", (_n, layout) => {
    render(<TemplateActionsSection placement="ribbon" />, layout);

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Run", "Reset"]);
    for (const b of buttons) expect(b.querySelector("svg")).not.toBeNull();
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("is ONE TALL ROW in the band: every hero is the full 61px content box", () => {
    render(<TemplateActionsSection placement="ribbon" />, bandLayout());
    for (const b of Array.from(container.querySelectorAll("button"))) {
      expect(getComputedStyle(b).height).toBe(`${TALL_CONTROL_HEIGHT}px`);
      expect(getComputedStyle(b).flexDirection).toBe("column");
    }
  });

  it("becomes standard 28px buttons in the sidebar, from the same JSX", () => {
    render(<TemplateActionsSection placement="sidebar" />, panelLayout(300));
    for (const b of Array.from(container.querySelectorAll("button"))) {
      expect(b.style.height).toBe(`${CONTROL_HEIGHT_MD}px`);
    }
  });

  it("a hero's tooltip says what it does (its label is already visible)", () => {
    vi.useFakeTimers();
    try {
      render(<TemplateActionsSection placement="ribbon" />, bandLayout());
      act(() => {
        byTestId("template-run").dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }),
        );
      });
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });
      expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
        "Run with the current options",
      );
      // No native title: the Tooltip replaces it.
      expect(byTestId("template-run").getAttribute("title")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Run executes the registered command (the hero never runs code itself)", () => {
    render(<TemplateActionsSection placement="ribbon" />, bandLayout());
    click(byTestId("template-run"));
    expect(m.execute).toHaveBeenCalledWith(TEMPLATE_RUN_COMMAND);
  });

  it("a failing command is contained, not thrown into the ribbon", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    m.execute.mockRejectedValueOnce(new Error("boom"));
    render(<TemplateActionsSection placement="ribbon" />, bandLayout());
    click(byTestId("template-run"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("Reset puts every option back to its default", () => {
    setTemplateOptions({ scope: "workbook", precision: 0, livePreview: true, skipHidden: false });
    render(<TemplateActionsSection placement="ribbon" />, bandLayout());
    click(byTestId("template-reset"));
    expect(getTemplateOptions()).toEqual(DEFAULT_TEMPLATE_OPTIONS);
  });
});

// ============================================================================
// Options — two rows of 28px controls
// ============================================================================

describe("Options section", () => {
  it.each(SURFACES)("renders only @api/layout controls in the %s, token-painted", (_n, layout) => {
    render(<TemplateOptionsSection placement="ribbon" />, layout);

    expect(container.querySelector("[role='radiogroup'][aria-label='Scope']")).not.toBeNull();
    expect(container.querySelectorAll("[role='radio']")).toHaveLength(3);
    expect(container.querySelector("[role='combobox'][aria-label='Precision']")).not.toBeNull();
    expect(container.querySelectorAll("input[type='checkbox']")).toHaveLength(2);
    // Values use Dropdown, never a native <select>.
    expect(container.querySelector("select")).toBeNull();
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("is TWO ROWS in the band, 5px apart: scope + precision, then the two checkboxes", () => {
    render(<TemplateOptionsSection placement="ribbon" />, bandLayout());

    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.flexDirection).toBe("column");
    expect(grid.style.gap).toBe(`${ROW_GAP}px`);

    const rows = Array.from(grid.children) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("[role='radiogroup']")).not.toBeNull();
    expect(rows[0].querySelector("[role='combobox']")).not.toBeNull();
    expect(rows[1].querySelectorAll("input[type='checkbox']")).toHaveLength(2);
    expect(rows[1].querySelector("[role='radiogroup']")).toBeNull();
  });

  it("names every icon-only option and gives it a tooltip rather than a title", () => {
    render(<TemplateOptionsSection placement="ribbon" />, bandLayout());
    const names = Array.from(container.querySelectorAll("[role='radio']")).map((r) =>
      r.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Selection", "Sheet", "Workbook"]);
    for (const r of Array.from(container.querySelectorAll("[role='radio']"))) {
      expect(r.getAttribute("title")).toBeNull();
    }
  });

  it("the scope pill selects one value and writes it to the store", () => {
    render(<TemplateOptionsSection placement="ribbon" />, bandLayout());
    expect(byTestId("template-scope-selection").getAttribute("aria-checked")).toBe("true");

    click(byTestId("template-scope-sheet"));
    expect(getTemplateOptions().scope).toBe("sheet");
    expect(byTestId("template-scope-sheet").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("template-scope-selection").getAttribute("aria-checked")).toBe("false");
  });

  it("the precision dropdown opens a listbox and chooses a value", () => {
    render(<TemplateOptionsSection placement="ribbon" />, bandLayout());
    const trigger = byTestId("template-precision");
    expect(trigger.textContent).toContain("2 decimals");

    click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The list is a body portal (it must escape the band's overflow clip).
    click(byTestId("template-precision-0", document.body));
    expect(getTemplateOptions().precision).toBe(0);
    expect(byTestId("template-precision").textContent).toContain("0 decimals");
  });

  it("the checkboxes toggle their options", () => {
    render(<TemplateOptionsSection placement="ribbon" />, bandLayout());
    click(byTestId<HTMLInputElement>("template-live-preview"));
    expect(getTemplateOptions().livePreview).toBe(true);
    click(byTestId<HTMLInputElement>("template-skip-hidden"));
    expect(getTemplateOptions().skipHidden).toBe(false);
  });

  it("every control explains itself on hover: pill options, the dropdown, both checkboxes", () => {
    vi.useFakeTimers();
    try {
      render(<TemplateOptionsSection placement="ribbon" />, bandLayout());
      const hoverTip = (el: Element): string | null => {
        act(() => {
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
        });
        act(() => {
          vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
        });
        const text = document.querySelector("[role='tooltip']")?.textContent ?? null;
        act(() => {
          el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
        });
        return text;
      };

      expect(hoverTip(byTestId("template-scope-sheet"))).toBe("Apply to the whole active sheet");
      expect(hoverTip(byTestId("template-precision"))).toBe("Decimal places in the result");
      const liveLabel = byTestId("template-live-preview").closest("label") as HTMLElement;
      expect(hoverTip(liveLabel)).toBe("Recalculate the result as the options change");
      const hiddenLabel = byTestId("template-skip-hidden").closest("label") as HTMLElement;
      expect(hoverTip(hiddenLabel)).toBe("Leave rows hidden by a filter out of the result");
      // The tooltip portal is never ribbon content (the E2E strict locators).
      expect(document.querySelector("[role='tooltip'][data-ribbon-content]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the dropdown carries its own tooltip: no wrapper, and it lands on the combobox", () => {
    vi.useFakeTimers();
    try {
      render(<TemplateOptionsSection placement="ribbon" />, bandLayout());
      const trigger = byTestId("template-precision");
      // A direct child of the band row: no <span> hover target around it.
      const firstRow = (container.firstElementChild as HTMLElement).firstElementChild;
      expect(trigger.parentElement).toBe(firstRow);
      expect(container.querySelector("[data-testid='template-precision-anchor']")).toBeNull();

      act(() => {
        trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
      });
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });
      const tip = document.querySelector("[role='tooltip']");
      expect(tip?.textContent).toBe("Decimal places in the result");
      // Described on the element a screen reader announces.
      expect(trigger.getAttribute("aria-describedby")).toBe(tip!.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the dropdown keeps the band row at the control height and fills a sidebar row", () => {
    render(<TemplateOptionsSection placement="ribbon" />, bandLayout());
    const trigger = byTestId("template-precision");
    // The Dropdown's own band default, never squeezed by the row.
    expect(trigger.style.width).toBe("104px");
    expect(trigger.style.flex).toBe("0 0 auto");

    render(<TemplateOptionsSection placement="sidebar" />, panelLayout(300));
    expect(byTestId("template-precision").style.width).toBe("100%");
  });

  it("every mounted copy (band, flyout, sidebar) shows the same state", () => {
    render(
      <>
        <SurfaceLayoutProvider value={bandLayout()}>
          <div data-testid="band-copy">
            <TemplateOptionsSection placement="ribbon" />
          </div>
        </SurfaceLayoutProvider>
        <SurfaceLayoutProvider value={panelLayout(300)}>
          <div data-testid="panel-copy">
            <TemplateOptionsSection placement="sidebar" />
          </div>
        </SurfaceLayoutProvider>
      </>,
      bandLayout(),
    );
    const bandCopy = byTestId("band-copy");
    const panelCopy = byTestId("panel-copy");

    click(byTestId("template-scope-workbook", bandCopy));
    expect(
      byTestId("template-scope-workbook", panelCopy).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

// ============================================================================
// The panel definition and the registration
// ============================================================================

describe("panel definition", () => {
  it("carries a panel icon and a RibbonIcon element on every section", () => {
    const panel = buildTemplatePanelDefinition();
    expect(React.isValidElement(panel.icon)).toBe(true);
    expect(panel.sections.map((s) => s.label)).toEqual(["Actions", "Options"]);
    for (const section of panel.sections) {
      expect(React.isValidElement(section.icon)).toBe(true);
      expect(section.id.startsWith(`${TEMPLATE_PANEL_ID}.`)).toBe(true);
    }
  });

  it("is a regular tab (no contextual accent) that starts in the ribbon", () => {
    const panel = buildTemplatePanelDefinition();
    expect(panel.ribbonColor).toBeUndefined();
    expect(panel.defaultPlacement).toBe("ribbon");
  });

  it("declares the hero section inline and lets the options demote first", () => {
    const [actions, options] = buildTemplatePanelDefinition().sections;
    expect(actions.ribbonPresentation).toBe("inline");
    expect(options.ribbonPresentation).toBeUndefined();
    expect(options.collapsePriority ?? 0).toBeLessThan(actions.collapsePriority ?? 0);
  });

  it("no section control is labelled exactly like the tab (the tab's E2E selector)", () => {
    const panel = buildTemplatePanelDefinition();
    render(
      <>
        <TemplateActionsSection placement="ribbon" />
        <TemplateOptionsSection placement="ribbon" />
      </>,
      bandLayout(),
    );
    const clash = Array.from(container.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === panel.title,
    );
    expect(clash).toHaveLength(0);
  });
});

describe("activate / deactivate", () => {
  function fakeContext() {
    const handlers = new Map<string, (args?: unknown) => unknown>();
    const panels = {
      register: vi.fn(),
      unregister: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
      getPlacement: vi.fn(),
      setPlacement: vi.fn(),
    };
    const commands = {
      register: vi.fn((id: string, handler: (args?: unknown) => unknown) => {
        handlers.set(id, handler);
      }),
      unregister: vi.fn((id: string) => {
        handlers.delete(id);
      }),
      execute: vi.fn(),
      has: (id: string) => handlers.has(id),
      isScriptSafe: () => false,
    };
    const context = { commands, ui: { panels } } as unknown as ExtensionContext;
    return { context, panels, commands, handlers };
  }

  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    m.registerMenuItem.mockReset();
    m.unregisterMenuItem.mockReset();
    m.showToast.mockReset();
    m.offSelection.mockReset();
    m.onAppEvent.mockReset().mockReturnValue(m.offSelection);
  });

  afterEach(() => {
    log.mockRestore();
  });

  it("registers the panel through context.ui.panels and the command its hero runs", () => {
    const { context, panels, handlers } = fakeContext();
    extension.activate(context);

    expect(panels.register).toHaveBeenCalledTimes(1);
    const [panel] = panels.register.mock.calls[0] as [PanelDefinition];
    expect(panel.id).toBe(TEMPLATE_PANEL_ID);
    expect(handlers.has(TEMPLATE_RUN_COMMAND)).toBe(true);

    // The existing examples still register.
    expect(m.registerMenuItem).toHaveBeenCalledWith("view", expect.objectContaining({ id: "template.hello" }));
    expect(handlers.has("template.greet")).toBe(true);

    extension.deactivate?.();
  });

  it("the run command reports what a run with the current options does", () => {
    const { context, handlers } = fakeContext();
    extension.activate(context);
    setTemplateOptions({ scope: "sheet", precision: 1 });

    handlers.get(TEMPLATE_RUN_COMMAND)?.();
    expect(m.showToast).toHaveBeenCalledWith(describeTemplateRun(getTemplateOptions()), { type: "info" });

    extension.deactivate?.();
  });

  it("deactivate removes everything activate added and resets the options", () => {
    const { context, panels, commands } = fakeContext();
    extension.activate(context);
    setTemplateOptions({ scope: "workbook" });

    extension.deactivate?.();

    expect(panels.unregister).toHaveBeenCalledWith(TEMPLATE_PANEL_ID);
    expect(commands.unregister).toHaveBeenCalledWith(TEMPLATE_RUN_COMMAND);
    expect(commands.unregister).toHaveBeenCalledWith("template.greet");
    expect(m.unregisterMenuItem).toHaveBeenCalledWith("view", "template.hello");
    expect(m.offSelection).toHaveBeenCalled();
    expect(getTemplateOptions()).toEqual(DEFAULT_TEMPLATE_OPTIONS);
  });
});

// ============================================================================
// The pure layer
// ============================================================================

describe("templateOptions", () => {
  it("describes a run in one sentence", () => {
    expect(describeTemplateRun(DEFAULT_TEMPLATE_OPTIONS)).toBe(
      "Ran on the selection, rounded to 2 decimals (live preview off, hidden rows skipped).",
    );
    expect(
      describeTemplateRun({ scope: "workbook", precision: 1, livePreview: true, skipHidden: false }),
    ).toBe("Ran on every sheet, rounded to 1 decimal (live preview on, hidden rows included).");
  });

  it("a patch that changes nothing keeps the same snapshot object", () => {
    const before = getTemplateOptions();
    setTemplateOptions({ scope: before.scope });
    expect(getTemplateOptions()).toBe(before);
  });
});
