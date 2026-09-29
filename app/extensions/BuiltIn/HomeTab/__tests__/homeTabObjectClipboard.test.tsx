//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabObjectClipboard.test.tsx
// PURPOSE: The Home tab's Copy and Paste buttons on a CANVAS copy and paste the
//          selected OBJECTS -- the canvas's own door, the one Ctrl+C / Ctrl+V
//          reach there -- and keep running the cell clipboard everywhere else.
// CONTEXT: X12 (wave D; wave C canvas review). The buttons executed
//          `core.clipboard.copy` / `core.clipboard.paste`, the grid's cell
//          clipboard, which has nothing to act on on a page with no cells:
//          select a chart on a canvas, click Copy, click Paste -- nothing.
//          The Edit menu had the same gap (StandardMenus
//          editMenuObjectClipboard.test.ts); both ask the question the canvas's
//          key guard asks, minus the focus half a click cannot satisfy.
//
//          Real @api/commands, @api/objectClipboard and @api/objectSelection:
//          the canvas is Core's grid state saying `surface: "canvas"`, and an
//          INNER selection owning the clipboard keys is a real object-selection
//          provider.

/* eslint-disable @typescript-eslint/naming-convention --
 * The @api/ui double exports `DialogExtensions` under its real name. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

const grid = vi.hoisted(() => ({
  state: { surface: "grid" as "grid" | "canvas", selection: null as unknown },
}));
vi.mock("../../../../src/core/state/GridContext", () => ({
  getGridStateSnapshot: () => grid.state,
}));
vi.mock("@api", () => ({
  useGridState: () => grid.state,
  cellEvents: { emit: vi.fn() },
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => grid.state,
}));
vi.mock("@api/ui", () => ({ DialogExtensions: { openDialog: vi.fn() } }));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn() }));
vi.mock("@api/lib", () => ({
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async () => ({ bold: false, fontSize: 11 })),
  applyFormatting: vi.fn(async () => ({ cells: [] })),
  setCellRichText: vi.fn(async () => undefined),
}));
vi.mock("../homeTabConfig", () => ({ ITEMS_BY_ID: new Map() }));
vi.mock("../../../_shared/lib/fontList", () => ({ FONT_SIZES: [8, 11, 14] }));

import { useHomeTabState } from "../components/useHomeTabState";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { registerObjectSelectionProvider, type ObjectSelectionKey } from "@api/objectSelection";
import {
  CANVAS_COPY_SELECTION_COMMAND,
  CANVAS_PASTE_OBJECTS_COMMAND,
} from "../../../CanvasSheet/lib/canvasClipboard";

const COMMANDS = [
  CANVAS_COPY_SELECTION_COMMAND,
  CANVAS_PASTE_OBJECTS_COMMAND,
  CoreCommands.COPY,
  CoreCommands.PASTE,
];

let container: HTMLDivElement;
let root: Root;
type HomeTabState = ReturnType<typeof useHomeTabState>;
let latest: HomeTabState | null = null;
const ran: string[] = [];
const cleanups: (() => void)[] = [];

function Probe({ onState }: { onState: (state: HomeTabState) => void }): React.ReactElement | null {
  const state = useHomeTabState();
  useEffect(() => onState(state));
  return null;
}

async function clickButton(id: "copy" | "paste"): Promise<void> {
  await act(async () => {
    await latest!.handleItemClick({ id } as never);
  });
}

function innerSelectionOwnsClipboard(): void {
  cleanups.push(
    registerObjectSelectionProvider({
      types: ["test-inner"],
      isSelected: () => true,
      select: () => {},
      deselectAll: () => {},
      ownsKey: (key: ObjectSelectionKey) => key === "Clipboard",
    }),
  );
}

beforeEach(async () => {
  ran.length = 0;
  grid.state = { surface: "grid", selection: null };
  for (const id of COMMANDS) CommandRegistry.register(id, () => void ran.push(id));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <Probe
        onState={(state) => {
          latest = state;
        }}
      />,
    );
  });
});

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const id of COMMANDS) CommandRegistry.unregister(id);
  await act(async () => {
    root.unmount();
  });
  container.remove();
  latest = null;
});

describe("Home tab Copy / Paste on a canvas run the canvas's object clipboard", () => {
  it("Copy copies the selected objects, not the cell clipboard", async () => {
    grid.state = { surface: "canvas", selection: null };
    await clickButton("copy");
    expect(ran, "the Copy button ran the grid's cell copy on a page with no cells").toEqual([
      CANVAS_COPY_SELECTION_COMMAND,
    ]);
  });

  it("Paste pastes the copied objects", async () => {
    grid.state = { surface: "canvas", selection: null };
    await clickButton("paste");
    expect(ran, "the Paste button ran the grid's cell paste on a page with no cells").toEqual([
      CANVAS_PASTE_OBJECTS_COMMAND,
    ]);
  });

  it("an INNER selection holding the clipboard keys (a floating grid's cell) keeps them: the cell clipboard runs", async () => {
    grid.state = { surface: "canvas", selection: null };
    innerSelectionOwnsClipboard();
    await clickButton("copy");
    await clickButton("paste");
    expect(ran).toEqual([CoreCommands.COPY, CoreCommands.PASTE]);
  });

  it("with the canvas's commands not registered (its extension off), the buttons fall back to the cell clipboard", async () => {
    // The same rule the Edit menu asks (@api/objectClipboard clipboardDoorCommand, wave E Y11).
    grid.state = { surface: "canvas", selection: null };
    CommandRegistry.unregister(CANVAS_COPY_SELECTION_COMMAND);
    CommandRegistry.unregister(CANVAS_PASTE_OBJECTS_COMMAND);
    await clickButton("copy");
    await clickButton("paste");
    expect(ran, "a button ran an unregistered canvas command: nothing was copied or pasted").toEqual([
      CoreCommands.COPY,
      CoreCommands.PASTE,
    ]);
  });
});

describe("positive control: a worksheet keeps the cell clipboard", () => {
  it("Copy and Paste run core.clipboard.copy / core.clipboard.paste", async () => {
    grid.state = { surface: "grid", selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } };
    await clickButton("copy");
    await clickButton("paste");
    expect(ran).toEqual([CoreCommands.COPY, CoreCommands.PASTE]);
  });
});
