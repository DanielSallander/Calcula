//! FILENAME: app/extensions/RemoveDuplicates/__tests__/removeDuplicatesDialogLayout.test.tsx
// PURPOSE: Pin the Remove Duplicates dialog's list-first shape.
// CONTEXT: The dialog was a fixed 420px box whose column list had a hard
//          `max-height: 200px` and no way to enlarge it — with a 20-column
//          import you scrolled nine rows through a straw while ~340px of label
//          width sat empty on every row, and there was no resize handle to drag.
//          The fix is structural, so the test is structural: the LIST is the
//          element that scrolls and the element that grows, the checkboxes flow
//          into columns only once there are enough of them to justify it, and
//          the backdrop's containment test still works now that the box carries
//          useDialogWindow's ref instead of its own.
//
//          Nothing guarded this file before.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Mocks — @api only. @api/dialogLayout and @api/dialogWindow are the units
// under test and stay real.
// ---------------------------------------------------------------------------

const region = { value: null as null | [number, number, number, number] };

vi.mock("@api", () => ({
  detectDataRegion: vi.fn(async () => region.value),
  getViewportCells: vi.fn(async () => []),
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  removeDuplicates: vi.fn(async () => ({
    success: true,
    duplicatesRemoved: 0,
    uniqueRemaining: 0,
  })),
}));

import { RemoveDuplicatesDialog } from "../components/RemoveDuplicatesDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

beforeEach(() => {
  region.value = [0, 0, 10, 3]; // 4 columns by default
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/**
 * Mount the dialog over a region that is `columnCount` columns wide. The key
 * forces a fresh instance — the region is read once, in a mount effect, so a
 * plain re-render would keep the columns the first call detected.
 */
async function open(columnCount: number): Promise<void> {
  region.value = [0, 0, 10, columnCount - 1];
  await act(async () => {
    root.render(
      <RemoveDuplicatesDialog
        key={columnCount}
        isOpen
        onClose={onClose}
        data={{ activeRow: 0, activeCol: 0 }}
      />,
    );
  });
}

const list = () =>
  container.querySelector(
    '[data-testid="remove-duplicates-column-list"]',
  ) as HTMLElement;
/** The dialog box: list -> body -> box. */
const box = () => list().parentElement!.parentElement as HTMLElement;
const checkboxes = () =>
  [...list().querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];

function mouseDown(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

// ---------------------------------------------------------------------------

describe("Remove Duplicates dialog layout", () => {
  it("renders one checkbox per column, however many there are", async () => {
    await open(20);
    expect(checkboxes()).toHaveLength(20);
    // The fallback label still carries the sheet column, so grid POSITION never
    // has to stand in for the column's identity.
    expect(list().textContent).toContain("Column A");
    expect(list().textContent).toContain("Column T");
  });

  it("makes the LIST the scrolling element, not the dialog box", async () => {
    await open(20);
    expect(list().style.overflowY).toBe("auto");
    // ...and the thing that GROWS: without this, dragging the dialog taller
    // only adds dead space under a list that is still a straw.
    expect(list().style.flex).toBe("1 1 auto");
    expect(list().style.maxHeight).toBe("");

    const dialogBox = box();
    expect(dialogBox.style.overflowY).not.toBe("auto");
    expect(dialogBox.style.overflowY).not.toBe("scroll");
    // The ceiling is on the BOX, so the list takes everything below the
    // controls and a taller dialog shows more columns rather than more air.
    expect(dialogBox.style.maxHeight).toBe("min(560px, 88vh)");
    // The body hands its height down instead of sizing to content.
    const body = list().parentElement as HTMLElement;
    expect(body.style.flex).toBe("1 1 0%"); // jsdom's serialization of `flex: 1`
    expect(body.style.minHeight).toBe("0px");
  });

  it("keeps the drag handle and the OK button out of the scroller", async () => {
    await open(20);
    const dialogBox = box();
    const header = dialogBox.firstElementChild as HTMLElement;
    const footer = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Cancel",
    )!.parentElement as HTMLElement;

    expect(header.textContent).toContain("Remove Duplicates");
    expect(header.style.flexShrink).toBe("0");
    expect(footer.style.flexShrink).toBe("0");
    // Both are siblings of the body, so neither can be scrolled away.
    expect(list().parentElement!.parentElement).toBe(dialogBox);
    expect(footer.parentElement).toBe(dialogBox);
    expect(list().contains(footer)).toBe(false);
  });

  it("flows the checkboxes into columns ONLY once there are enough of them", async () => {
    await open(4);
    // The common case is left exactly as it was: one flex column of labels.
    expect(checkboxes()).toHaveLength(4);
    expect((list().firstElementChild as HTMLElement).style.display).not.toBe("grid");
    expect((list().firstElementChild as HTMLElement).tagName).toBe("LABEL");

    await open(20);
    const grid = list().firstElementChild as HTMLElement;
    expect(grid.style.display).toBe("grid");
    // auto-fit, so dragging the dialog narrow collapses it back with no code.
    expect(grid.style.gridTemplateColumns).toContain("auto-fit");
    expect(checkboxes()).toHaveLength(20);
  });

  // The width itself (min(420px, 94vw) / 520 / 640) is deliberately NOT
  // asserted: jsdom's CSS parser accepts `min()` for max-height but drops it
  // for `width`, so the property reads back empty here whatever the component
  // set. The threshold it shares with the grid is covered by the test above.

  it("is a resizable window whose header is the drag handle", async () => {
    await open(4);
    const dialogBox = box();
    expect(dialogBox.style.position).toBe("relative");
    // 8 resize zones, rendered as the box's last children.
    const handles = [...dialogBox.children].filter(
      (c) => (c as HTMLElement).style.position === "absolute",
    );
    expect(handles).toHaveLength(8);
  });

  it("puts every list-wide control on one row directly above the list", async () => {
    await open(4);
    const row = list().previousElementSibling as HTMLElement;
    expect(row.style.justifyContent).toBe("space-between");
    expect(row.textContent).toContain("My data has headers");
    expect(row.textContent).toContain("Select All");
    expect(row.textContent).toContain("Unselect All");
  });

  it("still closes on a backdrop mousedown and NOT on one inside the box", async () => {
    await open(4);
    // The box now carries useDialogWindow's ref; the containment test has to
    // follow it, or every click inside the dialog would dismiss it.
    mouseDown(list());
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = box().parentElement as HTMLElement;
    mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps its own box for the no-data notice, which still dismisses", async () => {
    region.value = null;
    await act(async () => {
      root.render(
        <RemoveDuplicatesDialog
          isOpen
          onClose={onClose}
          data={{ activeRow: 0, activeCol: 0 }}
        />,
      );
    });
    const notice = container.firstElementChild!.firstElementChild as HTMLElement;
    expect(notice.textContent).toContain("No data detected");

    mouseDown(notice);
    expect(onClose).not.toHaveBeenCalled();

    mouseDown(container.firstElementChild!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
