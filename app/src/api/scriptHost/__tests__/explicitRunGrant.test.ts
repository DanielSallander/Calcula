//! FILENAME: app/src/api/scriptHost/__tests__/explicitRunGrant.test.ts
// PURPOSE: Owner decision B (2026-09-30): an approved application macro that a
//          PERSON runs gets "the same CELL access" a module-runtime macro has --
//          and, since the owner's 2026-11-04 decision, FORMATTING as well -- and
//          nothing more. This pins the grant as two closed tables, the broker's
//          decision over them, the argument rules (no protection attributes,
//          the restricted bound), the handle flags, and the pre-flight scan.
// CONTEXT: explicitRunGrant.ts, brokerPolicy.ts decidePolicy, broker.ts
//          buildHandleFromDefinition. The realm keeps tier "restricted"; two
//          identity flags (`explicitRun.cells` / `.formatting`) admit exactly
//          the rows below.

import { describe, it, expect } from "vitest";
import { ALLOWLIST } from "../allowlist";
import { ALL_CAPABILITY_IDS, type CapabilityId } from "../capabilityIds";
import { decidePolicy, type PolicyIdentity } from "../brokerPolicy";
import { buildHandleFromDefinition } from "../broker";
import {
  EXPLICIT_RUN_CELL_METHODS,
  EXPLICIT_RUN_FORMAT_METHODS,
  EXPLICIT_RUN_FORMAT_WRITES,
  EXPLICIT_RUN_LINE_SIZE_METHODS,
  EXPLICIT_RUN_RESTRICTED_FORMAT_METHODS,
  RUN_ONLY_REFUSED_METHODS,
  explicitRunAdmits,
  explicitRunArgsRefusal,
  explicitRunFormatRefusalMessage,
  explicitRunProtectionRefusalMessage,
  explicitRunRefusalMessage,
  explicitRunRestrictedRefusal,
  runOnlyRefusalMessage,
  ungrantedApiCalls,
} from "../explicitRunGrant";
import { MAX_RANGE_CELLS, MAX_RESTRICTED_FORMAT_RECT_CELLS } from "../validators";

/** Every capability id, from the ONE list (never re-typed). */
const EVERY_CAP: ReadonlySet<CapabilityId> = new Set(ALL_CAPABILITY_IDS);

/** A realm an explicit run mounted, with every capability granted AND declared
 *  -- so a refusal below can only be the grant's, never the capability ceiling's. */
const granted: PolicyIdentity = {
  tier: "restricted",
  explicitRun: { cells: true, formatting: true },
  grants: EVERY_CAP,
  declaredCapabilities: EVERY_CAP,
};
/** Rust granted cell access WITHOUT formatting (an older backend's answer). */
const cellsOnly: PolicyIdentity = { ...granted, explicitRun: { cells: true, formatting: false } };
const expired: PolicyIdentity = { ...granted, explicitRun: { cells: false, formatting: false } };
const plainRestricted: PolicyIdentity = {
  tier: "restricted",
  grants: EVERY_CAP,
  declaredCapabilities: EVERY_CAP,
};
/** Positive control for argument validity: an unlocked identity admits them. */
const unlocked: PolicyIdentity = { ...plainRestricted, tier: "unlocked" };

const THE_TWENTY = [
  "api.getCellValue",
  "api.getCellData",
  "api.getRangeValues",
  "api.getCellFormula",
  "api.getUsedRange",
  "api.getCurrentRegion",
  "api.getRangeEdge",
  "api.getSheetNames",
  "api.getSheets",
  "api.getActiveSheet",
  "api.setCellValue",
  "api.updateCellsBatch",
  "api.setCellFormula",
  "api.fillRange",
  // BUG-0616 #2 (added deliberately): clearing cells IS cell access -- VBA's
  // Range.ClearContents in a macro -- contents only (explicitRunArgsRefusal).
  "api.clearRange",
  "api.setActiveSheet",
  "api.recalculate",
  "api.getCalculationMode",
  "api.beginBatch",
  "api.commitBatch",
  "api.cancelBatch",
];

/** The formatting table (owner, 2026-11-04), pinned row by row. */
const THE_FORMAT_ROWS = [
  "api.getRangeFormat",
  "api.getCellFormat",
  "api.listNamedStyles",
  "api.getThemePalette",
  "api.setRangeFormat",
  "api.clearRangeFormat",
  "api.applyNamedStyle",
  "api.setRowHeight",
  "api.setColumnWidth",
  "api.setRowHeights",
  "api.setColumnWidths",
  "api.autoFitColumns",
  "api.autoFitRows",
];

