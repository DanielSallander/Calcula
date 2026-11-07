//! FILENAME: app/extensions/ConditionalFormatting/components/__tests__/rulesManagerExcel.test.tsx
// PURPOSE: The Rules Manager as Excel's (wave-1 uiforms findings, programme 2
//          wave 2): Applies To written with every column letter (AA..XFD were
//          all "Z") as Excel writes it (=$A$2:$E$10) and EDITABLE; Excel's New
//          Rule, Edit Rule and Duplicate Rule buttons -- Edit Rule opening the
//          New Formatting Rule dialog on the STORED rule and writing it back,
//          its formula as typed (Excel's Edit Rule stores =$C5>200 as typed
//          [LIVE, lane uiforms probe4 F4]); Duplicate Rule putting the copy
//          beside the rule (Excel [LIVE, lane uimisc probe3]); and the dialog
//          theme's colours, never a hard-coded light grey.
//          Wave 3 (lane cfdvfix): the Manager BUFFERS every change until OK or
//          Apply, as Excel's does, and writes it as ONE undo step; Cancel
//          writes nothing; "Show formatting rules for" offers Current
//          Selection, This Worksheet and the other sheets. The wave-2 cases
//          below now press OK (or Apply) before they look at the writes --
//          deliberately: a write before OK is the defect.
// CONTEXT: The real dialogs (RulesManagerDialog + NewRuleDialog) over a
//          doubled backend.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as fs from "fs";
import * as path from "path";

const h = vi.hoisted(() => ({
  rules: [] as Array<Record<string, unknown>>,
  calls: [] as Array<[string, unknown]>,
  nextId: 100,
  other: [] as Array<Record<string, unknown>>,
  tx: [] as string[],
  inTx: false,
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  addConditionalFormat: async (params: Record<string, unknown>) => {
    h.calls.push(["add", params]);
    if (!h.inTx) h.calls.push(["OUTSIDE-UNDO-STEP", "add"]);
    const rule = { ...params, id: h.nextId++, priority: 0, enabled: true };
    h.rules = [rule, ...h.rules];
    return { success: true, rule };
  },
  updateConditionalFormat: async (params: Record<string, unknown>) => {
    h.calls.push(["update", params]);
    if (!h.inTx) h.calls.push(["OUTSIDE-UNDO-STEP", "update"]);
    h.rules = h.rules.map((r) => (r.id === params.ruleId ? { ...r, ...params, id: r.id } : r));
    return { success: true };
  },
  reorderConditionalFormats: async (ids: number[]) => {
    h.calls.push(["reorder", ids]);
    h.rules = ids.map((id) => h.rules.find((r) => r.id === id)!).filter(Boolean);
    return { success: true };
  },
  deleteConditionalFormat: async (id: number, opts?: { sheetIndex?: number }) => {
    if (opts?.sheetIndex !== undefined) {
      // Another sheet's rule, deleted THERE (wave 4, lane dtcf4).
      h.calls.push(["delete-on-sheet", [opts.sheetIndex, id]]);
      if (!h.inTx) h.calls.push(["OUTSIDE-UNDO-STEP", "delete"]);
      h.other = h.other.filter((r) => r.id !== id);
      return { success: true };
    }
    h.calls.push(["delete", id]);
    h.rules = h.rules.filter((r) => r.id !== id);
    return { success: true };
  },
  getAllConditionalFormats: async (sheetIndex?: number) => (sheetIndex === 1 ? h.other : h.rules),
  getSheets: async () => ({ sheets: [{ index: 0, name: "Sheet1" }, { index: 1, name: "Data" }], activeIndex: 0 }),
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    h.tx.push(label);
    h.inTx = true;
    try {
      return await fn();
    } finally {
      h.inTx = false;
    }
  },
  shiftFormulasBatch: async (inputs: Array<{ formula: string }>) => inputs.map((i) => i.formula),
  restoreFocusToGrid: () => {},
}));
vi.mock("../../lib/cfStore", () => ({
  getRules: () => h.rules,
  invalidateAndRefresh: async () => undefined,
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" } }),
}));

