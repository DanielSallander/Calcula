//! FILENAME: app/extensions/ScriptableObjects/__tests__/packageMacroConsent.test.ts
// PURPOSE: An application's MACROS must be covered by the same one grant its
//          object scripts are — and by nothing more.
// CONTEXT: A .calp may ship module scripts (macros). `core/calp/src/pull.rs`
//          materializes them with `source_package` stamped, and the subscribe
//          review lists them as "Module scripts (N) — executable code" before
//          the user accepts. But the grant recorder wrote ONLY the package's
//          object scripts into `.calcula/script-consent.json`, and the Rust
//          module gate (`distributed_module_refusal`,
//          app/src-tauri/src/scripting/commands.rs) resolves the macro's owning
//          application and then asks that very record for it by id + source
//          hash. It was never there. Every distributed macro was refused
//          forever, with an error naming an approval no surface in the app could
//          give: the other three consent writers all key on a DIFFERENT,
//          namespaced key ("custom-functions:", "lib:", "chart-marks:"), so none
//          of them could ever satisfy the bare-name lookup this gate performs.
//
// THE STORE IS REAL HERE. `@api/distributedConsent` runs over an in-memory
// virtual filesystem (the same technique as
// src/api/__tests__/customFunctionConsent.test.ts), so the hashing, the
// source-change re-prompt and the capability-expansion re-prompt are exercised
// rather than stubbed — and the record this suite asserts on is the byte-level
// JSON Rust reads.

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The consent store's only backend touch.
const files = new Map<string, string>();
vi.mock("@api/backend", () => ({
  readVirtualFile: async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw new Error("not found");
    return v;
  },
  createVirtualFile: async (p: string, content: string) => {
    files.set(p, content);
  },
}));

/** The workbook's module-script store, as `listWorkbookScriptRecords` sees it. */
interface FakeRecord {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
  loadError: string | null;
}
let moduleRecords: FakeRecord[] = [];
let listThrows: Error | null = null;

vi.mock("@api", () => ({
  listWorkbookScriptRecords: async () => {
    if (listThrows) throw listThrows;
    return moduleRecords;
  },
}));

import { recordConsent, loadConsents, sha256Hex } from "@api/distributedConsent";
import type { CapabilityGrant } from "@api/distributedConsent";
import {
  isPackageConsentCurrent,
  listMacrosByPackage,
  listPackageMacros,
  packageConsentArtifacts,
  packageConsentPlan,
} from "../lib/packageConsentSet";

const CONSENT_FILE = ".calcula/script-consent.json";
const PKG = "Quarterly Reports";

/** An object script exactly as ObjectScriptManager hands it to the recorder. */
const objectScript = { id: "obj-refresh", name: "Refresh", source: "// @capability storage\nreturn 1;" };
const OBJECT_GRANTS: CapabilityGrant[] = [{ capability: "storage" }];

const macroRecord = (over: Partial<FakeRecord> = {}): FakeRecord => ({
  id: "macro-month-end",
  name: "Month end",
  description: "Recorded macro · runtime=notebook · 3 actions",
  source: "Calcula.setCellValue('A1', 1);",
  sourcePackage: PKG,
  loadError: null,
  ...over,
});

/**
 * `consent_granted_in` (app/src-tauri/src/calp_commands.rs), reimplemented over
 * the SAME JSON Rust parses: a record under this package key that names this
 * artifact id with this exact source hash. The point of asserting through this
 * shape rather than through the TypeScript helpers is that the backend is the
 * thing that was refusing, and it reads the file, not our types.
 */
async function consentGrantedIn(
  packageKey: string,
  scriptId: string,
  source: string,
): Promise<boolean> {
  const raw = files.get(CONSENT_FILE);
  if (raw === undefined) return false;
  const parsed = JSON.parse(raw) as {
    consents?: Array<{ packageName?: string; scripts?: Array<{ id?: string; sourceHash?: string }> }>;
  };
  const hash = await sha256Hex(source);
  return (parsed.consents ?? []).some(
    (r) =>
      r.packageName === packageKey &&
      (r.scripts ?? []).some((s) => s.id === scriptId && s.sourceHash === hash),
  );
}

