//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/clipboard/pasteSplitButtonDoor.test.tsx
// PURPOSE: The Paste split button's main half and its "Paste" row run ONE
//          door -- the one Ctrl+V runs: on a canvas the canvas's object paste,
//          on a worksheet the cell paste -- through the REAL useHomeTabState
//          and the REAL @api/objectClipboard rule.
// CONTEXT: Home tab = Excel's Home tab, home-clipboard lane (2026-10-04;
//          contract 3.1: 'The "Paste" row runs the same door as the main
//          half'). The rule itself is pinned by
//          src/api/__tests__/objectClipboardDoorRule.test.ts, which also
//          requires the clipboardDoorCommand("paste") call to stay in
//          useHomeTabState.ts; this file proves the split button reaches it
//          from both of its doors, and that the canvas greys the cell variants
//          through the same canvasOwnsObjectClipboard() the commands ask.
//          Mocks follow homeTabObjectClipboard.test.tsx.

/* eslint-disable @typescript-eslint/naming-convention --
 * The @api double exports RibbonIcon and the @api/ui double DialogExtensions
 * under their real names. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const grid = vi.hoisted(() => ({
  state: { surface: "grid" as "grid" | "canvas", selection: null as unknown },
}));
vi.mock("../../../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => grid.state,
}));
vi.mock("@api", async () => {
  const icons = await import("@api/ribbonIcons");
  return {
    RibbonIcon: icons.RibbonIcon,
    useGridState: () => grid.state,
    cellEvents: { emit: vi.fn() },
  };
});
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => grid.state,
}));
vi.mock("@api/ui", () => ({ DialogExtensions: { openDialog: vi.fn() } }));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn() }));
const clip = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@api/lib", () => ({
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async () => ({ bold: false, fontSize: 11 })),
  applyFormatting: vi.fn(async () => ({ cells: [] })),
  setCellRichText: vi.fn(async () => undefined),
  getInternalClipboard: () => clip.value,
}));
vi.mock("../../../../_shared/lib/fontList", () => ({ FONT_SIZES: [8, 11, 14] }));

import { SurfaceLayoutProvider, bandLayout } from "@api/layout";
import { initKeybindings } from "@api/keybindings";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { OBJECT_PASTE_COMMAND } from "@api/objectClipboard";
import { ITEMS_BY_ID } from "../../homeTabConfig";
import { useHomeTabState } from "../../components/useHomeTabState";
import { PasteSplitButton } from "../../components/clipboard/PasteSplitButton";

const COMMANDS = [OBJECT_PASTE_COMMAND, CoreCommands.PASTE, CoreCommands.PASTE_VALUES];

let container: HTMLDivElement;
let root: Root;
const ran: string[] = [];

/** The button with the group's REAL state, as HomeTabGroupComponent mounts it. */
function Group(): React.ReactElement {
  const state = useHomeTabState();
  return <PasteSplitButton item={ITEMS_BY_ID.get("paste")!} state={state} band />;
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  initKeybindings();
});

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ran.length = 0;
  grid.state = { surface: "grid", selection: null };
  clip.value = { cells: [[{ row: 0, col: 0, display: "1" }]], isCut: false };
  for (const id of COMMANDS) CommandRegistry.register(id, () => void ran.push(id));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={bandLayout(1200)}>
        <Group />
      </SurfaceLayoutProvider>,
    );
  });
});

afterEach(async () => {
  for (const id of COMMANDS) CommandRegistry.unregister(id);
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
});

function byTestId(id: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no ${id}`);
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function pasteBothWays(): Promise<void> {
  await click(byTestId("fmt-paste"));
  await click(byTestId("fmt-paste-options"));
  await click(byTestId("fmt-paste-paste"));
}

describe("one door for the main half and the Paste row", () => {
  it("on a canvas both run the canvas's object paste", async () => {
    grid.state = { surface: "canvas", selection: null };
    await pasteBothWays();
    expect(ran, "a door ran the grid's cell paste on a page with no cells").toEqual([
      OBJECT_PASTE_COMMAND,
      OBJECT_PASTE_COMMAND,
    ]);
  });

  it("on a worksheet both run the cell paste (positive control)", async () => {
    await pasteBothWays();
    expect(ran).toEqual([CoreCommands.PASTE, CoreCommands.PASTE]);
  });

  it("on a canvas the cell variants are greyed by the commands' own canvas question", async () => {
    grid.state = { surface: "canvas", selection: null };
    await click(byTestId("fmt-paste-options"));
    expect(byTestId("fmt-paste-paste").disabled).toBe(false);
    expect(byTestId("fmt-paste-values").disabled).toBe(true);
    expect(byTestId("fmt-paste-values").getAttribute("data-unavailable")).toBe("canvas");
  });

  it("on a worksheet with cells copied the variants run (positive control)", async () => {
    await click(byTestId("fmt-paste-options"));
    await click(byTestId("fmt-paste-values"));
    expect(ran).toEqual([CoreCommands.PASTE_VALUES]);
  });
});