import { RulesManagerDialog, duplicateRule } from "../RulesManagerDialog";
import { describeAppliesTo, parseAppliesTo } from "../../lib/appliesTo";

let host: HTMLDivElement;
let root: Root;

function expressionRule(id: number, formula: string, ranges: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id,
    priority: id,
    rule: { type: "expression", formula },
    format: { backgroundColor: "#FFC7CE", textColor: "#9C0006" },
    ranges,
    stopIfTrue: false,
    enabled: true,
    ...extra,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function open(data: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root.render(<RulesManagerDialog isOpen onClose={() => {}} data={data} />);
  });
  await flush();
}

function button(action: string): HTMLButtonElement {
  return host.querySelector(`[data-cf-manager-action='${action}']`) as HTMLButtonElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  h.rules = [];
  h.calls = [];
  h.nextId = 100;
  h.other = [];
  h.tx = [];
  h.inTx = false;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Applies To: every column letter, Excel's spelling", () => {
  it("spells columns past Z (AA, XFD) -- it showed every one of them as Z", () => {
    expect(describeAppliesTo([{ startRow: 1, startCol: 26, endRow: 9, endCol: 27 }], ",")).toBe("=$AA$2:$AB$10");
    expect(describeAppliesTo([{ startRow: 0, startCol: 16383, endRow: 0, endCol: 16383 }], ",")).toBe("=$XFD$1");
    expect(
      describeAppliesTo(
        [
          { startRow: 1, startCol: 0, endRow: 9, endCol: 4 },
          { startRow: 0, startCol: 6, endRow: 0, endCol: 6 },
        ],
        ";",
      ),
    ).toBe("=$A$2:$E$10;$G$1");
  });

  it("reads a typed Applies To back: areas, whole columns and rows, the sheet's own prefix", () => {
    expect(parseAppliesTo("=$AA$2:$AB$10;C3", "Sheet1")).toEqual({
      ok: true,
      ranges: [
        { startRow: 1, startCol: 26, endRow: 9, endCol: 27 },
        { startRow: 2, startCol: 2, endRow: 2, endCol: 2 },
      ],
    });
    expect(parseAppliesTo("Sheet1!A:B", "Sheet1")).toMatchObject({ ok: true, ranges: [{ startRow: 0, startCol: 0, endRow: 1048575, endCol: 1 }] });
    expect(parseAppliesTo("=Sheet2!A1", "Sheet1").ok, "another sheet's cells").toBe(false);
    expect(parseAppliesTo("=A0", "Sheet1").ok).toBe(false);
    expect(parseAppliesTo("", "Sheet1").ok).toBe(false);
  });

  it("the Manager shows it and writes an edited one as the rule's ranges", async () => {
    h.rules = [expressionRule(1, "=$C2>100", [{ startRow: 1, startCol: 26, endRow: 9, endCol: 26 }])];
    await open();
    const box = host.querySelector("[data-cf-applies-to='1']") as HTMLInputElement;
    expect(box.value).toBe("=$AA$2:$AA$10");
    await act(async () => {
      setInput(box, "=$B$2:$B$20");
    });
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(h.calls, "nothing is written before OK").toEqual([]);
    await click(button("ok"));
    expect(h.calls).toContainEqual(["update", { ruleId: 1, ranges: [{ startRow: 1, startCol: 1, endRow: 19, endCol: 1 }] }]);
  });

  it("a reference it cannot read is said, and nothing is written", async () => {
    h.rules = [expressionRule(1, "=$C2>100", [{ startRow: 1, startCol: 0, endRow: 9, endCol: 0 }])];
    await open();
    const box = host.querySelector("[data-cf-applies-to='1']") as HTMLInputElement;
    await act(async () => {
      setInput(box, "=Sheet9!A1");
    });
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(host.querySelector("[role='alert']")?.textContent).toContain("own sheet");
    expect(h.calls.filter(([k]) => k === "update")).toEqual([]);
  });
});

