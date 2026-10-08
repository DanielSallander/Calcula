//! FILENAME: app/extensions/Controls/__tests__/buttonActionPerform.test.ts
// PURPOSE: What a button's DECLARATIVE action does when it is clicked (Canvas
//          contract §3/§4.4) -- lib/buttonActions.ts:
//            * navigate: switch to the page by its stable id, by its NAME when
//              the id is unknown here (a subscriber's pages were remapped), say
//              so when the page is gone or hidden, do nothing on the page itself;
//            * back: the page history's Back, said when there is nothing to
//              go back to;
//            * clearSlicers: every slicer on the BUTTON's sheet, through the
//              slicer seam; a missing slicer family is said, never "done".
//          And the click route: a button whose action the store knows performs
//          it WITHOUT asking the script door (a navigation button works with
//          scripting off, and on a subscribed report), one without falls
//          through to the door.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  sheets: [] as Array<{ index: number; name: string; visibility: string; sheetId?: string }>,
  activeIndex: 0,
  activations: [] as number[],
  back: { moved: true, sheetName: "Overview" } as { moved: boolean; sheetName?: string },
  backCalls: 0,
  cleared: [] as number[],
  clearResult: 2 as number | Error,
  toasts: [] as Array<{ message: string; variant?: string }>,
}));

vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSheets: async () => ({ sheets: h.sheets.map((s) => ({ ...s })), activeIndex: h.activeIndex }),
}));
vi.mock("@api/sheetSwitch", () => ({
  activateSheet: async (index: number) => {
    h.activations.push(index);
    return { sheets: h.sheets, activeIndex: index };
  },
}));
vi.mock("@api/sheetHistory", () => ({
  goBackSheet: async () => {
    h.backCalls++;
    return h.back;
  },
}));
vi.mock("@api/slicerClearService", () => ({
  clearSlicersOnSheet: async (sheetIndex: number) => {
    h.cleared.push(sheetIndex);
    if (h.clearResult instanceof Error) throw h.clearResult;
    return h.clearResult;
  },
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string, options?: { variant?: string; type?: string }) => {
    h.toasts.push({ message, variant: options?.variant ?? options?.type });
  },
}));

import { performButtonAction, tryStoredButtonAction } from "../lib/buttonActions";
import { addFloatingControl, getAllFloatingControls, removeFloatingControl } from "../lib/floatingStore";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  h.sheets = [
    { index: 0, name: "Data", visibility: "visible", sheetId: "id-data" },
    { index: 1, name: "Overview", visibility: "visible", sheetId: "id-overview" },
    { index: 2, name: "Details", visibility: "visible", sheetId: "id-details" },
    { index: 3, name: "Hidden notes", visibility: "hidden", sheetId: "id-hidden" },
  ];
  h.activeIndex = 1;
  h.activations = [];
  h.back = { moved: true, sheetName: "Overview" };
  h.backCalls = 0;
  h.cleared = [];
  h.clearResult = 2;
  h.toasts = [];
  for (const c of getAllFloatingControls()) removeFloatingControl(c.id);
});

describe("navigate", () => {
  it("switches to the page by its stable id, even after it was renamed", async () => {
    await performButtonAction({ kind: "navigate", sheetId: "id-details", sheetName: "Old name" }, 1);
    expect(h.activations).toEqual([2]);
    expect(h.toasts).toEqual([]);
  });

  // A subscriber's local sheet ids are not the publisher's (pull remaps them),
  // so the name the author picked is the only thing both sides share.
  // SABOTAGE: resolve by id only -> a subscribed navigation button says the
  // page is gone.
  it("falls back to the page NAME when no sheet has that id here", async () => {
    await performButtonAction({ kind: "navigate", sheetId: "publisher-id", sheetName: "Details" }, 1);
    expect(h.activations).toEqual([2]);
  });

  it("matches a name case-insensitively, as sheet names are", async () => {
    await performButtonAction({ kind: "navigate", sheetName: "details" }, 1);
    expect(h.activations).toEqual([2]);
  });

  it("says when the page is gone, and switches nothing", async () => {
    await performButtonAction({ kind: "navigate", sheetId: "nope", sheetName: "Deleted page" }, 1);
    expect(h.activations).toEqual([]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toContain('"Deleted page"');
    expect(h.toasts[0].variant).toBe("warning");
  });

  it("says when the page is hidden, and switches nothing", async () => {
    await performButtonAction({ kind: "navigate", sheetId: "id-hidden", sheetName: "Hidden notes" }, 1);
    expect(h.activations).toEqual([]);
    expect(h.toasts[0].message).toMatch(/hidden/);
  });

  it("does nothing on the page it goes to (a page navigator's own page)", async () => {
    await performButtonAction({ kind: "navigate", sheetId: "id-overview", sheetName: "Overview" }, 1);
    expect(h.activations).toEqual([]);
    expect(h.toasts).toEqual([]);
  });
});

describe("back", () => {
  it("asks the page history", async () => {
    await performButtonAction({ kind: "back" }, 1);
    expect(h.backCalls).toBe(1);
    expect(h.toasts).toEqual([]);
  });

  it("says when there is no previous page", async () => {
    h.back = { moved: false };
    await performButtonAction({ kind: "back" }, 1);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].message).toMatch(/no previous page/i);
  });
});

describe("clearSlicers", () => {
  it("clears the slicers on the BUTTON's sheet", async () => {
    await performButtonAction({ kind: "clearSlicers" }, 3);
    expect(h.cleared).toEqual([3]);
    expect(h.toasts).toEqual([]);
  });

  it("says a failure in the seam's own words", async () => {
    h.clearResult = new Error("Slicers are unavailable: no slicer family is registered.");
    await performButtonAction({ kind: "clearSlicers" }, 3);
    expect(h.toasts).toEqual([
      { message: "The slicers could not be cleared: Slicers are unavailable: no slicer family is registered.", variant: "error" },
    ]);
  });
});

describe("the click route", () => {
  function store(id: string, action?: Parameters<typeof performButtonAction>[0]): void {
    addFloatingControl({
      id,
      sheetIndex: 1,
      row: 0,
      col: 0,
      x: 0,
      y: 0,
      width: 80,
      height: 28,
      controlType: "button",
      ...(action ? { buttonAction: action } : {}),
    });
  }

  // SABOTAGE: return false from tryStoredButtonAction -> the click goes to
  // the script door, which refuses with scripting off.
  it("performs a stored action and tells the caller not to ask the door", async () => {
    store("control-1-0-0", { kind: "navigate", sheetName: "Details" });
    expect(tryStoredButtonAction("control-1-0-0", 1)).toBe(true);
    await flush();
    expect(h.activations).toEqual([2]);
  });

  it("leaves a button without an action to the door", () => {
    store("control-1-0-0");
    expect(tryStoredButtonAction("control-1-0-0", 1)).toBe(false);
    expect(tryStoredButtonAction("control-9-9-9", 1)).toBe(false);
    expect(h.activations).toEqual([]);
  });

  it("never lets a failure escape as an unhandled rejection", async () => {
    store("control-1-0-0", { kind: "clearSlicers" });
    h.clearResult = new Error("boom");
    expect(tryStoredButtonAction("control-1-0-0", 1)).toBe(true);
    await flush();
    await flush();
    expect(h.toasts.map((t) => t.variant)).toEqual(["error"]);
  });
});
