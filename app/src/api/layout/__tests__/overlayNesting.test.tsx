// Tests for the NESTING rule (Menu.tsx header, ribbon-design-system 5.5) as it
// applies to Escape, for every overlay a collapsed group's Launcher flyout can
// open -- not only Menu and Dropdown, which followed it from the start:
//
//   - a plain Popover (the Home tab's Cell Styles gallery is one);
//   - RegisteredMenuButton's customContent card (Format as Table's gallery);
//   - the split ColorSwatch's palette (Font Color / Fill Color).
//
// The defect (fix-kit review, 2026-10-04): Escape inside any of these, in a
// collapsed group's flyout, ALSO closed the flyout. The Launcher listens on
// `document` and ran first; the overlay's own document listener then sent focus
// to its trigger -- which was inside the flyout being unmounted -- so focus fell
// to <body>. Excel closes only the gallery and leaves focus on its button.
//
// Pinned here, per overlay: Escape with focus INSIDE the overlay closes only
// the overlay and puts focus on its trigger; Escape with focus left on the
// trigger (a pointer open) closes only the overlay; the NEXT Escape closes the
// flyout (the positive control: the Launcher still answers when nothing is
// nested). The same holds one level in, where the outer overlay is a card
// Popover or a MenuSub flyout and focus sits on the palette's trigger INSIDE
// it. And the Launcher leaves alone an Escape something inside it has already
// handled (defaultPrevented).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const { paletteMock } = vi.hoisted(() => ({ paletteMock: vi.fn() }));

// The theme palette is a Tauri round-trip in the app (see color.test.tsx).
vi.mock("../../theme", () => ({ getThemeColorPalette: paletteMock }));

import { SurfaceLayoutProvider, bandLayout } from "../context";
import { Launcher } from "../primitives/Launcher";
import { Popover } from "../primitives/Popover";
import { CommandButton } from "../primitives/Button";
import { RegisteredMenuButton } from "../primitives/MenuTree";
import { ColorSwatch } from "../primitives/Color";
import { MenuButton, MenuSub } from "../primitives/Menu";
import { registerMenu, unregisterMenu } from "../../ui";

