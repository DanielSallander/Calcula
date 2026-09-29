//! FILENAME: app/extensions/BusinessIntelligence/__tests__/biPaneInsertSelectionOwner.test.tsx
// PURPOSE: The BI pane's "Insert into Sheet" writes the query-result block at
//          Core's ACTIVE CELL, so it refuses with ONE toast and inserts nothing
//          while a selection owner holds the selection; it inserts at the
//          active cell when nothing does.
// CONTEXT: D4 review (wave B; BUG-0185 class). With a floating grid's cell
//          selected on a worksheet, Core's selection stays on a cell HIDDEN
//          under the floating grid, and the result block was written there.
//          The real pane, walked through its four steps (connection, bind,
//          query, insert); only the backend-facing calls are doubled. TEST
//          owner (@api/selectionOwner).

/* eslint-disable @typescript-eslint/naming-convention --
 * React's own act() flag is spelled IS_REACT_ACT_ENVIRONMENT. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  inserted: [] as { connectionId: string; sheetIndex: number; startRow: number; startCol: number }[],
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  useGridState: () => ({
    selection: { startRow: 2, startCol: 2, endRow: 2, endCol: 2, type: "cells" },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
  restoreFocusToGrid: vi.fn(),
}));
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  biGetModelInfo: vi.fn(async () => ({
    tables: [{ name: "Sales", columns: [{ name: "Region", dataType: "text" }] }],
    measures: [{ name: "Revenue", table: "Sales" }],
    relationships: [],
    hierarchies: [],
  })),
}));
vi.mock("../../_shared/lib/bi-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../_shared/lib/bi-api")>()),
  getConnections: vi.fn(async () => [{ id: "c1", name: "Sales model", isConnected: true }]),
  connect: vi.fn(async () => undefined),
  getActiveRole: vi.fn(async () => null),
  bindTable: vi.fn(async () => undefined),
  query: vi.fn(async () => ({ columns: ["Revenue"], rows: [["10"]], rowCount: 1 })),
  insertResult: vi.fn(async (req: { connectionId: string; sheetIndex: number; startRow: number; startCol: number }) => {
    h.inserted.push(req);
    return { startRow: req.startRow, startCol: req.startCol, endRow: req.startRow + 1, endCol: req.startCol };
  }),
}));

import { BiPane } from "../components/BiPane";
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

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function clickButton(label: string): Promise<void> {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!button) throw new Error(`no '${label}' button in: ${host.textContent?.slice(0, 300)}`);
  await act(async () => {
    button.click();
    await settle();
  });
}

/** Steps 1-3: pick the connection, bind its tables, run the query. */
async function queryReady(): Promise<void> {
  const select = host.querySelector("select");
  if (!select) throw new Error("no connection picker");
  await act(async () => {
    select.value = "c1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  });
  await clickButton("Bind All Tables");
  await clickButton("Execute Query");
}

beforeEach(async () => {
  h.inserted.length = 0;
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<BiPane {...({} as never)} />);
    await settle();
  });
  await queryReady();
});

afterEach(async () => {
  release();
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("BI pane > Insert into Sheet while a selection owner holds the selection", () => {
  it("inserts nothing at Core's hidden active cell; one toast", async () => {
    owns = true;
    await clickButton("Insert into Sheet");
    expect(h.inserted, "the result block was written at Core's HIDDEN active cell (C3)").toEqual([]);
    expect(refusals().length).toBe(1);
  });
});

describe("positive control: nothing owns the selection", () => {
  it("the result block lands at Core's active cell (C3), no refusal", async () => {
    await clickButton("Insert into Sheet");
    expect(h.inserted).toEqual([{ connectionId: "c1", sheetIndex: 0, startRow: 2, startCol: 2 }]);
    expect(refusals()).toEqual([]);
  });
});