describe("the grant is a closed table of cell rows", () => {
  // SABOTAGE (c): add "api.executeCommand" to EXPLICIT_RUN_CELL_METHODS -> this
  // exact-set test and the curated executeCommand refusal go red.
  it("is EXACTLY these twenty-one rows (adding one is a deliberate edit here)", () => {
    expect([...EXPLICIT_RUN_CELL_METHODS].sort()).toEqual([...THE_TWENTY].sort());
  });

  it("every row is a real unlocked-tier ALLOWLIST row with no capability", () => {
    for (const method of EXPLICIT_RUN_CELL_METHODS) {
      const policy = ALLOWLIST[method];
      expect(policy, `${method} is not an ALLOWLIST row`).toBeDefined();
      expect(policy.tier, method).toBe("unlocked");
      expect(policy.capability, method).toBeUndefined();
    }
  });

  // SABOTAGE (a): drop the `EXPLICIT_RUN_CELL_METHODS.has(method)` conjunct in
  // explicitRunAdmits -> every unlocked row (api.runMacro, api.executeCommand,
  // api.workbookSave, the protection family...) is admitted and this goes red.
  it("EXHAUSTIVE: over every ALLOWLIST row, the grant admits a row iff it is in one of its tables", () => {
    const wronglyAdmitted: string[] = [];
    const wronglyRefused: string[] = [];
    for (const method of Object.keys(ALLOWLIST)) {
      const admits = explicitRunAdmits(granted, method);
      const inTable = EXPLICIT_RUN_CELL_METHODS.has(method) || EXPLICIT_RUN_FORMAT_METHODS.has(method);
      if (admits && !inTable) wronglyAdmitted.push(method);
      if (!admits && inTable) wronglyRefused.push(method);
      // Cell access WITHOUT formatting admits the cell table alone.
      expect(explicitRunAdmits(cellsOnly, method), `cells-only ${method}`).toBe(EXPLICIT_RUN_CELL_METHODS.has(method));
    }
    expect(wronglyAdmitted, "the grant reaches beyond cells and formatting").toEqual([]);
    expect(wronglyRefused).toEqual([]);
    // The families the owner's words exclude, named so a reader sees them --
    // including every formatting-ADJACENT row the line was drawn against
    // (protection, visibility, rules, the style catalogue, merges, sheet-level
    // settings: explicitRunGrant.ts "FORMATTING AS WELL, DRAWN").
    for (const method of [
      "api.runMacro",
      "api.executeCommand",
      "api.emitEvent",
      "api.onEvent",
      "api.workbookSave",
      "api.workbookSaveAs",
      "api.protectSheet",
      "api.unprotectSheet",
      "api.beginUnprotected",
      "api.sortRange",
      "api.insertRows",
      "api.deleteColumns",
      "api.mergeCells",
      "api.unmergeCells",
      "api.createNamedStyle",
      "api.deleteNamedStyle",
      "api.setRowsHidden",
      "api.setColumnsHidden",
      "api.addConditionalFormat",
      "api.clearConditionalFormats",
      "api.setDataValidation",
      "api.setTabColor",
      "api.setPageSetup",
      "api.setPrintArea",
      "api.setViewOption",
      "api.freezePanes",
      "api.copyRange",
      "api.pasteRange",
      "api.addSheet",
      "api.objectSetState",
      "api.userName",
      "cap.pkgPull",
      "cap.pkgPublish",
    ]) {
      expect(ALLOWLIST[method], `${method} is no longer an ALLOWLIST row`).toBeDefined();
      expect(explicitRunAdmits(granted, method), method).toBe(false);
    }
  });

  // SABOTAGE: add "api.setRowsHidden" to EXPLICIT_RUN_FORMAT_METHODS -> red.
  it("the formatting table is EXACTLY these thirteen rows, each a real capability-free unlocked row", () => {
    expect([...EXPLICIT_RUN_FORMAT_METHODS].sort()).toEqual([...THE_FORMAT_ROWS].sort());
    for (const method of EXPLICIT_RUN_FORMAT_METHODS) {
      const policy = ALLOWLIST[method];
      expect(policy, `${method} is not an ALLOWLIST row`).toBeDefined();
      expect(policy.tier, method).toBe("unlocked");
      expect(policy.capability, method).toBeUndefined();
      expect(EXPLICIT_RUN_CELL_METHODS.has(method), `${method} is in both tables`).toBe(false);
    }
    // Every formatting WRITE is recorded for the trail; every resize is held
    // to the hidden-line rule.
    for (const method of EXPLICIT_RUN_FORMAT_METHODS) {
      const writes = ALLOWLIST[method].class === "mutate";
      expect(EXPLICIT_RUN_FORMAT_WRITES.has(method), method).toBe(writes);
    }
    for (const method of EXPLICIT_RUN_LINE_SIZE_METHODS) expect(EXPLICIT_RUN_FORMAT_METHODS.has(method), method).toBe(true);
    expect([...EXPLICIT_RUN_FORMAT_WRITES].filter((m) => !EXPLICIT_RUN_FORMAT_METHODS.has(m)).sort()).toEqual([
      "api.clearRange",
      "sheet.clearRangeFormat",
      "sheet.setRangeFormat",
    ]);
  });

  it("an expired or absent grant admits nothing", () => {
    for (const method of [...EXPLICIT_RUN_CELL_METHODS, ...EXPLICIT_RUN_FORMAT_METHODS]) {
      expect(explicitRunAdmits(expired, method), method).toBe(false);
      expect(explicitRunAdmits(plainRestricted, method), method).toBe(false);
    }
  });
});