let container: HTMLDivElement;
let root: Root;
let seq = 0;
let menuId = "";

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  paletteMock.mockReset();
  paletteMock.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  seq += 1;
  menuId = `nesting-format-${seq}`;
  act(() => {
    registerMenu({
      id: menuId,
      label: "Format",
      order: 1,
      items: [
        {
          id: "format:formatAsTable",
          label: "Format as Table",
          customContent: () => (
            <div data-testid="table-gallery">
              <button type="button" data-testid="table-style">
                Medium 2
              </button>
            </div>
          ),
        },
      ],
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  act(() => unregisterMenu(menuId));
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Flush the palette promise and any deferred focus, inside act. */
async function settle(): Promise<void> {
  for (let round = 0; round < 2; round++) {
    await act(async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** A POINTER click (detail 1): opens without moving focus anywhere. */
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

function key(el: Element, k: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no element with data-testid "${id}"`);
  return el;
}

function maybe(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid='${id}']`);
}

/** The Launcher's own flyout (the first section flyout: it opened first). */
function launcherFlyout(): HTMLElement | null {
  const button = maybe("launch");
  const id = button?.getAttribute("aria-controls");
  return id ? document.getElementById(id) : null;
}

/** A plain Popover opened from a button, the way CellStylesButton opens its
 *  gallery: a wrapper anchor, no Escape handling of its own. */
function PlainGallery(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setAnchor}>
      <button type="button" data-testid="plain-trigger" onClick={() => setOpen((o) => !o)}>
        Cell Styles
      </button>
      <Popover anchorEl={anchor} open={open} onClose={() => setOpen(false)} ariaLabel="Cell Styles">
        <div data-testid="plain-gallery">
          <button type="button" data-testid="plain-style">
            Good
          </button>
        </div>
      </Popover>
    </div>
  );
}

function TableGallery(): React.ReactElement {
  return (
    <RegisteredMenuButton
      menuId={menuId}
      itemId="format:formatAsTable"
      trigger={<CommandButton icon={<span />} label="Format as Table" chevron data-testid="table-trigger" />}
    />
  );
}

function FontColor(): React.ReactElement {
  return (
    <ColorSwatch
      split
      variant="bar"
      color="#ff0000"
      label="Font Color"
      testId="font-color"
      chevronTestId="font-color-options"
      onApply={() => undefined}
      onChange={() => undefined}
    />
  );
}

interface Case {
  name: string;
  overlay: () => React.ReactElement;
  /** The control that opens the overlay (where focus must come back to). */
  trigger: string;
  /** Something focusable inside the open overlay. */
  inside: () => HTMLElement;
  /** Present exactly while the overlay is open. */
  body: string;
}

const CASES: Case[] = [
  { name: "a plain Popover (the Cell Styles idiom)", overlay: PlainGallery, trigger: "plain-trigger", inside: () => byTestId("plain-style"), body: "plain-gallery" },
  { name: "RegisteredMenuButton's gallery card (Format as Table)", overlay: TableGallery, trigger: "table-trigger", inside: () => byTestId("table-style"), body: "table-gallery" },
  { name: "the split ColorSwatch's palette (Font Color)", overlay: FontColor, trigger: "font-color-options", inside: () => byTestId("font-color-popover").querySelector<HTMLElement>("[data-colour-swatch]")!, body: "font-color-popover" },
];

function renderCollapsed(overlay: () => React.ReactElement): void {
  const Overlay = overlay;
  act(() => {
    root.render(
      <SurfaceLayoutProvider value={bandLayout()}>
        <Launcher label="Styles" testId="launch">
          <Overlay />
        </Launcher>
      </SurfaceLayoutProvider>,
    );
  });
}

async function openBoth(c: Case): Promise<void> {
  renderCollapsed(c.overlay);
  await click(byTestId("launch"));
  expect(launcherFlyout()).not.toBeNull();
  await click(byTestId(c.trigger));
  await settle();
  expect(maybe(c.body)).not.toBeNull();
}

describe.each(CASES)("Escape in $name inside a collapsed group's flyout", (c) => {
  it("with focus INSIDE the overlay closes only the overlay, focus back on its trigger, and never reaches document", async () => {
    await openBoth(c);
    const inside = c.inside();
    act(() => inside.focus());
    expect(document.activeElement).toBe(inside);

    const heardAtDocument = vi.fn();
    document.addEventListener("keydown", heardAtDocument);
    try {
      const event = key(inside, "Escape");
      expect(event.defaultPrevented).toBe(true);
    } finally {
      document.removeEventListener("keydown", heardAtDocument);
    }

    expect(maybe(c.body)).toBeNull();
    expect(launcherFlyout()).not.toBeNull();
    expect(byTestId("launch").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(byTestId(c.trigger));
    expect(heardAtDocument).not.toHaveBeenCalled();

    // Positive control: with nothing nested, the next Escape is the flyout's.
    key(byTestId(c.trigger), "Escape");
    expect(launcherFlyout()).toBeNull();
    expect(document.activeElement).toBe(byTestId("launch"));
  });

  it("with focus left on the trigger (a pointer open) closes only the overlay", async () => {
    await openBoth(c);
    const trigger = byTestId(c.trigger);
    act(() => trigger.focus());

    key(trigger, "Escape");

    expect(maybe(c.body)).toBeNull();
    expect(launcherFlyout()).not.toBeNull();
    expect(document.activeElement).toBe(trigger);

    key(trigger, "Escape");
    expect(launcherFlyout()).toBeNull();
    expect(document.activeElement).toBe(byTestId("launch"));
  });
});

describe("A Popover nested in a Popover (a palette in a card)", () => {
  function CardWithPalette(): React.ReactElement {
    const [open, setOpen] = useState(true);
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
    return (
      <>
        <button type="button" ref={setAnchor} data-testid="card-anchor">
          Format
        </button>
        <Popover anchorEl={anchor} open={open} onClose={() => setOpen(false)} card ariaLabel="Card">
          <div data-testid="card-body">
            <FontColor />
          </div>
        </Popover>
      </>
    );
  }

  it("Escape with focus on the palette's trigger (a pointer open) closes the palette only; the next one the card", async () => {
    act(() => {
      root.render(<CardWithPalette />);
    });
    await click(byTestId("font-color-options"));
    await settle();
    expect(maybe("font-color-popover")).not.toBeNull();
    const chevron = byTestId("font-color-options");
    act(() => chevron.focus());

    key(chevron, "Escape");
    expect(maybe("font-color-popover")).toBeNull();
    expect(maybe("card-body")).not.toBeNull();
    expect(document.activeElement).toBe(chevron);

    key(chevron, "Escape");
    expect(maybe("card-body")).toBeNull();
    expect(document.activeElement).toBe(byTestId("card-anchor"));
  });
});

describe("A palette opened from a MenuSub flyout's custom content", () => {
  it("Escape with focus on its trigger closes the palette only; the next one the flyout level", async () => {
    act(() => {
      root.render(
        <MenuButton trigger={<button type="button" data-testid="menu-trigger">Borders</button>}>
          <MenuSub label="Line Color" testId="line-color">
            <FontColor />
          </MenuSub>
        </MenuButton>,
      );
    });
    await click(byTestId("menu-trigger"));
    key(byTestId("line-color"), "ArrowRight");
    await click(byTestId("font-color-options"));
    await settle();
    expect(maybe("font-color-popover")).not.toBeNull();
    const chevron = byTestId("font-color-options");
    act(() => chevron.focus());

    key(chevron, "Escape");
    expect(maybe("font-color-popover")).toBeNull();
    expect(maybe("font-color-options")).not.toBeNull();
    expect(document.activeElement).toBe(chevron);

    // Positive control: nothing nested now, so Escape is the level's again.
    key(chevron, "Escape");
    expect(maybe("font-color-options")).toBeNull();
    expect(document.activeElement).toBe(byTestId("line-color"));
  });
});

describe("Launcher: an Escape already handled inside it", () => {
  it("is left alone (defaultPrevented); an unhandled one still closes the flyout", async () => {
    act(() => {
      root.render(
        <SurfaceLayoutProvider value={bandLayout()}>
          <Launcher label="Font" testId="launch">
            <input
              data-testid="consumes"
              onKeyDown={(e) => {
                if (e.key === "Escape") e.preventDefault();
              }}
            />
            <button type="button" data-testid="plain">
              Plain
            </button>
          </Launcher>
        </SurfaceLayoutProvider>,
      );
    });
    await click(byTestId("launch"));
    const consumes = byTestId("consumes");
    act(() => consumes.focus());
    key(consumes, "Escape");
    expect(launcherFlyout()).not.toBeNull();
    expect(document.activeElement).toBe(consumes);

    const plain = byTestId("plain");
    act(() => plain.focus());
    key(plain, "Escape");
    expect(launcherFlyout()).toBeNull();
    expect(document.activeElement).toBe(byTestId("launch"));
  });
});

describe("Popover on its own (no outer overlay)", () => {
  it("Escape inside it still closes it and returns focus to the anchor", async () => {
    act(() => {
      root.render(<PlainGallery />);
    });
    await click(byTestId("plain-trigger"));
    const style = byTestId("plain-style");
    act(() => style.focus());
    key(style, "Escape");
    expect(maybe("plain-gallery")).toBeNull();
    expect(document.activeElement).toBe(byTestId("plain-trigger"));
  });

  it("an Escape the content already handled (defaultPrevented) is left to the document rule, as before", async () => {
    function Consuming(): React.ReactElement {
      const [open, setOpen] = useState(true);
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
      return (
        <>
          <button type="button" ref={setAnchor} data-testid="anchor">
            A
          </button>
          <Popover anchorEl={anchor} open={open} onClose={() => setOpen(false)}>
            <input
              data-testid="field"
              onKeyDown={(e) => {
                if (e.key === "Escape") e.preventDefault();
              }}
            />
          </Popover>
        </>
      );
    }
    act(() => {
      root.render(<Consuming />);
    });
    const field = byTestId("field");
    act(() => field.focus());
    const heardAtDocument = vi.fn();
    document.addEventListener("keydown", heardAtDocument);
    try {
      key(field, "Escape");
    } finally {
      document.removeEventListener("keydown", heardAtDocument);
    }
    // The root did not swallow it: the document listener (the historical
    // path) still heard it and closed the popover.
    expect(heardAtDocument).toHaveBeenCalledTimes(1);
    expect(maybe("field")).toBeNull();
  });
});
