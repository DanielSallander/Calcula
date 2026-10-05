//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/font/underlineSplitButton.test.tsx
// PURPOSE: Excel's Underline split button on the Home tab's Font group
//          (CONTRACT 3.3): the typographic "U" face that remembers the kind
//          last chosen, its pressed state, the two radio rows, what every part
//          writes through the group's formatting door, the control inside the
//          Emphasis pill, and refusals reaching the user.
// CONTEXT: The rules were MEASURED in live Excel 365 through COM on 2026-10-04
//          (home-font report, "Excel probe"; GetPressedMso after a settle):
//          - the "Underline" command is pressed on a SINGLE-underlined cell and
//            NOT on a double one; "Double Underline" is the reverse;
//          - each row TOGGLES its own kind: Underline on single -> none, on
//            double -> single, on single accounting -> none, on double
//            accounting -> single; Double Underline on double -> none;
//          - the face runs whichever row was chosen last (Ctrl+U stays single).
//          So the face is pressed when the cell carries the FACE's kind -- not
//          for any underline, which is how a double-underlined cell would have
//          shown a pressed single "U" that, clicked, does not remove anything.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module double below stands in for RibbonIcon, whose real name is
 * PascalCase. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return { RibbonIcon: icons.RibbonIcon };
});

const dialogs = vi.hoisted(() => ({ alertAsync: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@api/dialogs", () => dialogs);

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  Segmented,
  Button,
  CONTROL_HEIGHT_MD,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import { RibbonIcon, type RibbonIconKey } from "@api/ribbonIcons";
import type { StyleData, UnderlineStyle } from "@api/types";
import type { HomeTabItem } from "../../homeTabConfig";
import type { HomeTabState } from "../../components/homeItemProps";
import { UnderlineSplitButton } from "../../components/font/UnderlineSplitButton";
import { underlineFaceKind, underlineTarget, underlineKindOf } from "../../components/font/underline";

// ============================================================================
// Harness
// ============================================================================

/** The catalog's own entry (homeTabConfig: "Underline (Ctrl+U)"). */
const ITEM: HomeTabItem = {
  id: "underline",
  label: "Underline",
  tooltip: "Underline (Ctrl+U)",
  type: "toggle",
  icon: "U",
  category: "Font",
};

const applyFormat = vi.fn();
let container: HTMLDivElement;
let root: Root;

function makeState(underline: UnderlineStyle | null): HomeTabState {
  return {
    currentStyle: underline === null ? null : ({ underline } as StyleData),
    applyFormat,
  } as unknown as HomeTabState;
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  underlineFaceKind.reset();
  dialogs.alertAsync.mockClear();
  applyFormat.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const SURFACES: Array<[string, () => SurfaceLayout, boolean]> = [
  ["band", () => bandLayout(1200), true],
  ["panel", () => panelLayout(300), false],
];

async function render(
  underline: UnderlineStyle | null = "none",
  surface: [string, () => SurfaceLayout, boolean] = SURFACES[0],
  wrap: (node: React.ReactElement) => React.ReactElement = (n) => n,
): Promise<void> {
  const [, layout, band] = surface;
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={layout()}>
        {wrap(<UnderlineSplitButton item={ITEM} state={makeState(underline)} band={band} />)}
      </SurfaceLayoutProvider>,
    );
  });
}

function byTestId(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function rows(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[role='menu'] button"));
}

function iconMarkup(iconKey: RibbonIconKey, size: number): string {
  const host = document.createElement("div");
  const r = createRoot(host);
  act(() => r.render(React.createElement(RibbonIcon[iconKey], { size })));
  const html = host.innerHTML;
  act(() => r.unmount());
  return html;
}

/** The face's letter. */
function glyph(): HTMLElement {
  const el = byTestId("fmt-underline").querySelector<HTMLElement>("[data-underline-glyph]");
  if (!el) throw new Error("no glyph");
  return el;
}

// ============================================================================
// The rules (pure)
// ============================================================================

describe("the rules Excel follows (measured)", () => {
  it("a cell's underline belongs to the single or the double kind, accounting included", () => {
    expect(underlineKindOf("none")).toBeNull();
    expect(underlineKindOf(undefined)).toBeNull();
    expect(underlineKindOf("single")).toBe("single");
    expect(underlineKindOf("singleAccounting")).toBe("single");
    expect(underlineKindOf("double")).toBe("double");
    expect(underlineKindOf("doubleAccounting")).toBe("double");
  });

  it("each kind toggles itself and replaces the other", () => {
    expect(underlineTarget("none", "single")).toBe("single");
    expect(underlineTarget("single", "single")).toBe("none");
    expect(underlineTarget("double", "single")).toBe("single");
    expect(underlineTarget("singleAccounting", "single")).toBe("none");
    expect(underlineTarget("doubleAccounting", "single")).toBe("single");
    expect(underlineTarget("double", "double")).toBe("none");
    expect(underlineTarget("single", "double")).toBe("double");
    expect(underlineTarget(undefined, "double")).toBe("double");
  });
});

// ============================================================================
// The control
// ============================================================================

describe("the control", () => {
  for (const surface of SURFACES) {
    it(`is an icon split whose face is the typographic U (${surface[0]})`, async () => {
      await render("none", surface);
      const main = byTestId("fmt-underline");
      const chevron = byTestId("fmt-underline-options");
      expect(main.getAttribute("aria-label")).toBe("Underline");
      expect(chevron.getAttribute("aria-label")).toBe("Underline options");
      expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
      expect(main.hasAttribute("title")).toBe(false);
      expect(main.style.height).toBe(`${CONTROL_HEIGHT_MD}px`);
      expect(main.closest(".split")).not.toBeNull();
      expect(glyph().textContent).toBe("U");
      expect(glyph().style.textDecorationLine).toBe("underline");
      expect(glyph().style.textDecorationStyle).toBe("solid");
      expect(glyph().getAttribute("aria-hidden")).toBe("true");
    });
  }

  it("paints with tokens only, the open menu included", async () => {
    await render("single");
    click(byTestId("fmt-underline-options"));
    expect(findHardcodedColours(document.body)).toEqual([]);
  });

  const PRESSED: Array<[UnderlineStyle | null, boolean]> = [
    [null, false],
    ["none", false],
    ["single", true],
    ["singleAccounting", true],
    ["double", false],
    ["doubleAccounting", false],
  ];
  for (const [underline, pressed] of PRESSED) {
    it(`with the single face, a ${String(underline)} cell shows ${pressed ? "pressed" : "not pressed"}`, async () => {
      await render(underline);
      const main = byTestId("fmt-underline");
      expect(main.getAttribute("aria-pressed")).toBe(String(pressed));
      expect(main.getAttribute("data-active")).toBe(pressed ? "true" : null);
    });
  }

  const FACE: Array<[UnderlineStyle, UnderlineStyle]> = [
    ["none", "single"],
    ["single", "none"],
    ["double", "single"],
  ];
  for (const [from, to] of FACE) {
    it(`the single face on a ${from} cell writes ${to}`, async () => {
      await render(from);
      click(byTestId("fmt-underline"));
      await settle();
      expect(applyFormat).toHaveBeenCalledTimes(1);
      expect(applyFormat).toHaveBeenCalledWith({ underline: to }, "Underline");
      expect(document.querySelector("[role='menu']")).toBeNull();
    });
  }
});

// ============================================================================
// The menu
// ============================================================================

describe("the menu", () => {
  it("is Excel's two radio rows, with their pictures, checked by the cell's kind", async () => {
    await render("double");
    click(byTestId("fmt-underline-options"));
    const [single, double] = rows();
    expect(rows()).toHaveLength(2);
    expect([single, double].map((r) => r.getAttribute("data-testid"))).toEqual([
      "fmt-underline-single",
      "fmt-underline-double",
    ]);
    expect([single, double].map((r) => r.querySelector("[data-menu-label]")?.textContent)).toEqual([
      "Underline",
      "Double Underline",
    ]);
    expect([single, double].map((r) => r.getAttribute("role"))).toEqual(["menuitemradio", "menuitemradio"]);
    expect([single, double].map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    // [check column][icon column][label]: the icon column holds the picture.
    expect(single.children[1].innerHTML).toBe(iconMarkup("Underline", 20));
    expect(double.children[1].innerHTML).toBe(iconMarkup("DoubleUnderline", 20));
    expect(document.querySelector("[role='menu']")?.getAttribute("aria-label")).toBe("Underline");
  });

  it("no row is checked on a cell without underline", async () => {
    await render("none");
    click(byTestId("fmt-underline-options"));
    expect(rows().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
  });

  it("Double Underline writes double, and the face then becomes -- and applies -- double", async () => {
    await render("none");
    click(byTestId("fmt-underline-options"));
    click(byTestId("fmt-underline-double"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ underline: "double" }, "Double Underline");
    expect(underlineFaceKind.get()).toBe("double");
    const main = byTestId("fmt-underline");
    expect(main.getAttribute("aria-label")).toBe("Double Underline");
    expect(glyph().style.textDecorationStyle).toBe("double");
    applyFormat.mockClear();
    click(main);
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ underline: "double" }, "Double Underline");
  });

  it("with the double face, a double cell shows pressed and the face removes it", async () => {
    underlineFaceKind.set("double");
    await render("double");
    const main = byTestId("fmt-underline");
    expect(main.getAttribute("aria-pressed")).toBe("true");
    click(main);
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ underline: "none" }, "Double Underline");
  });

  it("with the double face, a single cell is not pressed and the face makes it double", async () => {
    underlineFaceKind.set("double");
    await render("single");
    expect(byTestId("fmt-underline").getAttribute("aria-pressed")).toBe("false");
    click(byTestId("fmt-underline"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ underline: "double" }, "Double Underline");
  });

  it("choosing the checked row removes the underline (Excel's toggle) and still sets the face", async () => {
    underlineFaceKind.set("double");
    await render("single");
    click(byTestId("fmt-underline-options"));
    click(byTestId("fmt-underline-single"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ underline: "none" }, "Underline");
    expect(underlineFaceKind.get()).toBe("single");
  });

  it("the remembered face is shared by every copy of the button", async () => {
    await render("none");
    const second = document.createElement("div");
    document.body.appendChild(second);
    const root2 = createRoot(second);
    await act(async () => {
      root2.render(
        <SurfaceLayoutProvider value={panelLayout(300)}>
          <UnderlineSplitButton item={ITEM} state={makeState("none")} band={false} />
        </SurfaceLayoutProvider>,
      );
    });
    act(() => underlineFaceKind.set("double"));
    const faces = Array.from(document.querySelectorAll("[data-testid='fmt-underline']"));
    expect(faces.map((f) => f.getAttribute("aria-label"))).toEqual(["Double Underline", "Double Underline"]);
    act(() => root2.unmount());
  });
});