describe("New Rule, Edit Rule and Duplicate Rule", () => {
  it("has Excel's buttons; Edit and Duplicate want a rule selected", async () => {
    h.rules = [expressionRule(1, "=$C2>100", [{ startRow: 1, startCol: 0, endRow: 9, endCol: 4 }])];
    await open();
    for (const a of ["new", "edit", "delete", "duplicate", "up", "down"]) expect(button(a), a).not.toBeNull();
    expect(button("edit").disabled).toBe(true);
    expect(button("duplicate").disabled).toBe(true);
    await click(host.querySelector("[data-cf-rule-id='1']")!);
    expect(button("edit").disabled).toBe(false);
  });

  it("Edit Rule opens the New Formatting Rule dialog on the STORED rule and writes it back as typed", async () => {
    h.rules = [expressionRule(1, "=$C2>100", [{ startRow: 1, startCol: 0, endRow: 9, endCol: 4 }])];
    await open({ selection: { startRow: 1, startCol: 0, endRow: 9, endCol: 4 }, activeCell: { row: 4, col: 1 } });
    await click(host.querySelector("[data-cf-rule-id='1']")!);
    await click(button("edit"));
    expect(host.textContent).toContain("Edit Formatting Rule");
    const formula = [...host.querySelectorAll("input[type='text']")].find(
      (i) => (i as HTMLInputElement).value === "=$C2>100",
    ) as HTMLInputElement | undefined;
    expect(formula, "Edit Rule did not show the stored formula").toBeDefined();
    await act(async () => {
      setInput(formula!, "=$C5>200");
    });
    const ok = [...host.querySelectorAll("button")].find((b) => b.textContent === "OK" && !b.hasAttribute("data-cf-manager-action"))!;
    await click(ok);
    expect(h.calls.find(([k]) => k === "update"), "Edit Rule wrote before the Manager's OK").toBeUndefined();
    await click(button("ok"));
    const update = h.calls.find(([k]) => k === "update");
    expect(update, "Edit Rule wrote nothing").toBeDefined();
    expect(update![1]).toMatchObject({
      ruleId: 1,
      // As typed: Excel's Edit Rule does not re-state it for the active cell.
      rule: { type: "expression", formula: "=$C5>200" },
    });
    // Apply writes only what changed: the format is the rule's own, unchanged.
    expect(update![1]).not.toHaveProperty("format");
    expect(h.calls.some(([k]) => k === "add"), "Edit Rule added a rule instead").toBe(false);
    expect(host.textContent, "the editor stayed open").not.toContain("Edit Formatting Rule");
  });

  it("New Rule opens the New Formatting Rule dialog for the selection", async () => {
    await open({ selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 0 }, activeCell: { row: 0, col: 0 } });
    await click(button("new"));
    expect(host.textContent).toContain("New Formatting Rule");
  });

  it("Duplicate Rule puts a copy of the rule -- condition, format, Applies To, Stop If True -- right after it", async () => {
    h.rules = [
      expressionRule(1, "=A1=1", [{ startRow: 0, startCol: 0, endRow: 4, endCol: 0 }], { stopIfTrue: true }),
      expressionRule(2, "=A1=2", [{ startRow: 0, startCol: 0, endRow: 4, endCol: 0 }]),
    ];
    await open();
    await click(host.querySelector("[data-cf-rule-id='1']")!);
    await click(button("duplicate"));
    expect(h.calls, "Duplicate wrote before Apply").toEqual([]);
    await click(button("apply"));
    expect(h.calls[0]).toEqual([
      "add",
      {
        rule: { type: "expression", formula: "=A1=1" },
        format: { backgroundColor: "#FFC7CE", textColor: "#9C0006" },
        ranges: [{ startRow: 0, startCol: 0, endRow: 4, endCol: 0 }],
        stopIfTrue: true,
      },
    ]);
    expect(h.calls.find(([k]) => k === "reorder")![1]).toEqual([1, 100, 2]);
    expect(h.rules.map((r) => r.id)).toEqual([1, 100, 2]);
  });

  it("a disabled rule's copy is disabled too", async () => {
    const rule = expressionRule(5, "=A1", [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }], { enabled: false });
    h.rules = [rule];
    await duplicateRule(rule as never, [5], undefined);
    expect(h.calls).toContainEqual(["update", { ruleId: 100, enabled: false }]);
  });
});

