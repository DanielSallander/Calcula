//! FILENAME: app/src/api/scriptHost/__tests__/explicitRunGrant.test.ts
// PURPOSE: Owner decision B (2026-09-30): an approved application macro that a
//          PERSON runs gets "the same CELL access" a module-runtime macro has --
//          and nothing more. This pins the grant as a closed table, the broker's
//          decision over it, the handle flag, and the pre-flight scan.
// CONTEXT: explicitRunGrant.ts, brokerPolicy.ts decidePolicy, broker.ts
//          buildHandleFromDefinition. The realm keeps tier "restricted"; one
//          identity flag (`explicitRun.cells`) admits exactly the rows below.

import { describe, it, expect } from "vitest";
import { ALLOWLIST } from "../allowlist";
import { ALL_CAPABILITY_IDS, type CapabilityId } from "../capabilityIds";
import { decidePolicy, type PolicyIdentity } from "../brokerPolicy";
import { buildHandleFromDefinition } from "../broker";
import {
  EXPLICIT_RUN_CELL_METHODS,
  EXPLICIT_RUN_REFUSED_FORMAT_METHODS,
  RUN_ONLY_REFUSED_METHODS,
  explicitRunAdmits,
  explicitRunFormatRefusalMessage,
  explicitRunRefusalMessage,
  explicitRunRestrictedRefusal,
  runOnlyRefusalMessage,
  ungrantedApiCalls,
} from "../explicitRunGrant";

/** Every capability id, from the ONE list (never re-typed). */
const EVERY_CAP: ReadonlySet<CapabilityId> = new Set(ALL_CAPABILITY_IDS);

/** A realm an explicit run mounted, with every capability granted AND declared
 *  -- so a refusal below can only be the grant's, never the capability ceiling's. */
const granted: PolicyIdentity = {
  tier: "restricted",
  explicitRun: { cells: true },
  grants: EVERY_CAP,
  declaredCapabilities: EVERY_CAP,
};
const expired: PolicyIdentity = { ...granted, explicitRun: { cells: false } };
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
  "api.setActiveSheet",
  "api.recalculate",
  "api.getCalculationMode",
  "api.beginBatch",
  "api.commitBatch",
  "api.cancelBatch",
];

describe("the grant is a closed table of cell rows", () => {
  // SABOTAGE (c): add "api.executeCommand" to EXPLICIT_RUN_CELL_METHODS -> this
  // exact-set test and the curated executeCommand refusal go red.
  it("is EXACTLY these twenty rows (adding one is a deliberate edit here)", () => {
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
  it("EXHAUSTIVE: over every ALLOWLIST row, the grant admits a row iff it is in the table", () => {
    const wronglyAdmitted: string[] = [];
    const wronglyRefused: string[] = [];
    for (const method of Object.keys(ALLOWLIST)) {
      const admits = explicitRunAdmits(granted, method);
      const inTable = EXPLICIT_RUN_CELL_METHODS.has(method);
      if (admits && !inTable) wronglyAdmitted.push(method);
      if (!admits && inTable) wronglyRefused.push(method);
    }
    expect(wronglyAdmitted, "the grant reaches beyond cell access").toEqual([]);
    expect(wronglyRefused).toEqual([]);
    // The families the owner's words exclude, named so a reader sees them.
    for (const method of [
      "api.runMacro",
      "api.executeCommand",
      "api.emitEvent",
      "api.onEvent",
      "api.workbookSave",
      "api.workbookSaveAs",
      "api.protectSheet",
      "api.unprotectSheet",
      "api.setRangeFormat",
      "api.sortRange",
      "api.objectSetState",
      "api.userName",
      "cap.pkgPull",
      "cap.pkgPublish",
    ]) {
      expect(ALLOWLIST[method], `${method} is no longer an ALLOWLIST row`).toBeDefined();
      expect(explicitRunAdmits(granted, method), method).toBe(false);
    }
  });

  it("an expired or absent grant admits nothing", () => {
    for (const method of EXPLICIT_RUN_CELL_METHODS) {
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
  ];

  it("admits the cell rows for a granted realm (tier stays restricted)", () => {
    for (const [method, args] of admittedCalls) {
      const decision = decidePolicy(granted, method, args);
      expect(decision.admitted, `${method} ${JSON.stringify(args)}`).toBe(true);
    }
  });

  const refusedCalls: Array<[string, unknown[]]> = [
    ["api.runMacro", ["m"]],
    ["api.setRangeFormat", [0, 0, 0, 0, { bold: true }]],
    ["api.executeCommand", ["x"]],
    ["api.workbookSave", []],
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

  // The composition the twenty-row walk above cannot see: api.setActiveSheet is
  // granted, and every restricted sheet.* row is clamped to the LIVE active
  // sheet -- so the restricted formatting rows would follow the run to every
  // sheet it switches to.
  // SABOTAGE: drop the EXPLICIT_RUN_REFUSED_FORMAT_METHODS check from
  // explicitRunRestrictedRefusal -> both rows are admitted and this goes red.
  it("FORMATTING: the restricted format-write rows are refused for any explicit-run realm", () => {
    for (const identity of [granted, expired]) {
      for (const [method, args] of formatCalls) {
        const decision = decidePolicy(identity, method, args);
        expect(decision.admitted, `${method} for cells=${identity.explicitRun?.cells}`).toBe(false);
        if (!decision.admitted) {
          expect(decision.code).toBe("PermissionDenied");
          expect(decision.message).toBe(explicitRunFormatRefusalMessage(method));
        }
      }
    }
    expect([...EXPLICIT_RUN_REFUSED_FORMAT_METHODS].sort()).toEqual([
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
    ];
    const restrictedNoCap = Object.keys(ALLOWLIST)
      .filter((m) => ALLOWLIST[m].tier === "restricted" && !ALLOWLIST[m].capability)
      .sort();
    expect(restrictedNoCap, "a restricted row is unclassified for a granted run").toEqual(
      [...refused, ...admitted].sort(),
    );
    for (const method of refused) {
      expect(explicitRunRestrictedRefusal(method), method).not.toBeNull();
    }
    for (const method of admitted) {
      expect(explicitRunRestrictedRefusal(method), method).toBeNull();
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
    expect(handle.explicitRun).toEqual({ cells: true });
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

  it("formatting and sorting are named, unique and sorted", () => {
    const src =
      RECORDED_CELLS_ONLY +
      "\nasync function more(api) { await api.sortRange(0,0,5,1,[]); await api.setRangeFormat(0,0,0,0,{bold:true}); await api.sortRange(1,1,2,2,[]); }\n";
    expect(ungrantedApiCalls(src)).toEqual(["api.setRangeFormat", "api.sortRange"]);
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