describe("decidePolicy: the grant admits cell calls and refuses the rest, loudly", () => {
  const admittedCalls: Array<[string, unknown[]]> = [
    ["api.setCellValue", [0, 0, "x"]],
    ["api.setCellValue", [0, 0, "x", "Sheet2"]],
    ["api.updateCellsBatch", [[{ row: 0, col: 0, value: "x" }]]],
    ["api.setActiveSheet", [1]],
    ["api.beginBatch", ["m"]],
    ["api.commitBatch", []],
    ["api.getCellValue", [3, 4]],
    // FORMATTING (owner, 2026-11-04), on any sheet.
    ["api.setRangeFormat", [0, 0, 9, 3, { bold: true, numberFormat: "0.00", borderOutline: { style: "thin", color: "#000000" } }]],
    ["api.setRangeFormat", [0, 2, 1_048_575, 2, { fill: { type: "solid", color: "#ffeeaa" } }, "Sheet2"]],
    ["api.clearRangeFormat", [0, 0, 4, 4]],
    ["api.applyNamedStyle", ["Good", 0, 0, 2, 2]],
    ["api.setRowHeights", [[[0, 4]], 30]],
    ["api.setColumnWidth", [2, 120]],
    ["api.autoFitColumns", [0, 3]],
    ["api.getRangeFormat", [0, 0, 1, 1, "Sheet2"]],
  ];

  it("admits the cell and formatting rows for a granted realm (tier stays restricted)", () => {
    for (const [method, args] of admittedCalls) {
      const decision = decidePolicy(granted, method, args);
      expect(decision.admitted, `${method} ${JSON.stringify(args)}`).toBe(true);
    }
  });

  const refusedCalls: Array<[string, unknown[]]> = [
    ["api.runMacro", ["m"]],
    ["api.executeCommand", ["x"]],
    ["api.workbookSave", []],
    // Every non-formatting widening the owner's decision does NOT make.
    ["api.createNamedStyle", ["Mine", { bold: true }]],
    ["api.deleteNamedStyle", ["Mine"]],
    ["api.setRowsHidden", [0, 2, true]],
    ["api.setColumnsHidden", [0, 2, false]],
    ["api.mergeCells", [0, 0, 1, 1]],
    ["api.insertRows", [0, 1]],
    ["api.setTabColor", [0, "#ff0000"]],
    ["api.protectSheet", []],
    ["api.unprotectSheet", []],
  ];

  it("refuses everything else unlocked with the grant's sentence -- after validation passed", () => {
    for (const [method, args] of refusedCalls) {
      // POSITIVE CONTROL: the arguments are valid, so what refuses below is the
      // grant, not the validator.
      expect(decidePolicy(unlocked, method, args).admitted, `${method}: args invalid`).toBe(true);
      const decision = decidePolicy(granted, method, args);
      expect(decision.admitted, method).toBe(false);
      if (!decision.admitted) {
        expect(decision.code).toBe("PermissionDenied");
        expect(decision.message).toBe(explicitRunRefusalMessage(method));
      }
    }
  });

  it("an application-publishing capability row is refused at the TIER, even granted and declared", () => {
    const args = ["C:/workspace", "Sales", "1.0.0"];
    expect(decidePolicy(unlocked, "cap.pkgPull", args).admitted, "args invalid").toBe(true);
    const decision = decidePolicy(granted, "cap.pkgPull", args);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.code).toBe("PermissionDenied");
      // The tier refusal, not the capability ceiling's or the grant store's.
      expect(decision.message).toBe(explicitRunRefusalMessage("cap.pkgPull"));
      expect(decision.capability).toBeUndefined();
    }
  });

  it("an EXPIRED grant refuses a cell write with the grant's sentence", () => {
    const decision = decidePolicy(expired, "api.setCellValue", [0, 0, "x"]);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.code).toBe("PermissionDenied");
      expect(decision.message).toBe(explicitRunRefusalMessage("api.setCellValue"));
    }
  });

  it("a realm WITHOUT the grant is refused exactly as before, byte for byte", () => {
    const decision = decidePolicy(plainRestricted, "api.setCellValue", [0, 0, "x"]);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) {
      expect(decision.message).toBe("api.setCellValue requires unlocked access; this script is restricted");
    }
  });

  // BUG-0616 #2 + the owner's 2026-11-04 decision. SABOTAGE: drop the
  // explicitRunArgsRefusal check from decidePolicy -> a cells-only Clear All is
  // admitted.
  it("api.clearRange: contents with cell access; formats and all with the formatting grant only", () => {
    const contents: unknown[][] = [
      [0, 2, 9, 2, { applyTo: "contents" }],
      [0, 2, 1_048_575, 2, { applyTo: "contents" }, "Sheet2"],
    ];
    const formats: unknown[][] = [
      [0, 2, 9, 2],
      [0, 2, 9, 2, { applyTo: "all" }],
      [0, 2, 9, 2, { applyTo: "formats" }, 1],
      [0, 2, 1_048_575, 2, { applyTo: "formats" }, "Sheet2"],
    ];
    for (const args of contents) {
      expect(decidePolicy(granted, "api.clearRange", args).admitted, JSON.stringify(args)).toBe(true);
      expect(decidePolicy(cellsOnly, "api.clearRange", args).admitted, JSON.stringify(args)).toBe(true);
    }
    for (const args of formats) {
      // POSITIVE CONTROL: valid arguments, admitted for an unlocked script.
      expect(decidePolicy(unlocked, "api.clearRange", args).admitted, "args invalid").toBe(true);
      expect(decidePolicy(granted, "api.clearRange", args).admitted, `formatting ${JSON.stringify(args)}`).toBe(true);
      const decision = decidePolicy(cellsOnly, "api.clearRange", args);
      expect(decision.admitted, JSON.stringify(args)).toBe(false);
      if (!decision.admitted) {
        expect(decision.code).toBe("PermissionDenied");
        expect(decision.message).toBe(explicitRunArgsRefusal("api.clearRange", args, cellsOnly));
        expect(decision.message).toMatch(/cell access but not formatting/);
      }
    }
    // The argument rule is the grant's alone: other rows are untouched by it.
    expect(explicitRunArgsRefusal("api.setCellValue", [0, 0, "x"], granted)).toBeNull();
  });

  // SABOTAGE: drop the PROTECTION_FORMAT_KEYS arm of explicitRunArgsRefusal ->
  // a granted run unlocks cells.
  it("api.setRangeFormat: how cells look, never whether they are locked or hide their formula", () => {
    for (const format of [{ locked: false }, { formulaHidden: true }, { bold: true, locked: true }]) {
      const args = [0, 0, 4, 4, format];
      expect(decidePolicy(unlocked, "api.setRangeFormat", args).admitted, "args invalid").toBe(true);
      const decision = decidePolicy(granted, "api.setRangeFormat", args);
      expect(decision.admitted, JSON.stringify(format)).toBe(false);
      if (!decision.admitted) {
        expect(decision.code).toBe("PermissionDenied");
        expect(decision.message).toMatch(/is protection, which code from an application never sets/);
      }
    }
    expect(explicitRunProtectionRefusalMessage("api.setRangeFormat", ["locked"])).toMatch(/not locked/);
    // The restricted row never accepted them either (its validator refuses).
    expect(decidePolicy(granted, "sheet.setRangeFormat", [0, 0, 0, 0, { locked: false }]).admitted).toBe(false);
  });

  // BUG-0659. SABOTAGE: set MAX_RESTRICTED_FORMAT_RECT_CELLS to 4_000_000 ->
  // both the granted and the sheet.* refusals go red.
  it("BUG-0659: a restricted realm's non-line format rectangle is bounded at 100,000 cells; whole lines are not", () => {
    expect(MAX_RESTRICTED_FORMAT_RECT_CELLS).toBe(MAX_RANGE_CELLS);
    expect(MAX_RESTRICTED_FORMAT_RECT_CELLS).toBe(100_000);
    // 400 x 251 = 100,400 cells, not whole lines.
    const big = [0, 0, 399, 250];
    // 100 x 1000 = 100,000 exactly: inside.
    const atBound = [0, 0, 99, 999];
    const wholeColumns = [0, 2, 1_048_575, 40];
    const wholeRows = [4, 0, 900, 16_383];
    // THE GRANTED RUN, through the unlocked rows it reaches:
    for (const [method, args] of [
      ["api.setRangeFormat", [...big, { bold: true }]],
      ["api.clearRangeFormat", big],
      ["api.clearRange", [...big, { applyTo: "formats" }]],
    ] as Array<[string, unknown[]]>) {
      expect(decidePolicy(unlocked, method, args).admitted, `the user's own ${method}`).toBe(true);
      const decision = decidePolicy(granted, method, args);
      expect(decision.admitted, method).toBe(false);
      if (!decision.admitted) expect(decision.message).toMatch(/range too large: 100400 cells \(max 100000/);
    }
    for (const rect of [atBound, wholeColumns, wholeRows]) {
      expect(decidePolicy(granted, "api.setRangeFormat", [...rect, { bold: true }]).admitted, JSON.stringify(rect)).toBe(true);
      expect(decidePolicy(granted, "api.clearRange", [...rect, { applyTo: "all" }]).admitted, JSON.stringify(rect)).toBe(true);
    }
    // A CONTENTS clear is cell access: only stored cells are touched, so the
    // unlocked bound stands.
    expect(decidePolicy(granted, "api.clearRange", [...big, { applyTo: "contents" }]).admitted).toBe(true);
    // THE RESTRICTED ROWS, for every realm (their validator):
    for (const identity of [plainRestricted, granted, unlocked]) {
      expect(decidePolicy(identity, "sheet.setRangeFormat", [...big, { bold: true }]).admitted).toBe(false);
      expect(decidePolicy(identity, "sheet.clearRangeFormat", big).admitted).toBe(false);
      expect(decidePolicy(identity, "sheet.setRangeFormat", [...wholeColumns, { bold: true }]).admitted).toBe(true);
      expect(decidePolicy(identity, "sheet.clearRangeFormat", wholeRows).admitted).toBe(true);
    }
    expect(ALLOWLIST["sheet.setRangeFormat"].limits?.maxCells).toBe(MAX_RESTRICTED_FORMAT_RECT_CELLS);
    expect(ALLOWLIST["sheet.clearRangeFormat"].limits?.maxCells).toBe(MAX_RESTRICTED_FORMAT_RECT_CELLS);
  });

  // SANDBOX: a run a SCRIPT starts has no pass, so it is a plain restricted
  // realm -- every formatting row of the grant is refused at the tier, with the
  // old sentence, and the sheet on screen is all it may format.
  it("a run a SCRIPT started gets no formatting: every grant row is refused at the tier", () => {
    for (const [method, args] of admittedCalls.filter(([m]) => EXPLICIT_RUN_FORMAT_METHODS.has(m))) {
      const decision = decidePolicy(plainRestricted, method, args);
      expect(decision.admitted, method).toBe(false);
      if (!decision.admitted) {
        expect(decision.message).toBe(`${method} requires unlocked access; this script is restricted`);
      }
    }
    const clear = decidePolicy(plainRestricted, "api.clearRange", [0, 0, 1, 1, { applyTo: "formats" }]);
    expect(clear.admitted).toBe(false);
  });

  it("api.clearRange: a run a SCRIPT started (no grant) and an expired grant are refused as before", () => {
    const args = [0, 2, 9, 2, { applyTo: "contents" }];
    const plain = decidePolicy(plainRestricted, "api.clearRange", args);
    expect(plain.admitted).toBe(false);
    if (!plain.admitted) {
      expect(plain.message).toBe("api.clearRange requires unlocked access; this script is restricted");
    }
    const late = decidePolicy(expired, "api.clearRange", args);
    expect(late.admitted).toBe(false);
    if (!late.admitted) expect(late.message).toBe(explicitRunRefusalMessage("api.clearRange"));
  });

  const runOnlyCalls: Array<[string, unknown[]]> = [
    ["base.expose", ["m", false]],
    ["events.subscribe", ["x"]],
    // OUTBOUND: what the run read from any sheet, handed to another script.
    ["base.callMethod", ["workbook", null, "send", [["data"]]]],
  ];

  it("RUN-ONLY: expose, event subscriptions and calls into other scripts are refused for any explicit-run realm", () => {
    for (const identity of [granted, expired]) {
      for (const [method, args] of runOnlyCalls) {
        const decision = decidePolicy(identity, method, args);
        expect(decision.admitted, `${method} for cells=${identity.explicitRun?.cells}`).toBe(false);
        if (!decision.admitted) {
          expect(decision.code).toBe("PermissionDenied");
          expect(decision.message).toBe(runOnlyRefusalMessage(method));
        }
      }
    }
    expect([...RUN_ONLY_REFUSED_METHODS].sort()).toEqual(["base.callMethod", "base.expose", "events.subscribe"]);
    // The outbound refusal says what it protects, not the inbound sentence.
    expect(runOnlyRefusalMessage("base.callMethod")).toMatch(/cannot call into another script/);
  });

  it("CONTROL: a plain restricted realm may still expose, subscribe and call another script", () => {
    for (const [method, args] of runOnlyCalls) {
      expect(decidePolicy(plainRestricted, method, args).admitted, method).toBe(true);
    }
  });

  const formatCalls: Array<[string, unknown[]]> = [
    ["sheet.setRangeFormat", [0, 0, 0, 0, { bold: true }]],
    ["sheet.clearRangeFormat", [0, 0, 0, 0]],
  ];

  // The composition the table walk above cannot see: api.setActiveSheet is
  // granted, and every restricted sheet.* row is clamped to the LIVE active
  // sheet -- so the restricted formatting rows follow the run to every sheet
  // it switches to. That IS the formatting grant: admitted while it is live,
  // refused for a realm whose formatting was not granted or has ended.
  // SABOTAGE: drop the formatting condition from explicitRunRestrictedRefusal
  // (refuse always) -> the granted admission goes red; drop the whole check ->
  // the cells-only / expired refusals go red.
  it("FORMATTING: the restricted format-write rows follow the formatting grant", () => {
    for (const [method, args] of formatCalls) {
      expect(decidePolicy(granted, method, args).admitted, `granted ${method}`).toBe(true);
    }
    for (const identity of [cellsOnly, expired]) {
      for (const [method, args] of formatCalls) {
        const decision = decidePolicy(identity, method, args);
        expect(decision.admitted, `${method} for ${JSON.stringify(identity.explicitRun)}`).toBe(false);
        if (!decision.admitted) {
          expect(decision.code).toBe("PermissionDenied");
          expect(decision.message).toBe(explicitRunFormatRefusalMessage(method));
        }
      }
    }
    expect([...EXPLICIT_RUN_RESTRICTED_FORMAT_METHODS].sort()).toEqual([
      "sheet.clearRangeFormat",
      "sheet.setRangeFormat",
    ]);
  });

  it("CONTROL: a plain restricted realm may still format the sheet on screen", () => {
    for (const [method, args] of formatCalls) {
      expect(decidePolicy(plainRestricted, method, args).admitted, method).toBe(true);
    }
  });

  // EXHAUSTIVE over the RESTRICTED tier, the half the twenty-row walk does not
  // cover. A granted realm keeps every restricted row a plain restricted realm
  // has, EXCEPT the ones listed in `refused`; a new restricted row fails here
  // until someone decides what a granted run may do with it -- in particular
  // whether `api.setActiveSheet` turns its "sheet on screen" into "every sheet".
  it("EXHAUSTIVE: every capability-free RESTRICTED row is classified for a granted run", () => {
    const refused = [
      "base.callMethod",
      "base.expose",
      "events.subscribe",
      "sheet.clearRangeFormat",
      "sheet.setRangeFormat",
    ];
    const admitted = [
      "base.log",
      "base.notify",
      "base.unexpose",
      // Capped per call by the CALLER's own grants (authorizeImportCall), so it
      // carries no reach the run does not already hold.
      "base.callImport",
      "object.getState",
      "object.setState",
      "object.declareProperties",
      "render.invalidate",
      // Cell content: the grant already reaches every sheet with the api.* twins.
      "sheet.getCellValue",
      "sheet.setCellValue",
      "sheet.getCellData",
      "sheet.getRangeValues",
      "sheet.setRangeValues",
      "sheet.getCellFormula",
      "sheet.setCellFormula",
      // Format READS disclose less than the value reads the grant gives.
      "sheet.getRangeFormat",
      "sheet.getCellFormat",
      // A form is shown only through a consented ui.dialog capability.
      "form.define",
      "form.readControl",
      // Extension-realm rows: the script host has no implementation for them.
      "ext.notify",
      "ext.log",
      "ext.executeCommand",
      "ext.emitEvent",
      "ext.invalidateCellStyles",
      // Capability-free since ext2 (round 11): publishing a job method grants
      // nothing; creating the job needs `schedule`.
      "ext.scheduleExpose",
    ];
    const restrictedNoCap = Object.keys(ALLOWLIST)
      .filter((m) => ALLOWLIST[m].tier === "restricted" && !ALLOWLIST[m].capability)
      .sort();
    expect(restrictedNoCap, "a restricted row is unclassified for a granted run").toEqual(
      [...refused, ...admitted].sort(),
    );
    // An EXPIRED (or formatting-less) grant refuses the whole list; a LIVE
    // formatting grant gives the two formatting rows back.
    for (const method of refused) {
      expect(explicitRunRestrictedRefusal(method, expired), method).not.toBeNull();
      expect(explicitRunRestrictedRefusal(method, cellsOnly), method).not.toBeNull();
      expect(explicitRunRestrictedRefusal(method, granted) === null, `live ${method}`).toBe(
        EXPLICIT_RUN_RESTRICTED_FORMAT_METHODS.has(method),
      );
    }
    for (const method of admitted) {
      expect(explicitRunRestrictedRefusal(method, expired), method).toBeNull();
      expect(explicitRunRestrictedRefusal(method, granted), method).toBeNull();
    }
  });

  it("the restricted rows a granted realm already had are unchanged", () => {
    expect(decidePolicy(granted, "base.notify", ["hi"]).admitted).toBe(true);
    expect(decidePolicy(granted, "sheet.setCellValue", [0, 0, "x"]).admitted).toBe(true);
  });
});

