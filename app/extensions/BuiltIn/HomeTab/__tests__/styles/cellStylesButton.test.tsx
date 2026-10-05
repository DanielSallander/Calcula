//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/styles/cellStylesButton.test.tsx
// PURPOSE: Home > Cell Styles (CONTRACT 3.10), moved out of
//          HomeTabGroupComponent.renderHero into a control of its own: Excel's
//          large two-line hero "Cell / Styles v" in the band, a standard 28px
//          control outside it, opening the shared CellStylesGallery whose pick
//          goes down the group's ONE formatting door (state.handleCellStyleApply
//          -> applyFormat, which refuses while something else owns the
//          selection).
// CONTEXT: The hooks the journeys hold are kept exactly: `fmt-cellStyles` on
//          the button (e2e fixall-pivot clicks it), `cell-styles-gallery` and
//          its `cell-style-<id>` options (fixall-edit and fixall-pivot pick
//          "Good" in it). The gallery here is the REAL one from
//          extensions/_shared, so a gallery that came back as a 61px band strip
//          inside the popover, or a pick that wrote the wrong formatting, fails
//          here rather than in a journey.
//
//          New with the move (the two Styles neighbours behave this way through
//          the kit, and Cell Styles did not): opened from the KEYBOARD, focus
//          goes into the gallery -- it is portalled to the end of <body>, so Tab
//          from the button never reached it -- and a pick hands focus back to
//          the button instead of dropping it on <body>. A refusal thrown by the
//          formatting door reaches the user, never an unhandled rejection.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const h = vi.hoisted(() => ({ alertAsync: vi.fn() }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alertAsync(...a) }));

import React from "react";
import { RibbonIcon } from "@api";
import { bandLayout, panelLayout, findHardcodedColours, HERO_ICON_SIZE, ICON_SIZE_SM, Launcher } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import type { HomeTabState } from "../../components/homeItemProps";
import { CellStylesButton } from "../../components/styles/CellStylesButton";
import { CELL_STYLES_BY_ID } from "../../../../_shared/components/CellStylesGallery";
import {
  mount,
  unmount,
  host,
  render,
  click,
  keyboardClick,
  key,
  mouseDown,
  flush,
  byTestId,
  maybe,
  tooltipOf,
  pictureMarkup,
  stylesItem,
} from "./stylesHarness";

const ITEM = stylesItem("cellStyles");
const TRIGGER = "fmt-cellStyles";
const handleCellStyleApply = vi.fn();
const STATE = { handleCellStyleApply } as unknown as HomeTabState;

async function renderButton(layout = bandLayout(1200), band = true): Promise<void> {
  await render(
    <>
      <CellStylesButton item={ITEM} state={STATE} band={band} />
      <input data-testid="elsewhere" />
    </>,
    layout,
  );
}

function trigger(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(TRIGGER);
}