/** The grant, exactly as the ScriptableObjects consent-granted handler writes it. */
async function grantPackage(
  objectScripts: Array<{ id: string; source: string }>,
  granted: CapabilityGrant[],
): Promise<void> {
  const macros = await listPackageMacros(PKG);
  await recordConsent(PKG, packageConsentArtifacts(objectScripts, macros), granted);
}

beforeEach(() => {
  files.clear();
  moduleRecords = [];
  listThrows = null;
});

describe("one grant covers an application's object scripts AND its macros", () => {
  it("approves both, and stores the macro's OWN source hash", async () => {
    moduleRecords = [macroRecord()];

    await grantPackage([objectScript], OBJECT_GRANTS);

    // The object script, as before.
    expect(await consentGrantedIn(PKG, objectScript.id, objectScript.source)).toBe(true);
    // The macro — this is the id + hash pair `distributed_module_refusal` looks
    // for, and its absence is the whole defect.
    expect(
      await consentGrantedIn(PKG, "macro-month-end", "Calcula.setCellValue('A1', 1);"),
      "the macro must be in the record under its own id and its own source hash",
    ).toBe(true);

    // ...and the next open does not re-prompt for either.
    const consents = await loadConsents();
    expect(
      await isPackageConsentCurrent(consents, PKG, [objectScript], await listPackageMacros(PKG)),
    ).toBe(true);
  });

  it("stores the macro's hash, not the object script's", async () => {
    moduleRecords = [macroRecord()];
    await grantPackage([objectScript], OBJECT_GRANTS);

    const record = (await loadConsents()).find((c) => c.packageName === PKG)!;
    const macro = record.scripts.find((s) => s.id === "macro-month-end")!;
    expect(macro.sourceHash).toBe(await sha256Hex("Calcula.setCellValue('A1', 1);"));
    expect(macro.sourceHash).not.toBe(await sha256Hex(objectScript.source));
  });

  it("re-prompts when the macro's source changed upstream", async () => {
    moduleRecords = [macroRecord()];
    await grantPackage([objectScript], OBJECT_GRANTS);

    // A refresh brings a different body under the same id.
    moduleRecords = [macroRecord({ source: "Calcula.setCellValue('A1', 999);" })];

    const consents = await loadConsents();
    expect(
      await isPackageConsentCurrent(consents, PKG, [objectScript], await listPackageMacros(PKG)),
      "a changed macro must re-prompt exactly as a changed object script does",
    ).toBe(false);
    // And the backend refuses it in the same breath: the new source hashes to
    // something the record does not carry.
    expect(await consentGrantedIn(PKG, "macro-month-end", "Calcula.setCellValue('A1', 999);")).toBe(
      false,
    );
  });

  it("re-prompts when a NEW macro arrives in a refresh", async () => {
    moduleRecords = [macroRecord()];
    await grantPackage([objectScript], OBJECT_GRANTS);

    moduleRecords = [macroRecord(), macroRecord({ id: "macro-new", name: "New", source: "1;" })];
    const consents = await loadConsents();
    expect(
      await isPackageConsentCurrent(consents, PKG, [objectScript], await listPackageMacros(PKG)),
    ).toBe(false);
  });
});

describe("the grant is not widened past what the prompt showed", () => {
  it("a macro's declared capability never enters the package's granted set", async () => {
    moduleRecords = [
      macroRecord({ source: "// @capability net.fetch https://evil.example.com\nreturn 1;" }),
    ];

    await grantPackage([objectScript], OBJECT_GRANTS);

    const record = (await loadConsents()).find((c) => c.packageName === PKG)!;
    expect(record.grantedCapabilities.map((g) => g.capability)).toEqual(["storage"]);
    expect(record.grantedCapabilities.map((g) => g.capability)).not.toContain("net.fetch");
  });

  it("...and the package still does not re-prompt because of it", async () => {
    // The trap this guards: fold macro pragmas into `grantedCapabilities` and
    // `isConsentCurrent` compares that union against the OBJECT scripts' own
    // declared set, which no longer matches — the application re-prompts on
    // every open, forever, and the user can never make it stop.
    moduleRecords = [
      macroRecord({ source: "// @capability net.fetch https://evil.example.com\nreturn 1;" }),
    ];
    await grantPackage([objectScript], OBJECT_GRANTS);

    const consents = await loadConsents();
    expect(
      await isPackageConsentCurrent(consents, PKG, [objectScript], await listPackageMacros(PKG)),
    ).toBe(true);
  });
});

