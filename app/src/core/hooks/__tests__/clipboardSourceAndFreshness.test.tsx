//! FILENAME: app/src/core/hooks/__tests__/clipboardSourceAndFreshness.test.tsx
// PURPOSE: The internal (cell) clipboard knows WHICH SHEET it was copied from,
//          and there is ONE rule -- exported, shared by plain Paste and every
//          Paste Special variant -- for "is the internal clipboard still what
//          the clipboard holds, or did another program put newer text there?".
// CONTEXT: Home tab = Excel's Home tab, clipboard lane (2026-10-04; survey
//          clipboard.md section 9, defects 1 and 3).
//            - Paste Link wrote `=$A$1` with no sheet name, because
//              ClipboardData did not record the source sheet: a Paste Link on
//              another sheet linked to the same addresses on the DESTINATION
//              sheet.
//            - Plain Paste compares the system clipboard's text with the
//              internal copy and pastes the system text when another program
//              replaced it; the Paste Special variants never asked, so after a
//              copy in Notepad, Paste Values pasted the OLD Calcula cells.
//          Driven through the REAL hook; the backend and the Tauri clipboard
//          plugin are doubles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const sys = vi.hoisted(() => ({
  /** What the system clipboard holds (null = empty / unreadable). */
  text: null as string | null,
  /** Make the read fail, as it does with no Tauri runtime. */
  fail: false,
  written: [] as string[],
}));

const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_u: unknown[]) => [] as unknown[]),
}));

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async () => 7),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  updateCellsBatch: (u: unknown[]) => api.updateCellsBatch(u),
  getCell: vi.fn(async (row: number, col: number) => ({
    row,
    col,
    display: `r${row}c${col}`,
    formula: null,
    styleIndex: 3,
  })),
  clearCell: vi.fn(async () => {}),
  setCellStyle: vi.fn(async () => {}),
  shiftFormulasBatch: vi.fn(async (inputs: { formula: string }[]) => inputs.map((i) => i.formula)),
  getCollectionTexts: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getDataValidation: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => {
    if (sys.fail) throw new Error("no clipboard runtime");
    return sys.text;
  }),
  writeText: vi.fn(async (t: string) => {
    sys.written.push(t);
  }),
  writeHtml: vi.fn(async (_html: string, t: string) => {
    sys.written.push(t);
  }),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

import {
  useClipboard,
  getInternalClipboard,
  internalClipboardIsCurrent,
  internalClipboardMatchesSystemText,
  type ClipboardData,
  type UseClipboardReturn,
} from "../useClipboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection, setSheetContext } from "../../state/gridActions";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let hook: UseClipboardReturn;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];

function Harness(): React.ReactElement {
  const { dispatch } = useGridContext();
  dispatchOut = dispatch;
  hook = useClipboard();
  return <div />;
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function onSheet(index: number, name: string): Promise<void> {
  await act(async () => {
    dispatchOut(setSheetContext(index, name));
  });
  await settle();
}

async function select(r0: number, c0: number, r1 = r0, c1 = c0): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ startRow: r0, startCol: c0, endRow: r1, endCol: c1, type: "cells" }));
  });
  await settle();
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sys.text = null;
  sys.fail = false;
  sys.written = [];
  api.updateCellsBatch.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider>
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("the internal clipboard records its SOURCE SHEET", () => {
  it("a copy on sheet 2 ('My Data') records index 2 and its name", async () => {
    await onSheet(2, "My Data");
    await select(0, 0, 1, 1);
    await act(async () => {
      await hook.copy();
    });
    const clip = getInternalClipboard();
    expect(clip, "the copy put nothing on the internal clipboard").not.toBeNull();
    expect(clip!.sourceSheetIndex).toBe(2);
    expect(clip!.sourceSheetName).toBe("My Data");
  });

  it("a cut records it too", async () => {
    await onSheet(1, "Sheet2");
    await select(3, 3);
    await act(async () => {
      await hook.cut();
    });
    const clip = getInternalClipboard();
    expect(clip!.isCut).toBe(true);
    expect(clip!.sourceSheetIndex).toBe(1);
    expect(clip!.sourceSheetName).toBe("Sheet2");
  });
});

describe("THE freshness rule (plain Paste and every Paste Special variant)", () => {
  const clip = { text: "a\tb\nc\td" } as ClipboardData;

  it("the same text (Windows line endings normalised) is current", () => {
    expect(internalClipboardMatchesSystemText(clip, "a\tb\r\nc\td")).toBe(true);
    expect(internalClipboardMatchesSystemText(clip, "a\tb\nc\td")).toBe(true);
  });

  it("an empty or unreadable system clipboard leaves the internal copy current", () => {
    expect(internalClipboardMatchesSystemText(clip, null)).toBe(true);
    expect(internalClipboardMatchesSystemText(clip, "")).toBe(true);
    expect(internalClipboardMatchesSystemText(clip, undefined)).toBe(true);
  });

  it("different text -- another program copied after Calcula -- is NOT current", () => {
    expect(internalClipboardMatchesSystemText(clip, "from notepad")).toBe(false);
  });

  it("internalClipboardIsCurrent reads the system clipboard and applies the rule", async () => {
    sys.text = "a\tb\r\nc\td";
    await expect(internalClipboardIsCurrent(clip)).resolves.toBe(true);
    sys.text = "from notepad";
    await expect(internalClipboardIsCurrent(clip)).resolves.toBe(false);
    sys.fail = true;
    await expect(internalClipboardIsCurrent(clip), "a failed read must count as current, as plain Paste does").resolves.toBe(
      true,
    );
  });
});

describe("plain Paste still follows the rule (the refactor kept its behaviour)", () => {
  it("newer text from another program: Paste writes THAT text, not the old cells", async () => {
    await select(0, 0);
    await act(async () => {
      await hook.copy();
    });
    sys.text = "from notepad";
    await select(5, 5);
    await act(async () => {
      await hook.paste();
    });
    await settle();
    const updates = api.updateCellsBatch.mock.calls.at(-1)?.[0] as Array<{ value: string; styleIndex?: number }>;
    expect(updates, "Paste wrote nothing").toBeDefined();
    expect(updates[0].value).toBe("from notepad");
    expect(updates[0].styleIndex, "system text carries no Calcula style").toBeUndefined();
  });

  it("the clipboard still holding Calcula's own text: Paste writes the copied cells WITH their style", async () => {
    await select(0, 0);
    await act(async () => {
      await hook.copy();
    });
    sys.text = sys.written.at(-1) ?? null;
    await select(5, 5);
    await act(async () => {
      await hook.paste();
    });
    await settle();
    const updates = api.updateCellsBatch.mock.calls.at(-1)?.[0] as Array<{ value: string; styleIndex?: number }>;
    expect(updates[0].value).toBe("r0c0");
    expect(updates[0].styleIndex).toBe(3);
  });
});