function gallery(): HTMLElement | null {
  return maybe("cell-styles-gallery");
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(() => {
  mount();
  handleCellStyleApply.mockReset().mockResolvedValue(undefined);
  h.alertAsync.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  unmount();
});

describe("the control", () => {
  it("is the catalog's Styles hero", () => {
    expect(ITEM).toMatchObject({ id: "cellStyles", hero: true });
    expect(ITEM.shortLabel ?? ITEM.label).toBe("Cell Styles");
  });

  it("in the band: Excel's large button 'Cell / Styles v' with its picture, announcing a dialog", async () => {
    await renderButton();
    const button = trigger();
    expect(button.tagName).toBe("BUTTON");
    const lines = Array.from(button.querySelectorAll("[data-hero-line]"));
    expect(lines.map((l) => l.textContent?.trim())).toEqual(["Cell", "Styles"]);
    expect(lines[1].querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("Cell Styles");
    const face = button.querySelector("svg") as SVGElement;
    expect(face.outerHTML).toBe(pictureMarkup(<RibbonIcon.CellStyles size={HERO_ICON_SIZE} />));
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("title")).toBe(false);
    expect(tooltipOf(button)).toBe("Cell Styles");
  });

  it("outside the band: a standard 28px control with the 20px picture", async () => {
    await renderButton(panelLayout(300), false);
    const button = trigger();
    expect(button.querySelector("[data-hero-line]")).toBeNull();
    const face = button.querySelector("svg") as SVGElement;
    expect(face.outerHTML).toBe(pictureMarkup(<RibbonIcon.CellStyles size={ICON_SIZE_SM} />));
    expect(button.textContent).toBe("Cell Styles");
  });
});

describe("the gallery", () => {
  for (const [surface, layout, band] of [
    ["band", bandLayout(1200), true],
    ["panel", panelLayout(300), false],
  ] as const) {
    it(`opens the shared gallery as a whole grid, not a band strip (${surface})`, async () => {
      await renderButton(layout, band);
      expect(gallery()).toBeNull();
      click(trigger());
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      const g = gallery();
      expect(g).not.toBeNull();
      // Portalled out of the band, which clips.
      expect(host().contains(g)).toBe(false);
      // Every style is offered at once (a strip shows three and an expander).
      expect(maybe("cell-style-good")).not.toBeNull();
      expect(maybe("cell-style-expand")).toBeNull();
      expect(g!.querySelectorAll("[role='option']").length).toBe(CELL_STYLES_BY_ID.size);
      // The control describes what it opened, and what it opened is named.
      const controls = trigger().getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      expect(document.getElementById(controls!)?.contains(g)).toBe(true);
      const dialog = g!.closest("[data-section-flyout]") as HTMLElement;
      expect(dialog.getAttribute("role")).toBe("dialog");
      expect(dialog.getAttribute("aria-label")).toBe("Cell Styles");
      expect(findHardcodedColours(host())).toEqual([]);
    });
  }

  it("a pick applies the style's formatting through the group's door, closes, and hands focus back", async () => {
    await renderButton();
    click(trigger());
    click(byTestId("cell-style-good"));
    expect(handleCellStyleApply).toHaveBeenCalledTimes(1);
    expect(handleCellStyleApply).toHaveBeenCalledWith(CELL_STYLES_BY_ID.get("good")!.formatting);
    expect(gallery()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("opened from the keyboard, focus goes into the gallery", async () => {
    await renderButton();
    trigger().focus();
    keyboardClick(trigger());
    const focused = document.activeElement as HTMLElement;
    expect(gallery()?.contains(focused)).toBe(true);
    expect(focused.getAttribute("role")).toBe("option");
  });

  it("opened with the mouse, focus stays on the button", async () => {
    await renderButton();
    trigger().focus();
    click(trigger());
    expect(gallery()).not.toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("a second click, Escape and a press elsewhere each close it without applying anything", async () => {
    await renderButton();
    click(trigger());
    mouseDown(trigger());
    click(trigger());
    expect(gallery()).toBeNull();
    click(trigger());
    key(byTestId("cell-style-good"), "Escape");
    expect(gallery()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    click(trigger());
    mouseDown(byTestId("elsewhere"));
    expect(gallery()).toBeNull();
    expect(handleCellStyleApply).not.toHaveBeenCalled();
  });
});

describe("a refusal reaches the user", () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  async function settle(): Promise<void> {
    await flush();
    await new Promise((r) => setTimeout(r, 0));
  }

  it("a door that REJECTS: the message is shown, nothing is unhandled", async () => {
    handleCellStyleApply.mockRejectedValue(new Error("The cell is on a protected sheet."));
    await renderButton();
    click(trigger());
    click(byTestId("cell-style-bad"));
    await settle();
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    expect(h.alertAsync).toHaveBeenCalledWith("The cell is on a protected sheet.");
    expect(unhandled).toEqual([]);
    expect(gallery()).toBeNull();
  });

  it("a door that THROWS synchronously: the message is shown, the popover still closes", async () => {
    handleCellStyleApply.mockImplementation(() => {
      throw new Error("refused");
    });
    await renderButton();
    click(trigger());
    click(byTestId("cell-style-good"));
    await settle();
    expect(h.alertAsync).toHaveBeenCalledWith("refused");
    expect(gallery()).toBeNull();
  });

  it("a door that succeeds shows nothing (positive control)", async () => {
    await renderButton();
    click(trigger());
    click(byTestId("cell-style-good"));
    await settle();
    expect(h.alertAsync).not.toHaveBeenCalled();
  });
});

// ============================================================================
// The keyboard model its two Styles neighbours have (review finding,
// 2026-10-04): ArrowDown opens it, and Escape inside a collapsed group's
// flyout closes the gallery only
// ============================================================================

describe("the keyboard, as Conditional Formatting and Format as Table answer it", () => {
  it("ArrowDown on the button opens the gallery with focus inside, as every other popup hero opens", async () => {
    await renderButton();
    trigger().focus();
    key(trigger(), "ArrowDown");
    expect(gallery()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const focused = document.activeElement as HTMLElement;
    expect(gallery()?.contains(focused)).toBe(true);
    expect(focused.getAttribute("role")).toBe("option");
  });

  it("ArrowUp opens it the same way (a gallery has no 'last item')", async () => {
    await renderButton();
    trigger().focus();
    key(trigger(), "ArrowUp");
    expect(gallery()?.contains(document.activeElement)).toBe(true);
  });

  it("already open from a pointer (focus left on the button), ArrowDown steps into it and does not close it", async () => {
    await renderButton();
    trigger().focus();
    click(trigger());
    expect(document.activeElement).toBe(trigger());
    key(trigger(), "ArrowDown");
    expect(gallery()).not.toBeNull();
    expect(gallery()?.contains(document.activeElement)).toBe(true);
  });

  it("other keys open nothing", async () => {
    await renderButton();
    trigger().focus();
    key(trigger(), "ArrowRight");
    key(trigger(), "a");
    expect(gallery()).toBeNull();
  });

  it("inside a COLLAPSED group's flyout, Escape in the gallery closes the gallery only, focus back on the button", async () => {
    // Styles is the first group to collapse (collapsePriority 10). Escape used
    // to close the Launcher's flyout too, and focus fell to <body>.
    await render(
      <Launcher label="Styles" testId="styles-launcher">
        <CellStylesButton item={ITEM} state={STATE} band={false} />
      </Launcher>,
      bandLayout(1200),
    );
    click(byTestId("styles-launcher"));
    trigger().focus();
    key(trigger(), "ArrowDown");
    const inside = document.activeElement as HTMLElement;
    expect(gallery()?.contains(inside)).toBe(true);

    key(inside, "Escape");
    expect(gallery()).toBeNull();
    expect(maybe(TRIGGER), "the flyout holding the button is still open").not.toBeNull();
    expect(byTestId("styles-launcher").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(trigger());

    // Positive control: with nothing nested, the next Escape is the flyout's.
    key(trigger(), "Escape");
    expect(maybe(TRIGGER)).toBeNull();
  });
});