// ============================================================================
// Inside the Emphasis pill
// ============================================================================

describe("inside a Segmented pill (B | I | U)", () => {
  const pill = (node: React.ReactElement): React.ReactElement => (
    <Segmented ariaLabel="Emphasis">
      <Button aria-label="Bold">B</Button>
      <Button aria-label="Italic">I</Button>
      {node}
    </Segmented>
  );

  for (const surface of SURFACES) {
    it(`joins as the pill's last segment, whose split hooks the pill rounds (${surface[0]})`, async () => {
      await render("single", surface, pill);
      const group = document.querySelector("[role='group'][aria-label='Emphasis']")!;
      const children = Array.from(group.children);
      expect(children).toHaveLength(3);
      const split = children[2];
      expect(split.classList.contains("split")).toBe(true);
      expect(split.querySelector(":scope > .split-main")?.getAttribute("data-testid")).toBe("fmt-underline");
      expect(split.querySelector(":scope > .split-chevron")?.getAttribute("data-testid")).toBe("fmt-underline-options");
    });
  }

  it("still opens its menu and runs from inside the pill", async () => {
    await render("none", SURFACES[0], pill);
    click(byTestId("fmt-underline-options"));
    click(byTestId("fmt-underline-double"));
    await settle();
    expect(applyFormat).toHaveBeenCalledWith({ underline: "double" }, "Double Underline");
  });
});

// ============================================================================
// Refusals
// ============================================================================

describe("refusals", () => {
  it("a door that throws reaches the user (face)", async () => {
    applyFormat.mockRejectedValueOnce(new Error("Cell A1 is locked."));
    await render("none");
    click(byTestId("fmt-underline"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Cell A1 is locked.");
  });

  it("a door that throws reaches the user (row)", async () => {
    applyFormat.mockRejectedValueOnce(new Error("Nope."));
    await render("none");
    click(byTestId("fmt-underline-options"));
    click(byTestId("fmt-underline-double"));
    await settle();
    expect(dialogs.alertAsync).toHaveBeenCalledWith("Nope.");
  });
});
