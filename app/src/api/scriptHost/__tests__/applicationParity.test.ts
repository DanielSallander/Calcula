//! FILENAME: app/src/api/scriptHost/__tests__/applicationParity.test.ts
// PURPOSE: Guard the four Application-object gaps closed in G4 — the
//          WorksheetFunction bridge (api.evaluate), R1C1 formula authoring
//          (get/setCellFormula), range copy/paste/pasteSpecial, and PDF export
//          (caps.file.exportPdf) — plus the ONE thing G4 deleted, so it cannot
//          come back by accident: Application.enableEvents.
// CONTEXT: The failure modes these tests exist to catch are not "the feature
//          does not work". They are:
//            1. a shim wired to a method with no policy row (fails CLOSED, and
//               silently for fire-and-forget calls) — this has shipped twice;
//            2. a clipboard that quietly becomes the SYSTEM clipboard, which is
//               ambient authority nobody consented to;
//            3. a formats-only paste that appears to succeed while doing
//               nothing;
//            4. a picker-opening method left on the 30s worker deadline;
//            5. `enableEvents` reappearing as a writable flag with no consumer.
//          Everything is asserted against the REAL policy table, the REAL
//          validators, the REAL broker and the REAL sources on disk.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as nodeFs from "fs";
import * as nodePath from "path";

import { ALLOWLIST } from "../allowlist";
import { EXTENSION_BROKER_METHODS } from "../extensionProtocol";
import { METHOD_DEADLINES_MS, UI_DIALOG_DEADLINE_MS } from "../protocol";
import { brokerCall, buildHandleFromDefinition } from "../broker";
import { resetAllGrants } from "../capabilities";
import {
  FORMULA_REFERENCE_STYLES,
  MAX_EVAL_EXPRESSIONS,
  MAX_EVAL_EXPRESSION_CHARS,
  MAX_RANGE_CELLS,
  PASTE_MODES,
  vEvaluate,
  vFormulaRead,
  vFormulaWrite,
  vPasteRange,
  vPrintPdf,
  vRangeRef,
} from "../validators";
import {
  hasPdfRenderer,
  registerPdfRenderer,
  renderWorkbookPdf,
  resetPdfRenderer,
} from "../../printService";
import { RESTRICTED_SHEET_CLAMP_MESSAGE } from "../host";

const REPO = nodePath.resolve(__dirname, "../../../../..");
const readRepo = (rel: string) => nodeFs.readFileSync(nodePath.join(REPO, rel), "utf8");

const contextShims = readRepo("app/src/api/scriptHost/worker/contextShims.ts");
const hostSrc = readRepo("app/src/api/scriptHost/host.ts");
const typings = readRepo("app/extensions/ScriptableObjects/objectContexts.d.ts");

const G4_METHODS = [
  "api.evaluate",
  "api.getCellFormula",
  "api.setCellFormula",
  "sheet.getCellFormula",
  "sheet.setCellFormula",
  "api.copyRange",
  "api.pasteRange",
  "cap.filePrintPdf",
];

// ============================================================================
// 0. The 5-file pattern, for every row G4 added
// ============================================================================
//
// A shim with no allowlist row fails CLOSED with UnknownMethod — invisible for
// a fire-and-forget call. A row nobody calls is dead consent text that inflates
// what the transparency panel tells the user a script can do. Both directions
// are already guarded globally by allowlistCoverage.test.ts; this block pins the
// specific eight, so a later refactor that drops one is named here rather than
// showing up as an arithmetic change in a list length.

