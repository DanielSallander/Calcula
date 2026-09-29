//! FILENAME: app/extensions/ScriptNotebook/__tests__/notebookSendToGridSelectionOwner.test.tsx
// PURPOSE: A notebook table's "Send to grid > At selection" writes the table at
//          Core's ACTIVE CELL, so it refuses with ONE toast and writes nothing
//          while a selection owner holds the selection; "On new sheet" (which
//          has no anchor in the selection) still works, and with no owner the
//          table lands at the active cell.
// CONTEXT: D4 review (wave B; BUG-0185 class). With a floating grid's cell
//          selected on a worksheet, Core's selection stays on a cell HIDDEN
//          under the floating grid, and this door wrote the table's headers and
//          rows starting at THAT cell. The audit of selection doors missed it.
//          TEST owner (@api/selectionOwner); the real CellOutput component.

/* eslint-disable @typescript-eslint/naming-convention --
 * React's own act() flag is spelled IS_REACT_ACT_ENVIRONMENT. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  batches: [] as { row: number; col: number; value: string }[][],
  sheetsAdded: 0,
}));

vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    // Core's selection: C3 -- hidden under the owner's object in the refusal case.
    useGridState: () => ({
      selection: { startRow: 2, startCol: 2, endRow: 2, endCol: 2, type: "cells" },
    }),
    updateCellsBatch: vi.fn(async (updates: { row: number; col: number; value: string }[]) => {
      h.batches.push(updates);
      return [];
    }),
    addSheet: vi.fn(async () => {
      h.sheetsAdded++;
      return { sheets: [{}, {}] };
    }),
    // The whole switch (the one door, @api activateSheet), answered as the
    // backend would: the new sheet is active.
    activateSheet: vi.fn(async (index: number) => ({ activeIndex: index, sheets: [] })),
  };
});

import { CellOutput } from "../components/CellOutput";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};
let root: Root;
let host: HTMLDivElement;

function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

function button(label: string): HTMLButtonElement {
  const b = [...host.querySelectorAll("button")].find((x) => x.textContent?.includes(label));
  if (!b) throw new Error(`no button '${label}'`);
  return b as HTMLButtonElement;
}

async function send(target: "At selection" | "On new sheet"): Promise<void> {
  await act(async () => {
    button("Send to grid").click();
  });
  await act(async () => {
    button(target).click();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(async () => {
  h.batches.length = 0;
  h.sheetsAdded = 0;
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({
    id: "test-owner",
    label: "the test object's cells",
    ownsSelection: () => owns,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <CellOutput
        output={[{ kind: "table", columns: ["a", "b"], rows: [["1", "2"]], truncated: false, totalRows: 1 }]}
        error={null}
        cellsModified={0}
        durationMs={1}
        executionIndex={1}
      />,
    );
  });
});

afterEach(async () => {
  release();
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("Send to grid > At selection while a selection owner holds the selection", () => {
  it("writes nothing at Core's hidden active cell; one toast", async () => {
    owns = true;
    await send("At selection");
    expect(h.batches, "the table was written at Core's HIDDEN active cell (C3)").toEqual([]);
    expect(refusals().length).toBe(1);
  });

  it("On new sheet is not anchored in the selection: it still sends the table", async () => {
    owns = true;
    await send("On new sheet");
    expect(h.sheetsAdded).toBe(1);
    expect(h.batches.length).toBe(1);
    expect(h.batches[0][0]).toMatchObject({ row: 0, col: 0, value: "a" });
    expect(refusals()).toEqual([]);
  });
});

describe("positive control: nothing owns the selection", () => {
  it("the table lands at Core's active cell (C3), no refusal", async () => {
    await send("At selection");
    expect(h.batches.length).toBe(1);
    expect(h.batches[0][0]).toMatchObject({ row: 2, col: 2, value: "a" });
    expect(refusals()).toEqual([]);
  });
});
