//! FILENAME: app/src/api/scriptHost/__tests__/workbookFileLifecycle.test.ts
// PURPOSE: Guard the two halves of G1 — the workbook file lifecycle
//          (api.workbook.save / saveAs / isDirty / fileName) and the
//          picker-mediated `file.picker` capability — against the four ways
//          this feature could quietly become the thing it exists to replace:
//            1. a script save that a Before-Save handler cannot veto;
//            2. a picker cancellation that hangs, throws, or reads as success;
//            3. a path string travelling in either direction;
//            4. a capability that is declared, phrased and shimmed but not
//               actually grantable (the failure this program has shipped FOUR
//               times, always because one list was missed).
// CONTEXT: Deliberately layered against the REAL enforcing code: the broker for
//          denial, core/lib/file-api for the veto, the filesystem primitives for
//          cancellation, and the Rust source read from disk for the pragma
//          ceiling. Nothing here re-implements policy in order to assert it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as nodeFs from "fs";
import * as nodePath from "path";

import { ALL_CAPABILITY_IDS, CAPABILITY_ID_SET } from "../capabilityIds";
import { ALLOWLIST } from "../allowlist";
import { describeCapability, RUST_MIRRORED_CAPABILITIES, resetAllGrants } from "../capabilities";
import { EXTENSION_BROKER_METHODS } from "../extensionProtocol";
import { METHOD_DEADLINES_MS, UI_DIALOG_DEADLINE_MS } from "../protocol";
import {
  MAX_FILE_TEXT_CHARS,
  MAX_FILE_NAME,
  isSafeFileName,
  vFileExport,
  vFileImport,
  vNone,
} from "../validators";
import { brokerCall, BrokerError, buildHandleFromDefinition } from "../broker";
import {
  SCRIPT_SURFACES,
  auditScriptSurfaceCapabilities,
  brokerGatedCapabilities,
} from "../../scriptSurfaces";

const CAP = "file.picker";

const FILE_METHODS = ["cap.fileExportText", "cap.fileImportText"];
const WORKBOOK_METHODS = [
  "api.workbookSave",
  "api.workbookSaveAs",
  "api.workbookIsDirty",
  "api.workbookFileName",
];

// ============================================================================
// 1. The capability is threaded through EVERY consumer
// ============================================================================
//
// "Declared, phrased, shimmed — and silently ungrantable" is this program's
// signature defect. Each assertion below is one of the lists that has been
// missed before.