describe("what a package grant must NOT reach", () => {
  it("a local macro is never in the record and needs no approval", async () => {
    moduleRecords = [
      macroRecord(),
      macroRecord({ id: "macro-mine", name: "Mine", source: "2;", sourcePackage: null }),
    ];

    expect((await listPackageMacros(PKG)).map((m) => m.id)).toEqual(["macro-month-end"]);
    await grantPackage([objectScript], OBJECT_GRANTS);
    expect(await consentGrantedIn(PKG, "macro-mine", "2;")).toBe(false);
  });

  it("another application's macro is not swept into this grant", async () => {
    moduleRecords = [macroRecord(), macroRecord({ id: "macro-theirs", sourcePackage: "Other App" })];
    expect((await listPackageMacros(PKG)).map((m) => m.id)).toEqual(["macro-month-end"]);
  });

  it("the grouped listing keeps each application's macros to itself, sorted", async () => {
    // The load path groups ONCE and hands each package its own list; a
    // mis-grouping here would put one publisher's macro into another's grant.
    moduleRecords = [
      macroRecord({ id: "macro-z" }),
      macroRecord({ id: "macro-a" }),
      macroRecord({ id: "macro-theirs", sourcePackage: "Other App" }),
      macroRecord({ id: "macro-mine", sourcePackage: null }),
      macroRecord({ id: "__calcula_custom_functions__" }),
    ];
    const grouped = await listMacrosByPackage();
    expect([...grouped.keys()].sort()).toEqual(["Other App", PKG]);
    expect(grouped.get(PKG)!.map((m) => m.id)).toEqual(["macro-a", "macro-z"]);
    expect(grouped.get("Other App")!.map((m) => m.id)).toEqual(["macro-theirs"]);
  });

  it("a reserved __calcula_ record stays out (it is approved under its own key)", async () => {
    // The Custom Functions library and the shared-library store live under
    // reserved ids and are consented as "custom-functions:<app>" / "lib:<app>".
    // Folding one into the bare-name record would approve a UDF library the
    // object-script prompt never mentioned.
    moduleRecords = [
      macroRecord(),
      macroRecord({ id: "__calcula_custom_functions__", name: "UDFs", source: "{}" }),
    ];
    expect((await listPackageMacros(PKG)).map((m) => m.id)).toEqual(["macro-month-end"]);
  });

  it("an unreadable record is not consented on a guessed hash", async () => {
    moduleRecords = [macroRecord({ source: "", loadError: "read failed" })];
    expect(await listPackageMacros(PKG)).toEqual([]);
  });

  it("an id that collides with an object script resolves to a refusal, not an approval", async () => {
    moduleRecords = [macroRecord({ id: objectScript.id, source: "different body;" })];
    const artifacts = packageConsentArtifacts([objectScript], await listPackageMacros(PKG));
    expect(artifacts).toEqual([{ id: objectScript.id, source: objectScript.source }]);
  });

  it("...and the DROP is reported, so nothing can go on demanding the dropped hash", async () => {
    // The drop used to be silent. `isPackageConsentCurrent` still required the
    // colliding macro's hash, which the record it had just written could never
    // carry — so the application re-prompted on every open and Allow could not
    // end the loop. The plan is the one place both sides read.
    moduleRecords = [macroRecord({ id: objectScript.id, source: "different body;" })];
    const plan = packageConsentPlan([objectScript], await listPackageMacros(PKG));
    expect(plan.covered).toEqual([]);
    expect(plan.unapprovable.map((m) => m.id)).toEqual([objectScript.id]);
  });
});

