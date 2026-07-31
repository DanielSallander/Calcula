//! FILENAME: app/src/api/scriptHost/__tests__/writebackGateway.test.ts
// PURPOSE: Guard the three things that make `distribution.writeback` safe:
//          (1) the capability is fully threaded through the vocabulary, the
//          allowlist and the surface taxonomy — a grantable capability with no
//          consent text is a security-UX defect;
//          (2) the argument validators reject the shapes the Rust gateway would
//          reject anyway, but early and by name;
//          (3) THE DRAFT-CAPTURE BYPASS stays closed — a script grid write into
//          a .calp writeback region is routed through the same validated draft
//          path a human keystroke takes, and never reaches the grid when that
//          path refuses.
// CONTEXT: The bypass was real: `api.setCellValue` -> `lib.updateCell` skipped
//          the Distribution extension's commit guard entirely (it is an
//          editor-commit hook), so a script could write a writeback cell with
//          no draft, no schema check and no lifecycle check, leaving the grid
//          showing a value the writeback layer had never heard of.

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { ALL_CAPABILITY_IDS, CAPABILITY_ID_SET } from "../capabilityIds";
import { ALLOWLIST } from "../allowlist";
import { describeCapability, RUST_MIRRORED_CAPABILITIES } from "../capabilities";
import {
  BI_MODEL_SCRIPTABLE_KINDS,
  vBiModelBatch,
  vBiModelLineage,
  vBiModelValidate,
  vWritebackListSubmissions,
  vWritebackRegionId,
  vWritebackReview,
  vWritebackSaveDraft,
} from "../validators";
import {
  SCRIPT_SURFACES,
  auditScriptSurfaceCapabilities,
  brokerGatedCapabilities,
} from "../../scriptSurfaces";
import type { WritebackRegionEntry } from "../../distribution";
import {
  __setWritebackIndexForTests,
  captureWritebackWrite,
  captureWritebackWrites,
} from "../writebackWriteGuard";

// The guard resolves ../backend lazily; mocking the module gives us the wire.
const invokeBackend = vi.fn();
vi.mock("../../backend", () => ({
  invokeBackend: (...args: unknown[]) => invokeBackend(...args),
}));

const CAP = "distribution.writeback";

const WRITEBACK_METHODS = [
  "cap.writebackListRegions",
  "cap.writebackGetLayer",
  "cap.writebackSaveDraft",
  "cap.writebackSubmit",
  "cap.writebackPreview",
  "cap.writebackListSubmissions",
  "cap.writebackReview",
];

/** The two rows that act on OTHER PEOPLE's submitted data. Rust additionally
 *  gates them on Ed25519 package-signing key possession. */
const PUBLISHER_METHODS = ["cap.writebackListSubmissions", "cap.writebackReview"];

// ============================================================================
// 1. Vocabulary + consent completeness
// ============================================================================

describe("distribution.writeback is a fully threaded capability", () => {
  it("is in the one vocabulary", () => {
    expect(ALL_CAPABILITY_IDS).toContain(CAP);
    expect(CAPABILITY_ID_SET.has(CAP)).toBe(true);
  });

  it("has consent text that is a sentence, not the id", () => {
    const desc = describeCapability(CAP);
    expect(desc).not.toBe(CAP);
    expect(desc.length).toBeGreaterThan(30);
  });

  it("is mirrored into the authoritative Rust capability store", () => {
    // The TS broker's gate is advisory; script_writeback re-checks the grant in
    // Rust. A capability that is granted frontend-side but never mirrored would
    // be denied on every call with no way for the user to tell why.
    expect(RUST_MIRRORED_CAPABILITIES.has(CAP)).toBe(true);
  });

  it("gates every writeback broker method, and only those", () => {
    for (const m of WRITEBACK_METHODS) {
      expect(ALLOWLIST[m], `${m} missing from ALLOWLIST`).toBeDefined();
      expect(ALLOWLIST[m].capability, `${m} capability`).toBe(CAP);
    }
    const gated = Object.entries(ALLOWLIST)
      .filter(([, p]) => p.capability === CAP)
      .map(([m]) => m)
      .sort();
    expect(gated).toEqual([...WRITEBACK_METHODS].sort());
  });

  it("says PLAINLY in the publisher rows that they act on submitted data", () => {
    // These two read every respondent's answers and change what everyone
    // downstream sees. The consent string is the only place a non-programmer
    // learns that, so it must name the reach, not just the action.
    for (const m of PUBLISHER_METHODS) {
      const desc = ALLOWLIST[m].desc.toLowerCase();
      expect(desc, `${m} desc must say whose data it touches`).toMatch(
        /every respondent|somebody else|everyone/,
      );
      expect(desc, `${m} desc must say the signing key is required`).toContain("sign");
    }
  });

  it("the two SENDING rows are classed as leaving the machine", () => {
    // class "net" is what the transparency panel and the audit ring use to say
    // "this left the building". A submit that looked like a plain mutation
    // would be under-reported exactly where it matters most.
    expect(ALLOWLIST["cap.writebackSubmit"].class).toBe("net");
    expect(ALLOWLIST["cap.writebackReview"].class).toBe("net");
  });

  it("every worker-realm surface declares it (no understatement)", () => {
    const gated = brokerGatedCapabilities();
    expect(gated).toContain(CAP);
    for (const s of SCRIPT_SURFACES) {
      if (s.runtime !== "worker-realm" || s.mountCeiling) continue;
      expect(s.capabilities, `${s.id} understates its reach`).toContain(CAP);
    }
    for (const a of auditScriptSurfaceCapabilities()) {
      expect(a.understated, `${a.surfaceId} understated`).toEqual([]);
    }
  });
});