it("paints with the dialog theme's tokens, never a hard-coded light grey (Dark skin)", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../RulesManagerDialog.tsx"), "utf8");
  expect(source).toContain("DIALOG_THEME");
  for (const light of ["#f0f0f0", "#333", "#888", "#ccc", "#e0e0e0", "#d4e8fc", "#aaa", "#555", "#666"]) {
    expect(source.includes(`"${light}"`), `hard-coded ${light}`).toBe(false);
  }
});

describe("Excel's buffered Manager: OK / Cancel / Apply, one undo step (lane cfdvfix)", () => {
  const A = { startRow: 0, startCol: 0, endRow: 4, endCol: 0 };
  const C = { startRow: 0, startCol: 2, endRow: 4, endCol: 2 };

  it("Cancel writes nothing, whatever was changed", async () => {
    h.rules = [expressionRule(1, "=A1=1", [A]), expressionRule(2, "=A1=2", [A])];
    await open();
    await click(host.querySelector("[data-cf-rule-id='2']")!);
    await click(button("delete"));
    await click(host.querySelector("[data-cf-rule-id='1']")!);
    await click(button("duplicate"));
    await click(button("down"));
    expect(host.querySelector("[data-cf-rule-id='2']"), "the deleted rule is gone from the list").toBeNull();
    await click(button("cancel"));
    expect(h.calls).toEqual([]);
    expect(h.tx).toEqual([]);
  });

  it("OK writes every change as ONE undo step", async () => {
    h.rules = [expressionRule(1, "=A1=1", [A]), expressionRule(2, "=A1=2", [A]), expressionRule(3, "=A1=3", [A])];
    await open();
    await click(host.querySelector("[data-cf-rule-id='3']")!);
    await click(button("delete"));
    await click(host.querySelector("[data-cf-rule-id='2']")!);
    await click(button("up"));
    const stop = host.querySelector("[data-cf-rule-id='1'] label input[type='checkbox']") as HTMLInputElement;
    await click(stop);
    expect(h.calls, "nothing before OK").toEqual([]);
    await click(button("ok"));
    expect(h.tx).toEqual(["Conditional Formatting Rules Manager"]);
    expect(h.calls.filter(([k]) => k === "OUTSIDE-UNDO-STEP")).toEqual([]);
    expect(h.calls).toContainEqual(["delete", 3]);
    expect(h.calls).toContainEqual(["update", { ruleId: 1, stopIfTrue: true }]);
    expect(h.calls.find(([k]) => k === "reorder")![1]).toEqual([2, 1]);
    expect(host.textContent, "OK closes... the parent's onClose").toBeDefined();
  });

  it("Apply writes and stays open; a second Apply with nothing changed writes nothing", async () => {
    h.rules = [expressionRule(1, "=A1=1", [A])];
    await open();
    const enabled = host.querySelector("[data-cf-rule-id='1'] > input[type='checkbox']") as HTMLInputElement;
    await click(enabled);
    await click(button("apply"));
    expect(h.calls).toEqual([["update", { ruleId: 1, enabled: false }]]);
    expect(host.querySelector("[data-cf-rule-id='1']"), "still open after Apply").not.toBeNull();
    h.calls = [];
    await click(button("apply"));
    expect(h.calls).toEqual([]);
  });

  it("New Rule is buffered too: the Manager's OK adds it", async () => {
    await open({ selection: A, activeCell: { row: 0, col: 0 } });
    await click(button("new"));
    expect(host.textContent).toContain("New Formatting Rule");
    const ok = [...host.querySelectorAll("button")].find((b) => b.textContent === "OK" && !b.hasAttribute("data-cf-manager-action"))!;
    await click(ok);
    expect(h.calls.some(([k]) => k === "add"), "New Rule wrote before the Manager's OK").toBe(false);
    await click(button("ok"));
    expect(h.calls.some(([k]) => k === "add")).toBe(true);
    expect(h.calls.filter(([k]) => k === "OUTSIDE-UNDO-STEP")).toEqual([]);
  });

  it("Show formatting rules for: Current Selection (Excel's default), This Worksheet, another sheet", async () => {
    h.rules = [expressionRule(1, "=A1=1", [A]), expressionRule(2, "=C1=2", [C])];
    h.other = [expressionRule(7, "=Z1", [A])];
    await open({ selection: { startRow: 1, startCol: 0, endRow: 1, endCol: 0 }, activeCell: { row: 1, col: 0 } });
    const select = host.querySelector("[data-cf-scope-select]") as HTMLSelectElement;
    expect(select.value).toBe("selection");
    expect([...select.options].map((o) => o.textContent)).toEqual(["Current Selection", "This Worksheet", "Data"]);
    expect(host.querySelector("[data-cf-rule-id='1']")).not.toBeNull();
    expect(host.querySelector("[data-cf-rule-id='2']"), "C1:C5 does not meet A2").toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "sheet");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(host.querySelector("[data-cf-rule-id='2']")).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "sheet:1");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(host.querySelector("[data-cf-rule-id='7']"), "the other sheet's rule").not.toBeNull();
    expect(host.querySelector("[data-cf-rule-id='1']")).toBeNull();
  });

  // Wave 4 (lane dtcf4): Excel's Manager EDITS another sheet's rules under
  // "Show formatting rules for" that sheet. Each sheet keeps its own buffer
  // while the scope moves, and OK writes both sheets' changes as ONE undo
  // step, each on its own sheet; Cancel writes neither.
  // SABOTAGE: make the Apply write only the shown sheet's buffer (drop the
  // parked loop) -- fails at "THE PARKED SHEET WAS NOT WRITTEN"; the old
  // view-only scope fails at "OTHER SHEET NOT EDITABLE".
  it("another sheet's rules are edited there, and OK writes every sheet in one undo step", async () => {
    h.rules = [expressionRule(1, "=A1=1", [A]), expressionRule(2, "=C1=2", [C])];
    h.other = [expressionRule(7, "=Z1", [A]), expressionRule(8, "=Z2", [A])];
    await open({ selection: { startRow: 1, startCol: 0, endRow: 1, endCol: 0 }, activeCell: { row: 1, col: 0 } });
    const select = host.querySelector("[data-cf-scope-select]") as HTMLSelectElement;
    const choose = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush();
    };
    await choose("sheet:1");
    await click(host.querySelector("[data-cf-rule-id='7']")!);
    expect(button("delete").disabled, "OTHER SHEET NOT EDITABLE").toBe(false);
    expect(button("new").disabled, "New Rule is for the active sheet's selected cells").toBe(true);
    await click(button("delete"));
    expect(host.querySelector("[data-cf-rule-id='7']")).toBeNull();
    expect(h.calls, "nothing is written before OK").toEqual([]);
    // To this sheet and back: each keeps its own changes.
    await choose("sheet");
    await click(host.querySelector("[data-cf-rule-id='2']")!);
    await click(button("delete"));
    await choose("sheet:1");
    expect(host.querySelector("[data-cf-rule-id='7']"), "the other sheet's buffer was lost").toBeNull();
    expect(host.querySelector("[data-cf-rule-id='8']")).not.toBeNull();
    await click(button("ok"));
    expect(h.calls).toContainEqual(["delete-on-sheet", [1, 7]]);
    expect(h.calls, "THE PARKED SHEET WAS NOT WRITTEN").toContainEqual(["delete", 2]);
    expect(h.calls.filter(([k]) => k === "OUTSIDE-UNDO-STEP")).toEqual([]);
    expect(h.tx, "ONE undo step for both sheets").toEqual(["Conditional Formatting Rules Manager"]);
  });

  it("Cancel writes neither sheet's changes", async () => {
    h.other = [expressionRule(7, "=Z1", [A])];
    await open({});
    const select = host.querySelector("[data-cf-scope-select]") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "sheet:1");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await click(host.querySelector("[data-cf-rule-id='7']")!);
    await click(button("delete"));
    await click(button("cancel"));
    expect(h.calls).toEqual([]);
  });
});
