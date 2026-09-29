//! FILENAME: app/extensions/Controls/__tests__/controlClipboardQueue.test.ts
// PURPOSE: Controls' own WORKSHEET doors (Ctrl+C / Ctrl+D and the right-click
//          Copy / Duplicate) run on the object clipboard's queue and read the
//          selection only when their turn comes (wave C review of W25). A
//          second Ctrl+D pressed while the first was still landing used to
//          start at once: it joined the first's open undo transaction and,
//          having read the selection before the first's copies were selected,
//          duplicated the ORIGINALS again -- a hidden copy stacked exactly on
//          each visible one. Queued, each Ctrl+D is its own step and the second
//          duplicates the first's copies (Excel's cascade).
// CONTEXT: The real key door (lib/controlKeys.ts) through the real keybinding
//          dispatcher, and the real menu (lib/controlContextMenu.ts); the
//          Controls clipboard leaves are doubles that take a round trip and
//          select their copies, as `duplicateControls` does.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const st = vi.hoisted(() => ({ surface: "grid" as "grid" | "canvas", menuCalls: [] as string[] }));
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ surface: st.surface }),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: vi.fn(),
}));
const menuCalls = st.menuCalls;
vi.mock("../lib/controlClipboard", () => ({
  copyControls: async (ids: readonly string[]) => {
    st.menuCalls.push(`copy:${ids.join(",")}`);
  },
  duplicateControls: async (ids: readonly string[]) => {
    st.menuCalls.push(`duplicate:${ids.join(",")}`);
  },
  pasteControl: async () => {},
  hasClipboardControl: () => true,
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAppEvent: vi.fn(),
}));

import { initKeybindings } from "@api/keybindings";
import { resetObjectClipboard, runObjectClipboardAction } from "@api/objectClipboard";
import { installControlClipboardKeys, type ControlClipboardKeyDeps } from "../lib/controlKeys";
import { buildControlObjectMenu } from "../lib/controlContextMenu";
import { addFloatingControl, resetFloatingStore } from "../lib/floatingStore";
import { deselectFloatingControl, selectFloatingControls } from "../Button/floatingSelection";

initKeybindings();

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

let selected: string[] = [];
const events: string[] = [];
let seq = 0;
const deps = {
  selectedIds: () => selected,
  hasClipboard: () => true,
  copy: vi.fn(async (ids: readonly string[]) => {
    events.push(`copy:${ids.join(",")}`);
  }),
  paste: vi.fn(async () => {}),
  // A duplicate takes a round trip, then its copies become the selection.
  duplicate: vi.fn(async (ids: readonly string[]) => {
    events.push(`start:${ids.join(",")}`);
    await tick(10);
    selected = ids.map((id) => `${id}+${++seq}`);
    events.push(`end:${selected.join(",")}`);
  }),
  group: vi.fn(),
} satisfies ControlClipboardKeyDeps;

let grid: HTMLDivElement;
let uninstall: (() => void) | null = null;

function press(key: string): void {
  grid.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  st.surface = "grid";
  selected = ["a", "b"];
  events.length = 0;
  menuCalls.length = 0;
  seq = 0;
  resetObjectClipboard();
  grid = document.createElement("div");
  grid.setAttribute("data-focus-container", "spreadsheet");
  grid.tabIndex = 0;
  document.body.appendChild(grid);
  grid.focus();
  uninstall = installControlClipboardKeys("calcula.controls", deps);
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  grid.remove();
});

describe("Controls' worksheet keys run one at a time, in key order", () => {
  it("a second Ctrl+D pressed while the first is landing waits for it and duplicates the first's COPIES", async () => {
    press("d");
    await tick(3); // the second key press, 3 ms later
    press("d");
    await tick(40);
    expect(events, "the second Ctrl+D started before the first had landed (it joins the first's undo step)").toEqual([
      "start:a,b",
      "end:a+1,b+2",
      "start:a+1,b+2",
      "end:a+1+3,b+2+4",
    ]);
  });

  it("Ctrl+D then Ctrl+C: the copy takes the duplicate's copies (the selection when its turn comes)", async () => {
    press("d");
    press("c");
    await tick(30);
    expect(events).toEqual(["start:a,b", "end:a+1,b+2", "copy:a+1,b+2"]);
  });
});

describe("Controls' worksheet menu waits its turn too", () => {
  const BUTTON = "control-0-1-1";

  beforeEach(() => {
    resetFloatingStore();
    deselectFloatingControl();
    addFloatingControl({ id: BUTTON, sheetIndex: 0, row: 1, col: 1, x: 100, y: 50, width: 80, height: 24, controlType: "button" });
    selectFloatingControls([BUTTON]);
  });

  it("a menu Duplicate right behind a Ctrl+D still landing runs after it", async () => {
    const order: string[] = [];
    const landing = runObjectClipboardAction(async () => {
      await tick(15);
      order.push("ctrl+d landed");
    });
    const item = buildControlObjectMenu(BUTTON).find((i) => i.id === "controls.duplicate");
    expect(item).toBeTruthy();
    item!.run();
    await tick(0);
    order.push(...menuCalls.splice(0));
    await landing;
    await tick(5);
    order.push(...menuCalls.splice(0));
    expect(order, "the menu Duplicate ran while the Ctrl+D before it was still landing").toEqual([
      "ctrl+d landed",
      `duplicate:${BUTTON}`,
    ]);
  });
});