// ============================================================================
// 2. bi.model kind set must match Rust EXACTLY
// ============================================================================

describe("BI_MODEL_SCRIPTABLE_KINDS mirrors the Rust gateway", () => {
  const modelEditor = fs.readFileSync(
    path.resolve(__dirname, "../../../../src-tauri/src/bi/model_editor.rs"),
    "utf8",
  );

  it("matches GATEWAY_MUTABLE_KINDS one for one", () => {
    const block = modelEditor.match(/const GATEWAY_MUTABLE_KINDS: &\[&str\] = &\[([\s\S]*?)\];/);
    expect(block, "GATEWAY_MUTABLE_KINDS not found in model_editor.rs").toBeTruthy();
    const rustKinds = [...(block as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect([...BI_MODEL_SCRIPTABLE_KINDS].sort()).toEqual(rustKinds);
  });

  it("includes writebackColumn (the kind this wave added)", () => {
    expect(BI_MODEL_SCRIPTABLE_KINDS.has("writebackColumn")).toBe(true);
  });
});

// ============================================================================
// 3. Validators
// ============================================================================

describe("writeback validators", () => {
  it("vWritebackRegionId demands a non-empty id", () => {
    expect(vWritebackRegionId(["r1"])).toBe(true);
    expect(vWritebackRegionId([""])).toContain("non-empty");
    expect(vWritebackRegionId([42])).toContain("non-empty");
  });

  it("vWritebackSaveDraft checks the whole tuple", () => {
    expect(vWritebackSaveDraft(["r1", "s1", 0, 0, { type: "empty" }])).toBe(true);
    expect(vWritebackSaveDraft(["r1", "s1", 3, 4, { type: "number", value: 12.5 }])).toBe(true);
    expect(vWritebackSaveDraft(["r1", "", 0, 0, { type: "empty" }])).toContain("sheetId");
    expect(vWritebackSaveDraft(["r1", "s1", -1, 0, { type: "empty" }])).toContain("non-negative");
    expect(vWritebackSaveDraft(["r1", "s1", 0, 1.5, { type: "empty" }])).toContain("non-negative");
    expect(vWritebackSaveDraft(["r1", "s1", 0, 0, { type: "number", value: "12" }])).toContain(
      "finite number",
    );
    expect(vWritebackSaveDraft(["r1", "s1", 0, 0, { type: "date", value: "x" }])).toContain(
      "number|text|boolean|empty",
    );
    expect(vWritebackSaveDraft(["r1", "s1", 0, 0, null])).toContain("value must be an object");
  });

  it("a publisher target names EXACTLY one store", () => {
    expect(vWritebackListSubmissions([{ regionId: "r1" }])).toBe(true);
    expect(vWritebackListSubmissions([{ writebackId: "w1" }])).toBe(true);
    expect(vWritebackListSubmissions([{}])).toContain("exactly one");
    expect(vWritebackListSubmissions([{ regionId: "r1", writebackId: "w1" }])).toContain(
      "exactly one",
    );
    expect(vWritebackListSubmissions(["r1"])).toContain("must be an object");
  });

  it("vWritebackReview demands the fields each surface needs", () => {
    const region = {
      regionId: "r1",
      submitterId: "u1",
      cellRow: 2,
      cellCol: 3,
      newState: "approved",
    };
    expect(vWritebackReview([region])).toBe(true);
    expect(vWritebackReview([{ ...region, submissionId: "s1", reason: "ok" }])).toBe(true);
    expect(vWritebackReview([{ ...region, newState: "deleted" }])).toContain("newState");
    expect(vWritebackReview([{ ...region, submitterId: "" }])).toContain("submitterId");
    expect(vWritebackReview([{ ...region, cellRow: -1 }])).toContain("cellRow");
    // A model-column decision is addressed by submission id, not by cell.
    expect(
      vWritebackReview([{ writebackId: "w1", submissionId: "s1", newState: "rejected" }]),
    ).toBe(true);
    expect(vWritebackReview([{ writebackId: "w1", newState: "rejected" }])).toContain(
      "submissionId",
    );
  });
});

describe("bi.model gateway-extension validators", () => {
  it("vBiModelValidate accepts only the three validate actions", () => {
    expect(vBiModelValidate(["c1", "validateModel", {}])).toBe(true);
    expect(vBiModelValidate(["c1", "validateMeasure", { name: "Sales", formula: "SUM(x)" }])).toBe(
      true,
    );
    expect(vBiModelValidate(["c1", "info", {}])).toContain("action must be one of");
    expect(vBiModelValidate(["c1", "validateMeasure", {}])).toContain("payload.name");
    // Rust reads `expression` as a required String, so a missing one must fail
    // here rather than round-tripping into a field-decode error.
    expect(vBiModelValidate(["c1", "validateContext", { name: "R" }])).toContain(
      "payload.expression",
    );
    expect(
      vBiModelValidate(["c1", "validateContext", { name: "R", expression: "Region = \"EMEA\"" }]),
    ).toBe(true);
  });

  it("vBiModelLineage enforces the dependents node address", () => {
    expect(vBiModelLineage(["c1", "dependencyGraph", {}])).toBe(true);
    expect(vBiModelLineage(["c1", "measureLineage", { name: "Sales" }])).toBe(true);
    expect(vBiModelLineage(["c1", "measureLineage", {}])).toContain("payload.name");
    expect(vBiModelLineage(["c1", "dependents", { kind: "measure", name: "Sales" }])).toBe(true);
    // A column's node id is "<table>.<name>", so the table is not optional.
    expect(vBiModelLineage(["c1", "dependents", { kind: "calcColumn", name: "Margin" }])).toContain(
      "requires payload.table",
    );
    expect(
      vBiModelLineage(["c1", "dependents", { kind: "calcColumn", name: "Margin", table: "Sales" }]),
    ).toBe(true);
    expect(vBiModelLineage(["c1", "dependents", { kind: "securityRole", name: "x" }])).toContain(
      "kind must be one of",
    );
  });

  it("vBiModelBatch accepts only begin/end/cancel", () => {
    for (const a of ["batchBegin", "batchEnd", "batchCancel"]) {
      expect(vBiModelBatch(["c1", a])).toBe(true);
    }
    expect(vBiModelBatch(["c1", "batchCommit"])).toContain("action must be one of");
    expect(vBiModelBatch(["", "batchBegin"])).toContain("connectionId");
  });
});

// ============================================================================
// 4. THE DRAFT-CAPTURE BYPASS
// ============================================================================

const REGION: WritebackRegionEntry = {
  sheetId: "sheet-uuid-1",
  sheetIndex: 0,
  regionId: "region-1",
  rowStart: 5,
  rowEnd: 7,
  colStart: 2,
  colEnd: 4,
  valueType: "number",
};

describe("script grid writes into a .calp writeback region", () => {
  beforeEach(() => {
    invokeBackend.mockReset();
    __setWritebackIndexForTests(null);
  });

  it("costs nothing when the workbook has no writeback regions", async () => {
    __setWritebackIndexForTests([]);
    const writes = [{ sheetIndex: 0, row: 5, col: 2, value: "1" }];
    const split = await captureWritebackWrites("script:a", writes);
    expect(split.plain).toEqual(writes);
    expect(split.drafted).toEqual([]);
    expect(invokeBackend).not.toHaveBeenCalled();
  });

  it("leaves cells OUTSIDE every region alone", async () => {
    __setWritebackIndexForTests([REGION]);
    const outside = [
      { sheetIndex: 0, row: 4, col: 2, value: "a" }, // above
      { sheetIndex: 0, row: 6, col: 5, value: "b" }, // right
      { sheetIndex: 1, row: 6, col: 3, value: "c" }, // another sheet
    ];
    const split = await captureWritebackWrites("script:a", outside);
    expect(split.plain).toEqual(outside);
    expect(split.drafted).toEqual([]);
    expect(invokeBackend).not.toHaveBeenCalled();
  });

  it("routes a claimed cell through the authoritative draft gate", async () => {
    __setWritebackIndexForTests([REGION]);
    invokeBackend.mockResolvedValue({
      inRegion: true,
      regionId: "region-1",
      valueType: "number",
      draftSaved: true,
    });
    const write = { sheetIndex: 0, row: 6, col: 3, value: "42" };
    const split = await captureWritebackWrites("script:a", [write]);

    expect(invokeBackend).toHaveBeenCalledTimes(1);
    expect(invokeBackend).toHaveBeenCalledWith("script_writeback", {
      scriptId: "script:a",
      action: "cellGuard",
      // The region's own stable SheetId is passed EXPLICITLY: omitting it asks
      // Rust about the ACTIVE sheet, which is the wrong question for an
      // off-sheet write.
      payload: { row: 6, col: 3, value: "42", sheetId: "sheet-uuid-1" },
    });
    // Drafted cells still reach the grid (so the cell displays what was
    // drafted) — exactly what the interactive guard's action:"allow" does.
    expect(split.drafted).toEqual([write]);
    expect(split.plain).toEqual([]);
  });

  it("propagates a refusal verbatim and writes NOTHING", async () => {
    __setWritebackIndexForTests([REGION]);
    invokeBackend.mockRejectedValue(
      new Error("PermissionDenied: distribution.writeback not granted for this script"),
    );
    await expect(
      captureWritebackWrites("script:a", [{ sheetIndex: 0, row: 6, col: 3, value: "42" }]),
    ).rejects.toThrow("distribution.writeback not granted");
  });

  it("refuses to fall through when the gate declines without raising", async () => {
    // inRegion && !draftSaved is the exact shape of the bypass: a claimed cell
    // whose value was NOT drafted must never reach the grid.
    __setWritebackIndexForTests([REGION]);
    invokeBackend.mockResolvedValue({ inRegion: true, regionId: "region-1", draftSaved: false });
    await expect(
      captureWritebackWrite("script:a", { sheetIndex: 0, row: 6, col: 3, value: "42" }),
    ).rejects.toThrow(/caps\.writeback\.saveDraft/);
  });

  it("treats a stale index (region already gone) as a plain write", async () => {
    __setWritebackIndexForTests([REGION]);
    invokeBackend.mockResolvedValue({ inRegion: false, draftSaved: false });
    const write = { sheetIndex: 0, row: 6, col: 3, value: "42" };
    const split = await captureWritebackWrites("script:a", [write]);
    expect(split.plain).toEqual([write]);
    expect(split.drafted).toEqual([]);
  });

  it("splits a mixed batch so drafted cells are written one at a time", async () => {
    // update_cells_batch DROPS writeback cells outright, so the split is what
    // keeps the grid and the writeback layer showing the same thing.
    __setWritebackIndexForTests([REGION]);
    invokeBackend.mockResolvedValue({ inRegion: true, regionId: "region-1", draftSaved: true });
    const inside = { sheetIndex: 0, row: 5, col: 2, value: "1" };
    const outside = { sheetIndex: 0, row: 0, col: 0, value: "2" };
    const split = await captureWritebackWrites("script:a", [outside, inside]);
    expect(split.plain).toEqual([outside]);
    expect(split.drafted).toEqual([inside]);
    expect(invokeBackend).toHaveBeenCalledTimes(1);
  });

  it("uses the AUTHORITATIVE script id it was handed, never anything from args", async () => {
    __setWritebackIndexForTests([REGION]);
    invokeBackend.mockResolvedValue({ inRegion: true, draftSaved: true });
    await captureWritebackWrite("script:owner", { sheetIndex: 0, row: 6, col: 3, value: "x" });
    expect(invokeBackend.mock.calls[0][1].scriptId).toBe("script:owner");
  });
});

// ============================================================================
// 5. Drift guard: EVERY host write path goes through the gate
// ============================================================================

describe("no script write path skips the writeback gate", () => {
  const hostSrc = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");

  it("every lib write primitive sits behind a capture call", () => {
    // Each grid-write primitive must be preceded, WITHIN its own case label or
    // function, by a captureWritebackWrite(s) call. A new write path (a Wave B
    // bulk range write, a new aspect) that forgets the gate fails here.
    const primitives = /lib\.(?:updateCell|updateCellsBatch|updateCellOnSheets)\(/g;
    const scopeStart = /case\s+"[^"]+"\s*:|(?:async\s+)?function\s+\w+\s*\(/g;
    const scopes = [...hostSrc.matchAll(scopeStart)].map((m) => ({
      at: m.index as number,
      label: m[0],
    }));

    const unguarded: string[] = [];
    for (const m of hostSrc.matchAll(primitives)) {
      const at = m.index as number;
      let scope = scopes[0];
      for (const s of scopes) {
        if (s.at < at) scope = s;
        else break;
      }
      const body = hostSrc.slice(scope.at, at);
      if (!/captureWritebackWrite(s)?\(/.test(body)) {
        unguarded.push(`${scope.label.trim()} -> ${m[0]}`);
      }
    }
    expect(
      unguarded,
      `these grid writes bypass the .calp writeback draft gate:\n${unguarded.join("\n")}`,
    ).toEqual([]);
  });

  it("the four named entry points are guarded by name", () => {
    for (const marker of [
      'case "api.setCellValue"',
      'case "api.updateCellsBatch"',
      'case "sheet.setCellValue"',
      "async function writeCellsOnSheet",
      "async function writeCellOnSheet",
    ]) {
      expect(hostSrc, `${marker} missing`).toContain(marker);
    }
  });
});
