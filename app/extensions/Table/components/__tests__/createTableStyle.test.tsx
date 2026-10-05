//! FILENAME: app/extensions/Table/components/__tests__/createTableStyle.test.tsx
// PURPOSE: Create Table carries the style Format as Table chose into the new
//          table.
// CONTEXT: The dialog accepted a `data` prop and never read it, and
//          createTableAsync sent no style, so a table could only ever be born
//          in the backend's default (TableStyleMedium2) -- although the backend
//          has accepted CreateTableParams.styleName all along. Format as Table
//          outside a table opens this dialog with `{ styleName }`; the name
//          must reach the backend unchanged, and a plain Insert > Table (no
//          data) must still send none and get the default.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  createTable: vi.fn(),
  getAllTables: vi.fn(async () => []),
  emitted: [] as Array<[string, unknown]>,
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  createTable: (...a: unknown[]) => h.createTable(...a),
  getAllTables: () => h.getAllTables(),
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  detectDataRegion: vi.fn(async () => [0, 0, 4, 2]),
  useGridState: () => ({ selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 } }),
  getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1" }], activeIndex: 0 })),
}));
vi.mock("@api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/events")>()),
  emitAppEvent: (name: string, detail?: unknown) => {
    h.emitted.push([name, detail]);
  },
}));
vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  addGridRegions: vi.fn(),
}));

import { CreateTableDialog } from "../CreateTableDialog";
import { createTableAsync } from "../../lib/tableStore";

const CREATED = {
  id: "t9",
  name: "Table1",
  sheetIndex: 0,
  startRow: 0,
  startCol: 0,
  endRow: 4,
  endCol: 2,
  columns: [],
  styleOptions: {},
  styleName: "TableStyleLight9",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.createTable.mockReset();
  h.createTable.mockResolvedValue({ success: true, table: CREATED });
  h.emitted.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function okButton(): HTMLButtonElement {
  const ok = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "OK");
  if (!ok) throw new Error("no OK button");
  return ok;
}

describe("createTableAsync", () => {
  it("passes a style name through to CreateTableParams.styleName", async () => {
    await createTableAsync({ sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 2, hasHeaders: true, styleName: "TableStyleDark3" });
    expect(h.createTable.mock.calls[0][0]).toMatchObject({ styleName: "TableStyleDark3", hasHeaders: true });
  });

  it("sends no style when none is given (the backend default stays the default)", async () => {
    await createTableAsync({ sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 2, hasHeaders: true });
    expect(h.createTable.mock.calls[0][0]).not.toHaveProperty("styleName");
  });
});

describe("Create Table dialog", () => {
  it("creates the table in the style Format as Table chose", async () => {
    const onClose = vi.fn();
    act(() => {
      root.render(<CreateTableDialog isOpen onClose={onClose} data={{ styleName: "TableStyleLight9" }} />);
    });
    await flush();
    act(() => okButton().click());
    await flush();
    expect(h.createTable).toHaveBeenCalledTimes(1);
    expect(h.createTable.mock.calls[0][0]).toMatchObject({
      startRow: 0,
      startCol: 0,
      endRow: 4,
      endCol: 2,
      hasHeaders: true,
      styleName: "TableStyleLight9",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Insert > Table (no data) sends no style", async () => {
    act(() => {
      root.render(<CreateTableDialog isOpen onClose={vi.fn()} />);
    });
    await flush();
    act(() => okButton().click());
    await flush();
    expect(h.createTable.mock.calls[0][0]).not.toHaveProperty("styleName");
  });

  it("a styleName that is not a string is ignored rather than sent", async () => {
    act(() => {
      root.render(<CreateTableDialog isOpen onClose={vi.fn()} data={{ styleName: 42 }} />);
    });
    await flush();
    act(() => okButton().click());
    await flush();
    expect(h.createTable.mock.calls[0][0]).not.toHaveProperty("styleName");
  });
});