describe("the handle carries the flag only for a distributed, restricted definition", () => {
  const base = {
    name: "Macro B",
    objectType: "workbook",
    instanceId: null,
    declaredCapabilities: [],
  };
  let seq = 0;
  const id = (): string => `__calcula_grant_test_${++seq}`;

  it("distributed + restricted + grant -> explicitRun.cells, tier restricted, package origin", () => {
    const handle = buildHandleFromDefinition(
      { ...base, id: id(), accessLevel: "restricted", provenance: "distributed", packageName: "Sales" },
      { explicitRunCells: true },
    );
    // Formatting only when the admission says so (Rust's formatAccess).
    expect(handle.explicitRun).toEqual({ cells: true, formatting: false });
    const withFormatting = buildHandleFromDefinition(
      { ...base, id: id(), accessLevel: "restricted", provenance: "distributed", packageName: "Sales" },
      { explicitRunCells: true, explicitRunFormatting: true },
    );
    expect(withFormatting.explicitRun).toEqual({ cells: true, formatting: true });
    // Never formatting without cells.
    const formattingAlone = buildHandleFromDefinition(
      { ...base, id: id(), accessLevel: "restricted", provenance: "distributed", packageName: "Sales" },
      { explicitRunFormatting: true },
    );
    expect(formattingAlone.explicitRun).toBeUndefined();
    expect(handle.tier).toBe("restricted");
    expect(handle.origin).toEqual({ kind: "package", name: "Sales" });
  });

  // SABOTAGE (b): drop the `isDistributed` condition in buildHandleFromDefinition
  // -> a LOCAL handle carries the flag and this goes red.
  it("local + grant -> no flag (local code already has the unlocked surface)", () => {
    const handle = buildHandleFromDefinition(
      { ...base, id: id(), accessLevel: "restricted", provenance: "local" },
      { explicitRunCells: true },
    );
    expect(handle.explicitRun).toBeUndefined();
  });

  it("distributed + unlocked (cannot happen) + grant -> no flag", () => {
    const handle = buildHandleFromDefinition(
      { ...base, id: id(), accessLevel: "unlocked", provenance: "distributed", packageName: "Sales" },
      { explicitRunCells: true },
    );
    expect(handle.explicitRun).toBeUndefined();
  });

  it("distributed + restricted WITHOUT the grant -> no flag (every existing caller)", () => {
    const handle = buildHandleFromDefinition({
      ...base,
      id: id(),
      accessLevel: "restricted",
      provenance: "distributed",
      packageName: "Sales",
    });
    expect(handle.explicitRun).toBeUndefined();
    const refused = buildHandleFromDefinition(
      { ...base, id: id(), accessLevel: "restricted", provenance: "distributed", packageName: "Sales" },
      { explicitRunCells: false },
    );
    expect(refused.explicitRun).toBeUndefined();
  });
});

