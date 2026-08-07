//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabCustomizeDialog.test.tsx
// PURPOSE: The two things that would have embarrassed us within 30 seconds of
//          the Customize entry point shipping: "Row Break" could never be
//          added, and Reset-then-Cancel silently reset anyway.
// CONTEXT: Both were latent while the dialog was unreachable. The separator
//          bug also had a tail — remove/move keyed on ITEM ID, so with two row
//          breaks in a group, removing one removed both and the arrows on the
//          second moved the first. Those are asserted here too, because fixing
//          the used-set is what makes them reachable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// homeTabIcons reads the ribbon icon set off the @api barrel; a stub keeps the
// barrel (which reaches every extension) out of this test's module graph.
vi.mock("@api", () => {
  const Stub = () => null;
  return { RibbonIcon: new Proxy({}, { get: () => Stub }) };
});

import { HomeTabCustomizeDialog } from "../components/HomeTabCustomizeDialog";
import { DEFAULT_LAYOUT, LAYOUT_VERSION, type HomeTabLayout } from "../homeTabConfig";

const STORAGE_KEY = "calcula.homeTab.layout";

/** A saved layout with TWO row breaks in one group — the shape that makes the
 *  equality-keyed remove/move visibly wrong. */
const SAVED: HomeTabLayout = {
  version: LAYOUT_VERSION,
  groups: [
    {
      id: "font",
      label: "Font",
      iconId: "font",
      collapsePriority: 20,
      items: ["bold", "rowBreak", "italic", "rowBreak"],
    },
  ],
};

// --- Harness ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let closed: number;
let layoutChangedEvents: number;
const onLayoutChanged = () => {
  layoutChangedEvents += 1;
};

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(HomeTabCustomizeDialog, {
        isOpen: true,
        onClose: () => {
          closed += 1;
        },
      } as never)
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function press(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

/** Direct-child text of an element, i.e. its own label with any icon child
 *  (a glyph span such as "B" for Bold) excluded. */
function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join("")
    .trim();
}

/** A button in the "Available Commands" palette, or one of the footer's. */
function paletteButton(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (b) => ownText(b) === label
  );
  if (!found) throw new Error(`No palette button labelled "${label}"`);
  return found as HTMLButtonElement;
}

/** The placed items of the (single) group, in DOM order — one chip per entry,
 *  anchored on the remove affordance every chip carries. */
function chips(): HTMLElement[] {
  return Array.from(container.querySelectorAll('span[title="Remove item"]')).map(
    (x) => x.parentElement as HTMLElement
  );
}

function chipLabels(): string[] {
  return chips().map(ownText);
}

function chipControl(index: number, title: string): Element {
  const found = chips()[index].querySelector(`[title="${title}"]`);
  if (!found) throw new Error(`Chip ${index} has no "${title}" control`);
  return found;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(SAVED));
  closed = 0;
  layoutChangedEvents = 0;
  window.addEventListener("homeTab:layoutChanged", onLayoutChanged);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.removeEventListener("homeTab:layoutChanged", onLayoutChanged);
});

// ============================================================================
// The separator
// ============================================================================

describe("Row Break", () => {
  it("is offered, not greyed out, even though the layout already uses it", async () => {
    await render();
    // The used-set is what disabled it: rowBreak is placed twice already.
    expect(paletteButton("Row Break").disabled).toBe(false);
  });

  it("can be added repeatedly", async () => {
    await render();
    expect(chipLabels()).toEqual(["Bold", "Row Break", "Italic", "Row Break"]);

    await press(paletteButton("Row Break"));
    await press(paletteButton("Row Break"));

    expect(chipLabels()).toEqual([
      "Bold",
      "Row Break",
      "Italic",
      "Row Break",
      "Row Break",
      "Row Break",
    ]);
  });

  it("still refuses a SECOND copy of a normal command", async () => {
    await render();
    expect(paletteButton("Bold").disabled).toBe(true);
    expect(paletteButton("Italic").disabled).toBe(true);
    // ...and offers one that is not placed yet
    expect(paletteButton("Underline").disabled).toBe(false);
  });

  it("removes only the copy that was clicked", async () => {
    await render();
    await press(chipControl(3, "Remove item"));
    // Equality-keyed removal took both row breaks with it.
    expect(chipLabels()).toEqual(["Bold", "Row Break", "Italic"]);
  });

  it("moves the copy that was clicked, not the first one", async () => {
    await render();
    await press(chipControl(3, "Move left"));
    // indexOf() always found index 1, so this used to produce
    // ["Row Break", "Bold", "Italic", "Row Break"].
    expect(chipLabels()).toEqual(["Bold", "Row Break", "Row Break", "Italic"]);
  });
});

// ============================================================================
// Reset
// ============================================================================

describe("Reset to Default", () => {
  it("followed by Cancel leaves storage untouched", async () => {
    await render();
    const before = localStorage.getItem(STORAGE_KEY);

    await press(paletteButton("Reset to Default"));
    // The staged reset is visible in the dialog...
    expect(chipLabels()[0]).toBe("Paste");

    await press(paletteButton("Cancel"));

    // ...and nothing was committed.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(layoutChangedEvents).toBe(0);
    expect(closed).toBe(1);
  });

  it("followed by Save commits the default layout", async () => {
    await render();

    await press(paletteButton("Reset to Default"));
    await press(paletteButton("Save"));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as HomeTabLayout;
    expect(stored.groups.map((g) => g.id)).toEqual(DEFAULT_LAYOUT.groups.map((g) => g.id));
    expect(stored.groups.map((g) => g.items)).toEqual(DEFAULT_LAYOUT.groups.map((g) => g.items));
    expect(stored.version).toBe(LAYOUT_VERSION);
    expect(layoutChangedEvents).toBe(1);
    expect(closed).toBe(1);
  });
});

// ============================================================================
// Save
// ============================================================================

describe("Save", () => {
  it("persists an edit and announces it", async () => {
    await render();
    await press(paletteButton("Underline"));
    await press(paletteButton("Save"));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as HomeTabLayout;
    expect(stored.groups[0].items).toEqual(["bold", "rowBreak", "italic", "rowBreak", "underline"]);
    expect(stored.groups[0].collapsePriority).toBe(20);
    expect(layoutChangedEvents).toBe(1);
  });

  it("drops a group that would render as an empty section", async () => {
    // A group holding only row breaks paints no button at all.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_VERSION,
        groups: [
          { id: "font", label: "Font", items: ["bold"] },
          { id: "breaks", label: "Breaks", items: ["rowBreak"] },
        ],
      })
    );
    await render();
    await press(paletteButton("Save"));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as HomeTabLayout;
    expect(stored.groups.map((g) => g.id)).toEqual(["font"]);
  });

  it("cancelling an edit writes nothing", async () => {
    await render();
    const before = localStorage.getItem(STORAGE_KEY);
    await press(paletteButton("Underline"));
    await press(paletteButton("Cancel"));
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(layoutChangedEvents).toBe(0);
  });
});
