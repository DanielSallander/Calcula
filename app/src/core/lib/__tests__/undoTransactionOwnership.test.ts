//! FILENAME: app/src/core/lib/__tests__/undoTransactionOwnership.test.ts
// PURPOSE: `ownUndoTransaction` closes ONLY what its begin OPENED -- and no
//          gesture anywhere discards a begin's answer, which is the only way to
//          know whether its close is its own to make.
// CONTEXT: Y7 (wave E; wave D undo report NEW defect 2). The backend keeps ONE
//          undo-transaction slot and a begin while it is open JOINS it; the
//          begin answers a TICKET when it opened and null when it joined
//          (undo_commands.rs). Every Core and extension gesture listed in the
//          defect threw that answer away and then committed or cancelled
//          whatever was open -- a script's `api.beginBatch`, a command-line
//          run -- halfway. The behaviour is proved per gesture in
//          core/hooks/__tests__/{clipboard,fill}UndoOwnership, AutoFilter
//          filterStoreUndoOwnership, FormatPainter / PasteSpecial
//          *UndoOwnership; this file proves the helper itself and pins, by
//          source, that no begin's answer is discarded outside a named list of
//          files other owners still have to fix.

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ownUndoTransaction, readUndoBeginAnswer } from "../undoTransactionOwnership";

function closes() {
  return {
    commitUndoTransaction: vi.fn(async (..._a: unknown[]) => {}),
    cancelUndoTransaction: vi.fn(async (..._a: unknown[]) => {}),
  };
}

describe("ownUndoTransaction", () => {
  it("after a JOIN (null) neither commit nor cancel closes anything", async () => {
    const c = closes();
    const tx = ownUndoTransaction(null, c);
    expect(tx.opened).toBe(false);
    await tx.commit();
    await tx.cancel();
    expect(c.commitUndoTransaction, "a joined gesture committed its holder's step").not.toHaveBeenCalled();
    expect(c.cancelUndoTransaction, "a joined gesture dropped its holder's undo record").not.toHaveBeenCalled();
  });

  it("after an OPENING begin, the close presents its ticket", async () => {
    const c = closes();
    const tx = ownUndoTransaction(42, c);
    expect(tx.opened).toBe(true);
    expect(tx.ticket).toBe(42);
    await tx.commit();
    expect(c.commitUndoTransaction.mock.calls).toEqual([[42]]);
    const d = closes();
    await ownUndoTransaction(43, d).cancel();
    expect(d.cancelUndoTransaction.mock.calls).toEqual([[43]]);
  });

  it("an opening begin answered WITHOUT a ticket still closes -- bare, with no argument at all", async () => {
    const c = closes();
    const tx = ownUndoTransaction(undefined, c);
    expect(tx.opened).toBe(true);
    await tx.commit();
    expect(c.commitUndoTransaction.mock.calls, "a close with an argument would not be the bare close").toEqual([[]]);
  });

  it("closes once: a cancel after a landed commit sends nothing", async () => {
    const c = closes();
    const tx = ownUndoTransaction(7, c);
    await tx.commit();
    await tx.cancel();
    await tx.commit();
    expect(c.commitUndoTransaction).toHaveBeenCalledTimes(1);
    expect(c.cancelUndoTransaction).not.toHaveBeenCalled();
  });

  it("a close that THREW leaves the hold open, so the cleanup cancel still gets its try", async () => {
    const c = closes();
    c.commitUndoTransaction.mockRejectedValueOnce(new Error("ipc down"));
    const tx = ownUndoTransaction(9, c);
    await expect(tx.commit()).rejects.toThrow("ipc down");
    await tx.cancel();
    expect(c.cancelUndoTransaction.mock.calls).toEqual([[9]]);
  });

  it("reads the answer exactly as readUndoBeginAnswer does (one reading, not two)", () => {
    for (const answer of [5, null, false, undefined, "x"]) {
      const tx = ownUndoTransaction(answer, closes());
      expect({ opened: tx.opened, ticket: tx.ticket }).toEqual(readUndoBeginAnswer(answer));
    }
  });
});

// ---------------------------------------------------------------------------
// Census: no statement discards a begin's answer.
// ---------------------------------------------------------------------------