describe("every G4 broker method exists in all five places", () => {
  it("has a policy row with real consent text and a validator", () => {
    for (const m of G4_METHODS) {
      const policy = ALLOWLIST[m];
      expect(policy, `${m} has no ALLOWLIST row`).toBeDefined();
      expect(typeof policy.validate, `${m} validator`).toBe("function");
      expect(policy.desc.length, `${m} desc`).toBeGreaterThan(20);
      // The desc is read by a NON-PROGRAMMER: it must not name the wire method.
      expect(policy.desc, `${m} desc leaks its id`).not.toContain(m);
    }
  });

  it("is dispatched by a host executor", () => {
    const hostCases = new Set([...hostSrc.matchAll(/case\s+"([^"]+)"\s*:/g)].map((x) => x[1]));
    for (const m of G4_METHODS) {
      expect(hostCases.has(m), `${m} has no case in executeImpl`).toBe(true);
    }
  });

  it("is reachable from a worker shim", () => {
    const called = new Set(
      [...contextShims.matchAll(/\b(?:call|callFire)\(\s*rt\s*,\s*"([^"]+)"/g)].map((x) => x[1]),
    );
    for (const m of G4_METHODS) {
      expect(called.has(m), `${m} is not called by any shim`).toBe(true);
    }
  });

  it("appears in the GENERATED authoring typings", () => {
    // objectContexts.d.ts is produced from the shim by the typings generator;
    // a member the generator could not see is invisible in IntelliSense, which
    // is how a shipped surface stays undiscovered.
    for (const member of [
      "evaluate(",
      "evaluateAll(",
      "getCellFormula(",
      "setCellFormula(",
      "copyRange(",
      "pasteSpecial(",
      "exportPdf(",
    ]) {
      expect(typings.includes(member), `${member} missing from objectContexts.d.ts`).toBe(true);
    }
  });
});

// ============================================================================
// 1. api.evaluate — the WorksheetFunction bridge
// ============================================================================

describe("api.evaluate is a READ at the tier that already reads every cell", () => {
  it("is unlocked-tier, class read, and needs NO capability", () => {
    const policy = ALLOWLIST["api.evaluate"];
    expect(policy.tier).toBe("unlocked");
    expect(policy.class).toBe("read");
    // Evaluating a formula reaches exactly what api.getRangeValues reaches. A
    // capability here would be theatre: the same script can already read every
    // cell the expression could touch.
    expect(policy.capability).toBeUndefined();
  });

  it("declares only limits that are actually ENFORCED", () => {
    // The signature failure of this program is a promise nothing keeps. This row
    // reaches no Rust gate, so it must not claim a per-minute budget nobody
    // counts; the two numbers it does declare are enforced by vEvaluate below.
    const limits = ALLOWLIST["api.evaluate"].limits ?? {};
    expect(limits.perMinute).toBeUndefined();
    expect(limits.maxExpressions).toBe(MAX_EVAL_EXPRESSIONS);
    expect(limits.maxChars).toBe(MAX_EVAL_EXPRESSION_CHARS);
  });

  it("bounds the batch and each expression", () => {
    expect(vEvaluate([["SUM(A1:A10)"]])).toBe(true);
    expect(vEvaluate([["=SUM(A1:A10)", "1+1"], { sheetIndex: 2 }])).toBe(true);
    expect(vEvaluate([[]])).not.toBe(true);
    expect(vEvaluate([new Array(MAX_EVAL_EXPRESSIONS + 1).fill("1")])).not.toBe(true);
    expect(vEvaluate([["x".repeat(MAX_EVAL_EXPRESSION_CHARS + 1)]])).not.toBe(true);
    expect(vEvaluate([["   "]])).not.toBe(true);
    expect(vEvaluate(["SUM(A1)"])).not.toBe(true); // not an array
    expect(vEvaluate([[42]])).not.toBe(true);
  });

  it("rejects an unknown option instead of ignoring it", () => {
    // A silently ignored option is how a script author ends up staring at a
    // result they cannot explain, with nothing to search for.
    expect(vEvaluate([["1+1"], { sheet: 2 }])).not.toBe(true);
    expect(vEvaluate([["1+1"], { sheetIndex: -1 }])).not.toBe(true);
    expect(vEvaluate([["1+1"], "Sheet2"])).not.toBe(true);
  });

  it("routes through the typed backend command, not the scope-only one", () => {
    // evaluate_scoped has NO grid: cell references do not resolve there. Wiring
    // the bridge to it would answer #REF! for the one thing it exists to do.
    expect(hostSrc).toContain('case "api.evaluate"');
    expect(hostSrc).toContain("evaluateFormulasTyped");
  });

  it("does NOT resolve user-defined functions — the Rust command says so", () => {
    // A UDF body is JavaScript in another script's worker realm. Resolving one
    // from inside a lock-held evaluation would re-enter that realm through a
    // door nobody consented to, so an unknown name answers #NAME? instead.
    const rust = readRepo("app/src-tauri/src/formula.rs");
    const cmd = rust.slice(rust.indexOf("pub fn evaluate_formula_typed"));
    const body = cmd.slice(0, cmd.indexOf("\n}\n"));
    expect(body).not.toContain("set_udf_fn");
    expect(body).not.toContain("udf");
  });
});

// ============================================================================
// 2. R1C1 authoring
// ============================================================================

describe("explicit formula read/write carries a reference style", () => {
  it("offers exactly the two notations the engine can convert between", () => {
    expect([...FORMULA_REFERENCE_STYLES].sort()).toEqual(["A1", "R1C1"]);
    expect(vFormulaRead([0, 0, { style: "R1C1" }])).toBe(true);
    expect(vFormulaRead([0, 0, { style: "RC" }])).not.toBe(true);
    expect(vFormulaRead([0, 0, { style: "a1" }])).not.toBe(true);
  });

  it("accepts null as CLEAR, and refuses a non-string formula", () => {
    expect(vFormulaWrite([1, 2, null])).toBe(true);
    expect(vFormulaWrite([1, 2, "=RC[-1]*2", { style: "R1C1" }])).toBe(true);
    expect(vFormulaWrite([1, 2, 42])).not.toBe(true);
    expect(vFormulaWrite([1, 2, "=" + "A".repeat(MAX_EVAL_EXPRESSION_CHARS)])).not.toBe(true);
  });

  it("rejects unknown options on both directions", () => {
    expect(vFormulaRead([0, 0, { referenceStyle: "R1C1" }])).not.toBe(true);
    expect(vFormulaWrite([0, 0, "=1", { r1c1: true }])).not.toBe(true);
  });

  it("puts the sheet-scoped pair at RESTRICTED tier and the workbook pair at UNLOCKED", () => {
    expect(ALLOWLIST["sheet.getCellFormula"].tier).toBe("restricted");
    expect(ALLOWLIST["sheet.setCellFormula"].tier).toBe("restricted");
    expect(ALLOWLIST["api.getCellFormula"].tier).toBe("unlocked");
    expect(ALLOWLIST["api.setCellFormula"].tier).toBe("unlocked");
    // A formula is cell content: reading one is a read, writing one is a mutate.
    expect(ALLOWLIST["api.getCellFormula"].class).toBe("read");
    expect(ALLOWLIST["api.setCellFormula"].class).toBe("mutate");
    // No capability anywhere: R1C1 is a SPELLING of reach these tiers already
    // grant, not a new authority.
    for (const m of ["api.getCellFormula", "api.setCellFormula", "sheet.getCellFormula", "sheet.setCellFormula"]) {
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
  });

  it("resolves R1C1 against the TARGET CELL, never the user's View setting", () => {
    // A script's meaning must not change because somebody ticked View > R1C1.
    // The host passes (row, col) as the conversion base and never reads
    // get_reference_style / getReferenceStyle.
    const helper = hostSrc.slice(
      hostSrc.indexOf("async function writeCellFormula"),
      hostSrc.indexOf("// Range copy / paste / paste special"),
    );
    expect(helper).toContain('convertFormulaStyle(withEquals, "R1C1", "A1", row, col)');
    expect(hostSrc).not.toContain("getReferenceStyle(");
  });

  it("clamps the sheet-scoped write to the sheet on screen BEFORE writing", () => {
    const caseBody = hostSrc.slice(
      hostSrc.indexOf('case "sheet.setCellFormula"'),
      hostSrc.indexOf('case "sheet.setRangeFormat"'),
    );
    const clampAt = caseBody.indexOf("clampSheetIndex");
    const writeAt = caseBody.indexOf("writeCellFormula");
    expect(clampAt).toBeGreaterThan(0);
    expect(clampAt, "the tier check must run before the write").toBeLessThan(writeAt);
  });
});

// ============================================================================
// 2b. The restricted clamp SAYS what it DOES
// ============================================================================
//
// The `sheet.*` consent rows advertised "clamped to the bound sheet" and the
// refusal said "Restricted sheet scripts can only access their own sheet".
// Neither describes anything that exists. `sheet` is a PRIMITIVE object type —
// one script per workbook, `instanceId` always null, and its own scaffold opens
// with "Sheet Script (applies to ALL sheets)" — and every OTHER object type
// reaches the same `sheet.*` family. The clamp the host implements is the ACTIVE
// sheet: an omitted index resolves to it and naming another is refused.
//
// The gap between the two is not cosmetic. A reader of the old text believed a
// restricted script was fenced into one particular sheet forever; what it is
// actually fenced into is "whatever the user is looking at right now", which is
// a real guarantee but a different one, and it is the one the user must be able
// to reason about.

describe("the restricted sheet clamp is described accurately", () => {
  it("is implemented against the ACTIVE sheet, and only that", () => {
    const clamp = hostSrc.slice(
      hostSrc.indexOf("async function clampSheetIndex"),
      hostSrc.indexOf("async function withScriptUndoBatch"),
    );
    // Wave 1: the ref (index or name) resolves against the LIVE sheet list and
    // is compared to the list's own activeIndex — still the active sheet, and
    // still nothing else.
    expect(clamp).toContain("lib.getSheets()");
    expect(clamp).toContain("activeIndex");
    // Nothing about the mount definition is consulted — there is no binding.
    expect(clamp).not.toContain("definition.instanceId");
    expect(clamp).not.toContain("boundSheet");
  });

  it("no consent row claims a per-script sheet BINDING", () => {
    for (const [method, policy] of Object.entries(ALLOWLIST)) {
      expect(
        policy.desc.toLowerCase(),
        `${method}: "bound sheet" describes a binding that does not exist — ` +
          `clampSheetIndex compares against getActiveSheet(), and a \`sheet\` script is ` +
          `workbook-wide (instanceId is always null).`,
      ).not.toContain("bound sheet");
    }
  });

  it("the sheet.* rows name the sheet on screen", () => {
    const sheetRows = Object.entries(ALLOWLIST).filter(([m]) => m.startsWith("sheet."));
    expect(sheetRows.length, "the sheet.* family must exist").toBeGreaterThan(5);
    for (const [method, policy] of sheetRows) {
      expect(
        policy.desc,
        `${method} must say WHICH sheet a restricted script reaches, in the same words the ` +
          `refusal uses`,
      ).toContain("the sheet currently shown");
    }
  });

  it("the refusal message matches the rows, and is ONE constant", () => {
    expect(RESTRICTED_SHEET_CLAMP_MESSAGE).toContain("the sheet you are looking at");
    expect(RESTRICTED_SHEET_CLAMP_MESSAGE.toLowerCase()).not.toContain("their own sheet");
    // Every refusal site uses the constant — no second wording can drift in.
    expect(hostSrc).not.toContain('"Restricted sheet scripts can only access their own sheet"');
    const uses = hostSrc.split("RESTRICTED_SHEET_CLAMP_MESSAGE").length - 1;
    expect(uses, "declaration + every throw site").toBeGreaterThanOrEqual(4);
  });
});

// ============================================================================
// 3. Clipboard — the decision that matters is an ABSENCE
// ============================================================================

describe("range copy/paste never touches the user's clipboard", () => {
  it("ships no method that reads or writes the system clipboard", () => {
    // Reading it is ambient authority with no honest scope (it may hold a
    // password); writing it destroys what the user has in hand and is a channel
    // out of Calcula into every other application. Neither is gated — both are
    // simply absent, and that absence is what this test pins.
    for (const method of Object.keys(ALLOWLIST)) {
      expect(method.toLowerCase()).not.toContain("systemclipboard");
      expect(method).not.toMatch(/readClipboard|clipboardRead|getClipboard/i);
    }
    const clipboardSection = hostSrc.slice(
      hostSrc.indexOf("// Range copy / paste / paste special"),
      hostSrc.indexOf("async function defaultPdfName"),
    );
    // The two Tauri clipboard doors, and the app's own internal one.
    for (const forbidden of [
      "plugin-clipboard-manager",
      "getInternalClipboard",
      "navigator.clipboard",
      "readText",
      "writeText",
    ]) {
      expect(clipboardSection.includes(forbidden), `clipboard path reaches ${forbidden}`).toBe(false);
    }
  });

  it("keeps the buffer per script and throws it away at unmount and at reset", () => {
    expect(hostSrc).toContain("const scriptClipboards = new Map<string, ScriptClipboard>()");
    // Both sweeps must exist: a buffer holds a copy of the user's data, and a
    // remounted successor must not inherit one it never filled.
    const unmount = hostSrc.slice(hostSrc.indexOf("export function hostUnmountScript"));
    expect(unmount.slice(0, unmount.indexOf("\n}\n"))).toContain("clearScriptClipboard(scriptId)");
    const reset = hostSrc.slice(hostSrc.indexOf("export function hostResetAll"));
    expect(reset.slice(0, reset.indexOf("\n}\n"))).toContain("clearScriptClipboard()");
  });

  it("gates copy as a READ and paste as a MUTATE, both unlocked, no capability", () => {
    expect(ALLOWLIST["api.copyRange"].tier).toBe("unlocked");
    expect(ALLOWLIST["api.copyRange"].class).toBe("read");
    expect(ALLOWLIST["api.copyRange"].capability).toBeUndefined();
    expect(ALLOWLIST["api.pasteRange"].tier).toBe("unlocked");
    expect(ALLOWLIST["api.pasteRange"].class).toBe("mutate");
    expect(ALLOWLIST["api.pasteRange"].capability).toBeUndefined();
    // Copy reuses the bulk-range validator, so it inherits the same ceiling
    // every other rectangle read has.
    expect(ALLOWLIST["api.copyRange"].validate).toBe(vRangeRef);
    expect(ALLOWLIST["api.copyRange"].limits?.maxCells).toBe(MAX_RANGE_CELLS);
    expect(vRangeRef([0, 0, 999_999, 999_999])).not.toBe(true);
  });

  it("says in plain words that the buffer is the script's own", () => {
    // This is the sentence a worried user reads. If it ever says "clipboard"
    // without saying whose, the consent is misleading.
    const copyDesc = ALLOWLIST["api.copyRange"].desc.toLowerCase();
    expect(copyDesc).toContain("private clipboard");
    expect(copyDesc).toContain("what you copied is untouched");
  });

  it("offers all/values/formulas and REFUSES a formats-only paste", () => {
    // "formats" is absent on evidence, not preference: there is no batched style
    // write, and set_cell_style (commands/styles.rs) only acts `if let
    // Some(cell)` — so a formats-only paste would report success while doing
    // nothing at all for every blank destination cell.
    expect([...PASTE_MODES].sort()).toEqual(["all", "formulas", "values"]);
    expect(vPasteRange([0, 0, { mode: "formats" }])).not.toBe(true);
    const styles = readRepo("app/src-tauri/src/commands/styles.rs");
    const setStyle = styles.slice(styles.indexOf("pub fn set_cell_style"));
    expect(setStyle).toContain("if let Some(cell) = grid.get_cell(row, col)");
  });

  it("validates the paste options it does accept", () => {
    expect(vPasteRange([0, 0])).toBe(true);
    expect(vPasteRange([0, 0, { mode: "values", transpose: true, skipBlanks: true }])).toBe(true);
    expect(vPasteRange([0, 0, { transpose: "yes" }])).not.toBe(true);
    expect(vPasteRange([0, 0, { destination: "A1" }])).not.toBe(true);
    expect(vPasteRange([-1, 0])).not.toBe(true);
  });

  it("writes VALUES invariant, so a sv-SE workbook does not turn numbers into text", () => {
    const helper = hostSrc.slice(
      hostSrc.indexOf("function clipboardValueString"),
      hostSrc.indexOf("async function pasteScriptClipboard"),
    );
    expect(helper).toContain("invariant: true");
    // `display` is FORMATTED ("1 234,50 kr"); writing it back would store text
    // where a number was, which is the corruption this whole shape avoids.
    expect(helper).toContain('case "number"');
    expect(helper).toContain("String(cell.value)");
  });

  it("shifts relative references PER CELL, which is also what makes transpose right", () => {
    const paste = hostSrc.slice(
      hostSrc.indexOf("async function pasteScriptClipboard"),
      hostSrc.indexOf("async function defaultPdfName"),
    );
    expect(paste).toContain("const rowDelta = destRow - (clip.startRow + r)");
    expect(paste).toContain("const colDelta = destCol - (clip.startCol + c)");
    expect(paste).toContain("shiftFormulasBatch");
  });

  it("runs every pasted cell through the writeback draft gate and the write attribution", () => {
    const paste = hostSrc.slice(
      hostSrc.indexOf("async function pasteScriptClipboard"),
      hostSrc.indexOf("async function defaultPdfName"),
    );
    // A .calp writeback cell is the publisher's input form: a paste must be
    // drafted through the same authoritative path a keystroke takes, or refused.
    expect(paste).toContain("captureWritebackWrites");
    // ...and the script's own onChange must not re-fire for its own paste.
    expect(paste).toContain("recordScriptWrite");
    // One undo entry for the whole block.
    expect(paste).toContain("withScriptUndoBatch");
  });

  it("refuses to paste when nothing was copied, instead of writing blanks", async () => {
    const { hostUnmountScript } = await import("../host");
    // No mount, so no buffer: the executor must be the thing that refuses.
    expect(typeof hostUnmountScript).toBe("function");
    const paste = hostSrc.slice(hostSrc.indexOf("async function pasteScriptClipboard"));
    expect(paste.slice(0, 1200)).toContain("nothing to paste");
  });
});

// ============================================================================
// 4. Printing
// ============================================================================

describe("PDF export is the file.picker shape with the payload removed", () => {
  it("is gated on file.picker at restricted tier, class file", () => {
    const policy = ALLOWLIST["cap.filePrintPdf"];
    expect(policy.capability).toBe("file.picker");
    expect(policy.tier).toBe("restricted");
    expect(policy.class).toBe("file");
  });

  it("carries the person-length worker deadline (a picker waits on a human)", () => {
    expect(METHOD_DEADLINES_MS["cap.filePrintPdf"]).toBe(UI_DIALOG_DEADLINE_MS);
  });

  it("accepts only a bare .pdf file name — never a path", () => {
    expect(vPrintPdf([])).toBe(true);
    expect(vPrintPdf([undefined])).toBe(true);
    expect(vPrintPdf(["March report.pdf"])).toBe(true);
    expect(vPrintPdf(["report.csv"])).not.toBe(true);
    expect(vPrintPdf(["C:\\Users\\me\\report.pdf"])).not.toBe(true);
    expect(vPrintPdf(["../../report.pdf"])).not.toBe(true);
    expect(vPrintPdf(["sub/dir/report.pdf"])).not.toBe(true);
    expect(vPrintPdf(["report.pdf:hidden"])).not.toBe(true);
  });

  it("takes NO content argument at all — the host renders the document", () => {
    // This is what makes it narrower than cap.fileExportText rather than wider:
    // there is no byte a script could choose to have written.
    expect(vPrintPdf(["a.pdf", "arbitrary bytes"])).toBe(true); // extra args ignored...
    const execCase = hostSrc.slice(
      hostSrc.indexOf('case "cap.filePrintPdf"'),
      hostSrc.indexOf("// ---- ui.shortcut"),
    );
    expect(execCase).toContain("printService.renderWorkbookPdf()");
    // ...and the executor destructures exactly ONE argument, so nothing else
    // from the wire can reach the file.
    expect(execCase).toContain("const [suggestedName] = args as [string?]");
    expect(execCase).not.toContain("content");
  });

  it("renders BEFORE the picker opens, so a missing provider is a refusal not an empty file", () => {
    const execCase = hostSrc.slice(
      hostSrc.indexOf('case "cap.filePrintPdf"'),
      hostSrc.indexOf("// ---- ui.shortcut"),
    );
    expect(execCase.indexOf("renderWorkbookPdf")).toBeLessThan(execCase.indexOf("exportBinaryViaPicker"));
  });

  it("is offered to sandboxed extensions too", () => {
    expect(EXTENSION_BROKER_METHODS.has("cap.filePrintPdf")).toBe(true);
    const extHost = readRepo("app/src/api/scriptHost/extensionWorkerHost.ts");
    expect(extHost).toContain('case "cap.filePrintPdf"');
  });
});

describe("the print seam keeps the API facade feature-neutral", () => {
  beforeEach(() => resetPdfRenderer());
  afterEach(() => resetPdfRenderer());

  it("refuses loudly when no extension has registered a renderer", async () => {
    expect(hasPdfRenderer()).toBe(false);
    await expect(renderWorkbookPdf()).rejects.toThrow(/no print provider/i);
  });

  it("uses the registered renderer, and its cleanup removes it", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const off = registerPdfRenderer(async () => bytes);
    expect(hasPdfRenderer()).toBe(true);
    await expect(renderWorkbookPdf()).resolves.toBe(bytes);
    off();
    expect(hasPdfRenderer()).toBe(false);
  });

  it("does not let a stale cleanup blank out a live re-registration", async () => {
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    const offFirst = registerPdfRenderer(async () => first);
    registerPdfRenderer(async () => second);
    offFirst(); // the OLD cleanup, running after a re-activation
    await expect(renderWorkbookPdf()).resolves.toBe(second);
  });

  it("treats an empty render as an error, not as a valid document", async () => {
    registerPdfRenderer(async () => new Uint8Array(0));
    await expect(renderWorkbookPdf()).rejects.toThrow(/no data/i);
  });

  it("is registered by the Print extension from its activate()", () => {
    const print = readRepo("app/extensions/Print/index.ts");
    expect(print).toContain('registerPdfRenderer');
    expect(print).toContain('from "@api/printService"');
    // Through the SAME pair the File menu uses, so the two PDFs cannot drift.
    expect(print).toContain("generatePdf(data)");
    expect(print).toContain("await getPrintData()");
  });

  it("does NOT publish the pop-up print path", () => {
    // executePrint() opens a window and calls window.print() on a timer: it can
    // be silently blocked and reports nothing back. A call that may quietly do
    // nothing is exactly the API shape this program has shipped by accident.
    const svc = readRepo("app/src/api/printService.ts");
    // The seam declares ONE renderer type and nothing that sends to a device...
    expect(svc).toContain("export type PdfRenderer");
    // ...only a PDF renderer is exported; there is no device-printing member to
    // register, so no caller can reach the pop-up path through this seam.
    const exported = [...svc.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]).sort();
    expect(exported).toEqual(["hasPdfRenderer", "registerPdfRenderer", "renderWorkbookPdf", "resetPdfRenderer"]);
    // ...and the facade imports NOTHING, least of all the extension that owns
    // printing (No First-Class Citizens).
    expect(svc).not.toMatch(/^import /m);
    for (const m of Object.keys(ALLOWLIST)) {
      expect(m).not.toMatch(/printToPrinter|sendToPrinter/i);
    }
  });
});

// ============================================================================
// 5. Broker denial: the picker cannot open without the grant
// ============================================================================

function restrictedHandle(declared: string[]) {
  return buildHandleFromDefinition({
    id: "g4-script",
    name: "G4 test script",
    objectType: "sheet",
    instanceId: null,
    accessLevel: "restricted",
    declaredCapabilities: declared,
  });
}

describe("the broker gates the G4 surface before any executor runs", () => {
  beforeEach(() => resetAllGrants());

  it("denies the PDF export when file.picker was never declared", async () => {
    const executor = vi.fn();
    await expect(
      brokerCall(restrictedHandle([]), "cap.filePrintPdf", ["a.pdf"], executor as never),
    ).rejects.toMatchObject({ code: "PermissionDenied", capability: "file.picker" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("denies it when declared but not granted", async () => {
    const executor = vi.fn();
    await expect(
      brokerCall(restrictedHandle(["file.picker"]), "cap.filePrintPdf", [], executor as never),
    ).rejects.toMatchObject({ code: "CapabilityRequired", capability: "file.picker" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("validates a junk file name BEFORE the capability check, so no dialog appears", async () => {
    const executor = vi.fn();
    await expect(
      brokerCall(restrictedHandle(["file.picker"]), "cap.filePrintPdf", ["../evil.pdf"], executor as never),
    ).rejects.toMatchObject({ code: "ValidationError" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("keeps the whole unlocked G4 surface away from a restricted script", async () => {
    const executor = vi.fn();
    // Valid arguments on purpose: the validator runs BEFORE the tier check (so
    // an error message never probes policy), and a ValidationError here would
    // mean the test proved nothing about the tier.
    const validArgs: Record<string, unknown[]> = {
      "api.evaluate": [["1+1"]],
      "api.getCellFormula": [0, 0],
      "api.setCellFormula": [0, 0, "=1+1"],
      "api.copyRange": [0, 0, 4, 4],
      "api.pasteRange": [10, 0],
    };
    for (const [m, args] of Object.entries(validArgs)) {
      expect(ALLOWLIST[m].validate(args), `${m} args are not valid`).toBe(true);
      await expect(
        brokerCall(restrictedHandle([]), m, args, executor as never),
      ).rejects.toMatchObject({ code: "PermissionDenied" });
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it("lets a restricted script author a formula on its OWN sheet", async () => {
    const executor = vi.fn(async () => undefined);
    await expect(
      brokerCall(restrictedHandle([]), "sheet.setCellFormula", [3, 2, "=RC[-1]*2", { style: "R1C1" }], executor as never),
    ).resolves.toBeUndefined();
    expect(executor).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 6. Application.enableEvents is GONE, and must stay gone
// ============================================================================

describe("Application.enableEvents was removed rather than left hollow", () => {
  const SOURCES = [
    "core/script-engine/src/types.rs",
    "core/script-engine/src/lib.rs",
    "core/script-engine/src/notebook.rs",
    "core/script-engine/src/manifest.rs",
    "app/src-tauri/src/scripting/types.rs",
    "app/src-tauri/src/scripting/commands.rs",
    "app/src-tauri/src/scripting/notebook_commands.rs",
    "app/src/api/workbookScripts.ts",
    "app/extensions/ScriptNotebook/types.ts",
    // THE WORKER-REALM HALF, which the original sweep omitted. The removal was
    // argued as "there is no consumer, so the switch would be a lie" — and the
    // place a reflexive re-add would land is the OBJECT-SCRIPT surface (an
    // `application` facet on the context shim and a `case "api.enableEvents"` in
    // the host executor), not the Rust interpreter these other files cover. A
    // sweep that cannot see the likeliest re-add site is a sweep that will pass
    // on the day it matters.
    "app/src/api/scriptHost/host.ts",
    "app/src/api/scriptHost/worker/contextShims.ts",
  ];

  it("no longer exists as a field, a property or a response member", () => {
    for (const rel of SOURCES) {
      const src = readRepo(rel);
      expect(src.includes("enable_events"), `${rel} still declares enable_events`).toBe(false);
      expect(src.includes("enableEvents"), `${rel} still declares enableEvents`).toBe(false);
    }
  });

  it("is not in the script-surface manifest, so no audit line claims it exists", () => {
    const manifest = readRepo("core/script-engine/src/manifest.rs");
    expect(manifest).not.toContain("Calcula.application.enableEvents");
    // screenUpdating stays: it HAS a consumer (the post-run grid refresh).
    expect(manifest).toContain("Calcula.application.screenUpdating");
  });

  it("leaves a note at the site explaining why, so it is not re-added by reflex", () => {
    const ops = readRepo("core/script-engine/src/ops/application.rs");
    expect(ops).toContain("enableEvents IS DELIBERATELY ABSENT");
    expect(ops).toContain("recordScriptWrite");
    const dts = readRepo("app/extensions/_shared/lib/calcula.d.ts");
    expect(dts).toContain("There is deliberately NO `enableEvents`");
  });

  it("keeps the re-entrancy guard that actually works", () => {
    // The storm enableEvents was meant to stop is prevented structurally: a
    // script's own writes are attributed and never re-delivered to that script's
    // own change handlers. That guard cannot be left switched off by a script
    // that faulted halfway through.
    expect(hostSrc).toContain("function isOwnScriptWrite");
    expect(hostSrc).toContain("function recordScriptWrite");
  });
});