describe("file.picker is a fully threaded capability", () => {
  it("is in the one vocabulary", () => {
    expect(ALL_CAPABILITY_IDS).toContain(CAP);
    expect(CAPABILITY_ID_SET.has(CAP as never)).toBe(true);
  });

  it("has consent text that is a sentence, not the id", () => {
    const desc = describeCapability(CAP as never);
    expect(desc).not.toBe(CAP);
    expect(desc.length).toBeGreaterThan(40);
    // The bound is what makes this safe, so it must be IN the consent line —
    // "read and write files" alone would describe FileSystemObject.
    expect(desc.toLowerCase()).toContain("pick");
  });

  it("survives the RUST pragma parser, which is the ceiling for a local script", () => {
    // KNOWN_CAPABILITY_IDS in core/persistence is the authoritative R19 ceiling
    // for a locally authored script: an id missing there is STRIPPED at save, so
    // the script silently loses a capability it correctly declared. Read the
    // Rust source rather than trusting a comment.
    const rust = nodeFs.readFileSync(
      nodePath.resolve(__dirname, "../../../../../core/persistence/src/lib.rs"),
      "utf8",
    );
    const start = rust.indexOf("KNOWN_CAPABILITY_IDS");
    expect(start, "KNOWN_CAPABILITY_IDS not found in core/persistence/src/lib.rs").toBeGreaterThan(0);
    const open = rust.indexOf("[", rust.indexOf("=", start));
    const close = rust.indexOf("];", open);
    const listed = [...rust.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toContain(CAP);
    // ...and the whole vocabulary agrees, in order.
    expect(listed).toEqual([...ALL_CAPABILITY_IDS]);
  });

  it("is NOT mirrored to the Rust capability store, and says why", () => {
    // The read/write is performed by the trusted main thread through commands a
    // compromised renderer could already call; mirroring a grant to Rust would
    // buy nothing and would hard-error on a store that does not list the id.
    // The containment is that the WORKER has no Tauri and no path vocabulary.
    expect(RUST_MIRRORED_CAPABILITIES.has(CAP as never)).toBe(false);
  });

  it("is offered by the surface taxonomy wherever the broker can gate it", () => {
    expect(brokerGatedCapabilities()).toContain(CAP);
    for (const audit of auditScriptSurfaceCapabilities()) {
      expect(audit.understated, `${audit.surfaceId} understates its reach`).toEqual([]);
    }
    const objectScripts = SCRIPT_SURFACES.find((s) => s.id === "object-script");
    expect(objectScripts?.capabilities).toContain(CAP);
  });

  it("is reachable from a sandboxed extension too", () => {
    for (const m of FILE_METHODS) {
      expect(EXTENSION_BROKER_METHODS.has(m), `${m} not offered to sandboxed extensions`).toBe(true);
    }
    // ...but the unlocked-tier workbook rows are NOT, because an extension
    // mounts restricted and they would only fail closed.
    for (const m of WORKBOOK_METHODS) {
      expect(EXTENSION_BROKER_METHODS.has(m), `${m} should not be offered`).toBe(false);
    }
  });
});

// ============================================================================
// 2. Policy shape: tier, capability, class, deadline
// ============================================================================

describe("the G1 allowlist rows", () => {
  it("gate both file methods on file.picker at restricted tier", () => {
    for (const m of FILE_METHODS) {
      expect(ALLOWLIST[m], m).toBeDefined();
      expect(ALLOWLIST[m].capability, m).toBe(CAP);
      expect(ALLOWLIST[m].tier, m).toBe("restricted");
      expect(ALLOWLIST[m].class, m).toBe("file");
    }
  });

  it("put the workbook lifecycle at unlocked tier with NO capability", () => {
    for (const m of WORKBOOK_METHODS) {
      expect(ALLOWLIST[m], m).toBeDefined();
      expect(ALLOWLIST[m].tier, m).toBe("unlocked");
      // No capability, deliberately: this is reach over the document the script
      // already lives in and can already rewrite cell by cell.
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
      // Nothing crosses: save/saveAs/isDirty/fileName take no arguments at all,
      // which is what makes "a script cannot name a destination" structural.
      expect(ALLOWLIST[m].validate, m).toBe(vNone);
      expect(ALLOWLIST[m].validate(["C:/tmp/x.cala"]), m).not.toBe(true);
    }
  });

  it("gives every picker-opening method the person-length deadline", () => {
    for (const m of [...FILE_METHODS, "api.workbookSaveAs"]) {
      expect(METHOD_DEADLINES_MS[m], m).toBe(UI_DIALOG_DEADLINE_MS);
    }
  });

  it("never ships open / close / new — a script may persist the workbook, never replace it", () => {
    // Calcula holds ONE document: each of these would discard the user's
    // unsaved work, or hand a script the contents of a file whose picker click
    // meant "open this", not "let this script read it".
    for (const m of Object.keys(ALLOWLIST)) {
      expect(m).not.toMatch(/^api\.workbook(Open|Close|New)$/);
    }
  });
});

// ============================================================================
// 3. No path can travel from a script to the disk
// ============================================================================

describe("vFileExport refuses anything that is a path in disguise", () => {
  const ok = (name: string) => vFileExport([name, "x"]) === true;

  it("accepts a bare file name", () => {
    expect(ok("report.csv")).toBe(true);
    expect(ok("Q3 summary (final).txt")).toBe(true);
    expect(isSafeFileName("report.csv")).toBe(true);
  });

  it("rejects separators, drive letters, parents and streams", () => {
    for (const bad of [
      "..\\..\\Windows\\System32\\evil.bat",
      "../../etc/passwd",
      "C:\\Users\\me\\report.csv",
      "sub/dir/report.csv",
      "sub\\dir\\report.csv",
      "report.csv:hidden",
      "\\\\server\\share\\report.csv",
      "..",
      ".",
      "",
      "   ",
      "report.csv ",
      "report.",
      "bell\u0007.csv",
    ]) {
      expect(ok(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
      expect(isSafeFileName(bad), `isSafeFileName accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("bounds the name and the content", () => {
    expect(ok("a".repeat(MAX_FILE_NAME + 1))).toBe(false);
    expect(vFileExport(["a.csv", "x".repeat(MAX_FILE_TEXT_CHARS + 1)])).not.toBe(true);
    expect(vFileExport(["a.csv", "x".repeat(1000)])).toBe(true);
  });

  it("rejects options it does not know, and values it does", () => {
    expect(vFileExport(["a.csv", "x", { path: "C:/tmp" }])).not.toBe(true);
    expect(vFileExport(["a.csv", "x", { defaultPath: "C:/tmp" }])).not.toBe(true);
    expect(vFileExport(["a.csv", "x", { encoding: "utf-16" }])).not.toBe(true);
    expect(vFileExport(["a.csv", "x", { mimeType: "../../etc" }])).not.toBe(true);
    expect(vFileExport(["a.csv", "x", { mimeType: "text/csv", encoding: "utf-8-bom" }])).toBe(true);
  });

  it("refuses a non-string content instead of stringifying it", () => {
    expect(vFileExport(["a.csv", 42])).not.toBe(true);
    expect(vFileExport(["a.csv", null])).not.toBe(true);
  });
});

describe("vFileImport only shapes the picker's filter", () => {
  it("accepts nothing, or a small list of bare extensions", () => {
    expect(vFileImport([])).toBe(true);
    expect(vFileImport([undefined])).toBe(true);
    expect(vFileImport([{ extensions: ["csv", "txt"] }])).toBe(true);
  });

  it("rejects dots, wildcards, paths and oversized lists", () => {
    expect(vFileImport([{ extensions: [".csv"] }])).not.toBe(true);
    expect(vFileImport([{ extensions: ["*"] }])).not.toBe(true);
    expect(vFileImport([{ extensions: ["../x"] }])).not.toBe(true);
    expect(vFileImport([{ extensions: [] }])).not.toBe(true);
    expect(vFileImport([{ extensions: new Array(17).fill("csv") }])).not.toBe(true);
    expect(vFileImport([{ path: "C:/tmp" }])).not.toBe(true);
  });
});

// ============================================================================
// 4. Without a grant, the broker denies — before any picker can appear
// ============================================================================

function handle(opts: { declared: string[]; tier?: "restricted" | "unlocked" }) {
  return buildHandleFromDefinition({
    id: "g1-script",
    name: "G1 test script",
    objectType: "workbook",
    instanceId: null,
    accessLevel: opts.tier ?? "restricted",
    declaredCapabilities: opts.declared,
  });
}

describe("the broker denies file access without a grant", () => {
  beforeEach(() => {
    resetAllGrants();
  });

  it("denies with PermissionDenied when the script never DECLARED file.picker", async () => {
    const h = handle({ declared: [] });
    const executor = vi.fn();
    for (const m of FILE_METHODS) {
      await expect(
        brokerCall(h, m, m === "cap.fileExportText" ? ["a.csv", "x"] : [undefined], executor as never),
      ).rejects.toMatchObject({ code: "PermissionDenied", capability: CAP });
    }
    // The executor is what opens the picker. It must never have been reached.
    expect(executor).not.toHaveBeenCalled();
  });

  it("denies with CapabilityRequired when declared but not granted", async () => {
    const h = handle({ declared: [CAP] });
    const executor = vi.fn();
    await expect(
      brokerCall(h, "cap.fileExportText", ["a.csv", "x"], executor as never),
    ).rejects.toMatchObject({ code: "CapabilityRequired", capability: CAP });
    expect(executor).not.toHaveBeenCalled();
  });

  it("validates the arguments BEFORE the capability check, so no picker opens for junk", async () => {
    const h = handle({ declared: [CAP] });
    const executor = vi.fn();
    await expect(
      brokerCall(h, "cap.fileExportText", ["../../evil.bat", "x"], executor as never),
    ).rejects.toMatchObject({ code: "ValidationError" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("keeps the workbook lifecycle out of reach of a restricted script", async () => {
    const h = handle({ declared: [] });
    const executor = vi.fn();
    for (const m of WORKBOOK_METHODS) {
      await expect(brokerCall(h, m, [], executor as never)).rejects.toMatchObject({
        code: "PermissionDenied",
      });
    }
    expect(executor).not.toHaveBeenCalled();
  });
});