const APP = path.resolve(__dirname, "../../../..");

/** `await beginUndoTransaction(...);` (or `void ...;`) as a whole STATEMENT:
 *  the answer that says whether the close is this caller's to make is thrown
 *  away. (A line ending `),` is an ARGUMENT -- `ownUndoTransaction(\n await
 *  beginUndoTransaction(label),\n ...)` -- and keeps the answer.) */
const DISCARDED_BEGIN =
  /^[ \t]*(?:try\s*\{\s*)?(?:await|void)\s+(?:[\w$.]+\.)?beginUndoTransaction\s*\([^\n]*\);[ \t]*(?:\/\/[^\n]*)?$/m;

/**
 * Files exempt from the census. EMPTY since wave F (Z6): the eight doors wave E
 * left for other owners (Insert Cell Type, Data Consolidation, a script's
 * shape.setProperty, CSV Import, Flash Fill, Subtotals, the Text to Columns
 * wizard and its script door) all close through their hold now, so the census
 * covers EVERY door. It must stay empty -- an exemption is the defect shipped.
 */
const NOT_YET_MIGRATED = new Set<string>([]);

/** `await commitUndoTransaction();` / `try { await cancelUndoTransaction(); }`
 *  -- a close with NO ticket as a whole STATEMENT: it closes WHATEVER is open,
 *  a script's batch included. (A ticket-aware wrapper that closes bare only
 *  when its opening begin gave no ticket -- `await (t === null ? commit() :
 *  commit(t))`, `if (own.ticket === null) await ...commit()` -- is not a bare
 *  statement and is not matched.) */
const BARE_CLOSE =
  /^[ \t]*(?:try\s*\{\s*)?(?:await|void|return)\s+(?:[\w$.]+\.)?(?:commit|cancel)UndoTransaction\s*\(\s*\)/m;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => path.relative(APP, f).split(path.sep).join("/");
const FILES = [...sourceFiles(path.join(APP, "src")), ...sourceFiles(path.join(APP, "extensions"))];
const read = (f: string) => fs.readFileSync(f, "utf8");

describe("census: every begin's answer is kept", () => {
  it("sees the source tree (self-check: the scan is not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(DISCARDED_BEGIN.test("        await beginUndoTransaction(`Move ${count} rows`);\n")).toBe(true);
    expect(DISCARDED_BEGIN.test("    await lib.beginUndoTransaction(description);\n")).toBe(true);
    expect(DISCARDED_BEGIN.test("      tx = ownUndoTransaction(await beginUndoTransaction(label), UNDO_CLOSES);\n")).toBe(false);
    expect(DISCARDED_BEGIN.test("  const tx = ownUndoTransaction(\n    await beginUndoTransaction(`Paste ${n} cells`),\n")).toBe(
      false,
    );
    expect(DISCARDED_BEGIN.test("  beginUndoTransaction(description: string): Promise<number | null>;\n")).toBe(false);
  });

  it("no gesture discards its begin's answer (outside the named not-yet-migrated files)", () => {
    const offenders = FILES.filter((f) => !NOT_YET_MIGRATED.has(rel(f)) && DISCARDED_BEGIN.test(read(f))).map(rel);
    expect(
      offenders,
      "these files begin an undo transaction and throw away the answer that says whether its close is theirs " +
        "-- use ownUndoTransaction (core/lib/undoTransactionOwnership.ts, @api/undoTicket)",
    ).toEqual([]);
  });

  it("the not-yet-migrated list is EMPTY: the census covers every door (wave F, Z6)", () => {
    expect([...NOT_YET_MIGRATED], "a file exempted from the census is a door that may close a stranger's step").toEqual(
      [],
    );
  });

  it("no source file closes WHATEVER is open -- a bare commit / cancel statement (derived, not listed)", () => {
    expect(BARE_CLOSE.test("    await commitUndoTransaction();\n"), "self-check: a bare commit").toBe(true);
    expect(BARE_CLOSE.test("      try { await cancelUndoTransaction(); } catch { /* x */ }\n"), "self-check").toBe(true);
    expect(BARE_CLOSE.test("    await cancelUndoTransaction().catch(() => {});\n"), "self-check").toBe(true);
    expect(BARE_CLOSE.test("    await lib.commitUndoTransaction();\n"), "self-check").toBe(true);
    expect(BARE_CLOSE.test("  await (t === null ? commitUndoTransaction() : commitUndoTransaction(t));\n")).toBe(false);
    expect(BARE_CLOSE.test("  if (own.ticket === null) await s.gateway.commitUndoTransaction();\n")).toBe(false);
    expect(BARE_CLOSE.test("    await tx.commit();\n")).toBe(false);
    const offenders = FILES.filter((f) => BARE_CLOSE.test(read(f))).map(rel);
    expect(
      offenders,
      "these files close the undo transaction with no ticket, whoever opened it -- " +
        "close through ownUndoTransaction's hold (tx.commit() / tx.cancel())",
    ).toEqual([]);
  });

  it("the wave-F doors read their begin's answer through ownUndoTransaction, and the dialogs delegate", () => {
    // The files that BEGIN: each reads its answer through the hold.
    const BEGINS = [
      "extensions/CellTypes/index.ts",
      "extensions/Consolidate/lib/consolidateAsOneStep.ts",
      "extensions/Controls/lib/shapePropertyStep.ts",
      "extensions/CsvImportExport/lib/csvImportWrite.ts",
      "extensions/FlashFill/index.ts",
      "extensions/Subtotals/lib/subtotalEngine.ts",
      "extensions/TextToColumns/lib/writeSplit.ts",
    ];
    for (const f of BEGINS) {
      const full = path.join(APP, f);
      expect(fs.existsSync(full), `${f} does not exist`).toBe(true);
      expect(read(full), `${f} does not read its begin's answer through ownUndoTransaction`).toMatch(
        /ownUndoTransaction\(\s*await beginUndoTransaction\(/,
      );
    }
    // The doors that used to begin themselves now run the one step above.
    const DELEGATES: [string, RegExp][] = [
      ["extensions/Consolidate/components/ConsolidateDialog.tsx", /\bconsolidateAsOneStep\(/],
      ["extensions/Controls/index.ts", /\bsetShapePropertyAsOneStep\(/],
      ["extensions/CsvImportExport/components/CsvImportDialog.tsx", /\bwriteCsvImportAsOneStep\(/],
      ["extensions/TextToColumns/components/TextToColumnsDialog.tsx", /\bwriteSplitAsOneStep\(/],
      ["extensions/TextToColumns/lib/splitProvider.ts", /\bwriteSplitAsOneStep\(/],
    ];
    for (const [f, call] of DELEGATES) {
      const src = read(path.join(APP, f));
      expect(src, `${f} no longer runs its write through the owned step`).toMatch(call);
      expect(src, `${f} begins an undo transaction of its own again`).not.toMatch(/beginUndoTransaction\s*\(/);
    }
  });

  it("the wave-E gestures close through their hold, never bare", () => {
    const GESTURE_FILES = [
      "src/core/hooks/useClipboard.ts",
      "src/core/hooks/useFillHandle.ts",
      "src/core/components/Spreadsheet/useSpreadsheetEditing.ts",
      "src/core/components/Spreadsheet/useSpreadsheetSelection.ts",
      "src/core/components/Spreadsheet/Spreadsheet.tsx",
      "extensions/AutoFilter/lib/filterStore.ts",
      "extensions/BuiltIn/FormatPainter/formatPainterLogic.ts",
      "extensions/BuiltIn/PasteSpecial/pasteSpecialExecute.ts",
    ];
    for (const f of GESTURE_FILES) {
      const src = read(path.join(APP, f));
      expect(src, `${f} no longer begins a transaction at all: the census row is stale`).toMatch(/beginUndoTransaction\(/);
      expect(src, `${f} closes whatever is open -- a bare commit / cancel`).not.toMatch(
        /(?:commit|cancel)UndoTransaction\(\s*\)/,
      );
      expect(src, `${f} does not read its begin's answer through ownUndoTransaction`).toMatch(
        /ownUndoTransaction\(\s*await beginUndoTransaction\(/,
      );
    }
  });
});