describe("the pre-flight names the calls outside cell access, before anything runs", () => {
  const RECORDED_CELLS_ONLY = [
    "async function macroB(api) {",
    "  await api.setActiveSheet(\"Sheet1\");",
    "  await api.beginBatch(\"Macro B\");",
    "  try {",
    "    await api.setCellValue(0, 0, \"OWNER-B\");",
    "    await api.updateCellsBatch([{ row: 1, col: 0, value: 2 }]);",
    "    await api.fillRange(0, 0, 5, 0, { direction: \"down\" });",
    "    await api.commitBatch();",
    "  } catch (e) {",
    "    await api.cancelBatch();",
    "    throw e;",
    "  }",
    "}",
    "function setup(context) {",
    "  if (!context.api) { context.notify(\"restricted\", \"error\"); return; }",
    "  return macroB(context.api);",
    "}",
  ].join("\n");

  it("a recorder-shaped cell-only macro passes", () => {
    expect(ungrantedApiCalls(RECORDED_CELLS_ONLY)).toEqual([]);
  });

  // The owner's 2026-11-04 decision: a recorded macro that formats passes.
  it("a recorded macro that formats, clears formats and sizes rows passes (owner, 2026-11-04)", () => {
    const withLine = (line: string): string => `${RECORDED_CELLS_ONLY}\n${line}\n`;
    for (const line of [
      'await api.clearRange(0, 2, 9, 2, { applyTo: "all" }, 1);',
      "await api.clearRange(0, 2, 9, 2);",
      'await api.clearRange(0, 0, f(1), 2, { applyTo: "formats" });',
      "await api.clearRangeFormat(0, 2, 1048575, 2);",
      'await api.setRangeFormat(0, 0, 4, 4, { bold: true, numberFormat: "0.00" }, 1);',
      'await api.applyNamedStyle("Good", 0, 0, 1, 1);',
      "await api.setRowHeights([[0, 4]], 30);",
      "await api.setColumnWidth(2, 120);",
    ]) {
      expect(ungrantedApiCalls(withLine(line)), line).toEqual([]);
    }
  });

  // SABOTAGE: delete the callArgumentsMatch line in ungrantedApiCalls -> a
  // macro that unlocks cells passes the pre-flight.
  it("a format that names locked or formulaHidden is named (protection)", () => {
    const withLine = (line: string): string => `${RECORDED_CELLS_ONLY}\n${line}\n`;
    expect(ungrantedApiCalls(withLine("await api.setRangeFormat(0, 0, 4, 4, { locked: false });"))).toEqual([
      "api.setRangeFormat",
    ]);
    expect(ungrantedApiCalls(withLine("await api.setRangeFormat(0, 0, 4, 4, { bold: true, formulaHidden: true }, 1);"))).toEqual([
      "api.setRangeFormat",
    ]);
  });

  it("non-formatting calls are named, unique and sorted", () => {
    const src =
      RECORDED_CELLS_ONLY +
      "\nasync function more(api) { await api.sortRange(0,0,5,1,[]); await api.setRangeFormat(0,0,0,0,{bold:true}); await api.sortRange(1,1,2,2,[]); await api.setRowsHidden(0, 1, true); await api.mergeCells(0,0,1,1); }\n";
    expect(ungrantedApiCalls(src)).toEqual(["api.mergeCells", "api.setRowsHidden", "api.sortRange"]);
  });

  it("a commented-out call is ignored", () => {
    expect(ungrantedApiCalls(RECORDED_CELLS_ONLY + "\n// await api.sortRange(0,0,1,1,[]);\n")).toEqual([]);
    expect(ungrantedApiCalls(RECORDED_CELLS_ONLY + "\n/* api.workbookSave() */\n")).toEqual([]);
  });

  // SABOTAGE: delete the callMethod line in ungrantedApiCalls -> [] and red.
  it("a call into another script is named before anything runs (the broker would refuse it mid-run)", () => {
    expect(
      ungrantedApiCalls(RECORDED_CELLS_ONLY + "\nasync function tell(context) { await context.callMethod(\"workbook\", null, \"send\", 1); }\n"),
    ).toEqual(["base.callMethod"]);
    // A commented-out one is not a call.
    expect(ungrantedApiCalls(RECORDED_CELLS_ONLY + "\n// context.callMethod(\"workbook\", null, \"send\");\n")).toEqual([]);
  });

  it("context.api.runMacro is caught too", () => {
    expect(ungrantedApiCalls("function setup(context) { return context.api.runMacro(\"x\"); }")).toEqual([
      "api.runMacro",
    ]);
  });

  it("worker-local helpers and capability calls are not the pre-flight's business", () => {
    // api.sleep has no broker row (it never leaves the realm).
    expect(ALLOWLIST["api.sleep"]).toBeUndefined();
    expect(ungrantedApiCalls("await api.sleep(10);")).toEqual([]);
    // Capabilities travel through consent, not through this grant.
    expect(ungrantedApiCalls("await caps.biModel.upsert({});")).toEqual([]);
  });
});