describe("the listing's failure does not silently lose the object-script grant", () => {
  it("records the object scripts even when the module store cannot be listed", async () => {
    listThrows = new Error("backend down");
    // The handler swallows the listing failure and records what it can prove.
    let macros: Awaited<ReturnType<typeof listPackageMacros>> = [];
    try {
      macros = await listPackageMacros(PKG);
    } catch {
      macros = [];
    }
    await recordConsent(PKG, packageConsentArtifacts([objectScript], macros), OBJECT_GRANTS);
    expect(await consentGrantedIn(PKG, objectScript.id, objectScript.source)).toBe(true);
  });
});

// ===========================================================================
// The wiring, pinned at the source
// ===========================================================================
//
// The suite above drives the same calls the extension makes; these assert that
// the extension really makes them. Without this a correct helper could sit
// beside a recorder that still writes only object scripts — which is exactly
// the state this fix found the code in.

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

describe("the extension wires the macros into the grant it writes", () => {
  const EXT = read("extensions/ScriptableObjects/index.ts");

  it("the grant recorder writes the artifact list THE PROMPT enumerated", () => {
    // It used to re-derive the set from a second, independent listing, so a
    // workbook that changed while the prompt was open was granted under the old
    // screen's authority. The record now comes from the held prompt.
    expect(EXT).toContain("await recordConsent(packageName, pending.artifacts, pending.granted);");
    // ...and the artifact list itself is still built by the one helper, from the
    // application's object scripts AND its macros.
    expect(EXT).toContain("packageConsentPlan(pkgScripts, pkgMacros)");
  });

  it("the capability union is still computed over the OBJECT scripts alone", () => {
    expect(EXT).toContain("computePackageCapabilities(pkgScripts)");
    expect(EXT).not.toContain("computePackageCapabilities([...pkgScripts");
    expect(EXT).not.toContain("computePackageCapabilities(pkgMacros");
  });

  it("the freshness check covers the macros too", () => {
    expect(EXT).toContain("isPackageConsentCurrent(persistedConsents, pkg, pkgScripts, pkgMacros)");
    // Grouped once for the whole load, not re-listed per package: the listing
    // fans out to one `get_script` per module.
    expect(EXT).toContain("await listMacrosByPackage()");
  });

  it("WRITES THE RECORD BEFORE IT MOUNTS — the mount gate reads that record", () => {
    // The mount boundary asks the backend whether this workbook approved the
    // application, and the backend answers from the consent store. A handler
    // that mounts first is asking about an approval it has not written yet, so
    // every mount is refused, each refusal is swallowed as a per-script error,
    // and the user is told the scripts are enabled while nothing runs until the
    // workbook is reopened. Order, not just presence, is the invariant.
    const handler = EXT.slice(EXT.indexOf('onAppEvent("scriptable-objects:consent-granted"'));
    const body = handler.slice(0, handler.indexOf("consent-denied"));
    const recordAt = body.indexOf("await recordConsent(");
    const mountAt = body.indexOf("await ObjectScriptManager.mountScript(");
    expect(recordAt).toBeGreaterThan(-1);
    expect(mountAt).toBeGreaterThan(-1);
    expect(recordAt).toBeLessThan(mountAt);
  });

  it("does not announce success for mounts that failed", () => {
    const handler = EXT.slice(EXT.indexOf('onAppEvent("scriptable-objects:consent-granted"'));
    const body = handler.slice(0, handler.indexOf("consent-denied"));
    expect(body).toContain("failedToMount");
    expect(body).toContain("did not start");
  });

  it("the prompt names the macros the grant will cover", () => {
    expect(EXT).toContain("moduleScriptNames: approvableMacros.map((m) => m.name)");
    const dialog = read("extensions/ScriptableObjects/components/ScriptConsentDialog.tsx");
    expect(dialog).toContain("data?.moduleScriptNames");
    expect(dialog).toContain("moduleScriptNames.map");
  });
});
