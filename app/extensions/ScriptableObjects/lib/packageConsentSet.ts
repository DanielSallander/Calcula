//! FILENAME: app/extensions/ScriptableObjects/lib/packageConsentSet.ts
// PURPOSE: WHICH ARTIFACTS one package-consent grant covers — the application's
//          object scripts AND the MODULE scripts (macros) it shipped.
// CONTEXT: A .calp application may ship macros (`core/calp/src/pull.rs`
//          materializes `modules/*.json` with `source_package` stamped), and the
//          subscribe review lists them as "Module scripts (N) — executable code"
//          before the user accepts. The grant recorder, however, wrote only the
//          package's OBJECT scripts into `.calcula/script-consent.json`, so at
//          run time `distributed_module_refusal`
//          (app/src-tauri/src/scripting/commands.rs) — which resolves the
//          macro's owning application by exact source, then asks
//          `consent_granted_in(file, package, script_id, source_hash)` — never
//          found the macro's id in the record and refused it. Forever: no
//          surface anywhere could add a module script to that record, so the
//          error ("you have not approved that package's code") named an approval
//          the user could not give. This module is what makes the recorded set
//          match the reviewed set.
//
// THE CAPABILITY LINE, AND WHY IT IS DRAWN HERE.
// A record carries two things: `scripts` (id + source hash) and
// `grantedCapabilities` (the union the consent prompt showed). Macros join the
// FIRST and deliberately not the second:
//
//   * Nothing grants a macro capabilities out of this record. Both macro run
//     routes derive the ceiling from the macro's OWN source at run time — the
//     object-script route passes `parseDeclaredCapabilities(source).caps` into
//     the mount (app/src/api/objectScriptRunner.ts), and the QuickJS module
//     route is gated server-side in Rust, which reads `grantedCapabilities`
//     nowhere. So excluding macro pragmas narrows a macro by nothing.
//   * Including them WOULD widen the object scripts: `grantedCapabilities` is
//     the application-level grant a reader trusts and the key
//     `isConsentCurrent` compares against the object scripts' declared union —
//     a macro pragma in there is a capability the prompt never attributed to the
//     realm that would inherit it, and the mismatched key would also re-prompt
//     the package on every single open.
//
// So: macros are held to the hash question, which is the whole question the
// backend asks about them, and the capability union stays exactly what the
// prompt enumerated.

import { listWorkbookScriptRecords } from "@api";
import { areScriptsConsented, isConsentCurrent } from "./consentStore";
import type { ConsentRecord } from "./consentStore";

/** Reserved-id prefix Rust hides from `list_scripts` and this module skips.
 *  Mirror of RESERVED_SCRIPT_PREFIX (app/src-tauri/src/scripting/commands.rs). */
const RESERVED_SCRIPT_PREFIX = "__calcula_";

/**
 * THE ONE NORMALIZATION, on the MODULE-STORE side, of an application name into
 * the key its consent record is written and read under. Returns `""` when the
 * name names no application. (The object-script side asks
 * `scriptOriginForMount` for the same answer — see `objectScriptPackageKey` in
 * this extension's index.ts — so neither side re-derives the other's.)
 *
 * IT PRESERVES THE NAME VERBATIM, and trims only to decide EMPTINESS. Both
 * backend gates compare the raw string:
 *
 *   * the module gate (`distributed_module_refusal`,
 *     app/src-tauri/src/scripting/commands.rs) asks
 *     `consent_granted_in(file, package, id, hash)` with the module record's
 *     `source_package` exactly as stored, and
 *   * the mount gate (`check_distributed_mount_consent`) is called with
 *     `scriptOriginForMount(definition).name` — the definition's `packageName`,
 *     also untouched.
 *
 * So a key that trimmed `"  Sales  "` down to `"Sales"` would write a record
 * neither gate can find, which is the failure mode this whole module exists to
 * close. A name that is blank or whitespace-only is a different matter: nothing
 * was stamped, so it names no application at all — the same reading
 * `scriptOriginForStoredRecord` (app/src/api/scriptHost/scriptOrigin.ts) takes.
 *
 * Every caller on this side — the grouping, the dialog payload, the freshness
 * check, the diff and `recordConsent` — goes through this one function. When the
 * load path grouped with the raw name while this module keyed by the trimmed
 * one, an application whose name carried whitespace was PROMPTED naming zero
 * macros while the recorder (which came through the trimming door) granted them:
 * consent covering artifacts the screen never showed.
 */
export function consentPackageKey(name: string | null | undefined): string {
  return typeof name === "string" && name.trim() !== "" ? name : "";
}

/** One module script (macro) that arrived inside a distributed application. */
export interface PackageMacro {
  id: string;
  name: string;
  source: string;
}

/** The minimum an artifact must present to be hashed into a consent record. */
export interface ConsentArtifact {
  id: string;
  source: string;
}

/**
 * The module scripts this workbook holds that arrived inside `packageName`.
 *
 * FOUR THINGS ARE DELIBERATELY EXCLUDED, each because approving it here would
 * grant something the consent prompt did not describe:
 *
 *   * a LOCAL module (no `sourcePackage`) — it needs no package approval at all,
 *     and `distributed_module_refusal` already lets a local source through;
 *   * another application's module;
 *   * a RESERVED `__calcula_`-prefixed record — the Custom Functions library and
 *     the shared-library store live there and are approved under their OWN
 *     namespaced keys (`custom-functions:<app>`, `lib:<app>`). Rust already
 *     hides them from `list_scripts`; this is the second lock, so a change to
 *     that filter cannot silently fold a UDF library into the bare-name record;
 *   * a record that FAILED TO LOAD — its source is unknown, and a consent entry
 *     is a hash of source. Hashing `""` would record an approval of code nobody
 *     read. It stays refused, which is visible at the moment of Run.
 *
 * Sorted by id so a record is byte-stable across grants.
 */
export async function listPackageMacros(packageName: string): Promise<PackageMacro[]> {
  const wanted = consentPackageKey(packageName);
  if (wanted === "") return [];
  return (await listMacrosByPackage()).get(wanted) ?? [];
}

/**
 * Every distributed module script in the workbook, grouped by the application it
 * arrived in — the same filtering as {@link listPackageMacros}, over ONE listing.
 *
 * `listWorkbookScriptRecords` fans out to one `get_script` per module, so asking
 * it once per package walks the whole store N times on a workbook that
 * subscribes to several applications. The load path groups instead.
 */
export async function listMacrosByPackage(): Promise<Map<string, PackageMacro[]>> {
  const records = await listWorkbookScriptRecords();
  const byPackage = new Map<string, PackageMacro[]>();
  for (const r of records) {
    if (r.loadError !== null) continue;
    if (r.id.startsWith(RESERVED_SCRIPT_PREFIX)) continue;
    const pkg = consentPackageKey(r.sourcePackage);
    if (pkg === "") continue;
    const list = byPackage.get(pkg) ?? [];
    list.push({ id: r.id, name: r.name, source: r.source });
    byPackage.set(pkg, list);
  }
  for (const list of byPackage.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return byPackage;
}

/**
 * What one package record CAN cover, and what it provably cannot.
 *
 * The two stores have separate id namespaces and nothing at publish or pull
 * enforces uniqueness across them, so a macro's id can equal an object script's.
 * One consent record is a flat list keyed by id, so that pair is ambiguous:
 * `record.scripts.find(s => s.id === ...)` would test the wrong entry. The
 * object script wins and the macro is DROPPED — the ambiguity resolves to a
 * refusal rather than to an approval nobody checked.
 *
 * The drop is only half a decision, though, and the other half is what this
 * type exists to carry. While `packageConsentArtifacts` dropped the macro and
 * the freshness check still DEMANDED its hash, the record could never satisfy
 * the check: the application re-prompted on every open and pressing Allow could
 * not make it stop. An unapprovable artifact has to be visible to BOTH — named
 * on the prompt as something this grant does not cover, and excluded from the
 * question the freshness check asks — or the user is handed a button that
 * cannot do what it says.
 */
export interface PackageConsentPlan {
  /** Exactly what goes into the record: object scripts first, then macros. */
  artifacts: ConsentArtifact[];
  /** The macros the record covers — `artifacts` minus the object scripts. */
  covered: PackageMacro[];
  /**
   * The macros this record CANNOT cover, because something already claimed
   * their id (an object script, or an earlier macro with the same id). They stay
   * refused by `distributed_module_refusal` at Run, and the prompt says so.
   */
  unapprovable: PackageMacro[];
}

/**
 * Split a package's artifacts into "what Allow will record" and "what Allow
 * cannot record", by the one rule a flat id-keyed record can enforce: first
 * claim on an id wins, and object scripts claim first.
 */
export function packageConsentPlan(
  objectScripts: Array<{ id: string; source: string }>,
  macros: PackageMacro[],
): PackageConsentPlan {
  const artifacts: ConsentArtifact[] = objectScripts.map((s) => ({
    id: s.id,
    source: s.source,
  }));
  const taken = new Set(artifacts.map((a) => a.id));
  const covered: PackageMacro[] = [];
  const unapprovable: PackageMacro[] = [];
  for (const macro of macros) {
    if (taken.has(macro.id)) {
      unapprovable.push(macro);
      continue;
    }
    taken.add(macro.id);
    covered.push(macro);
    artifacts.push({ id: macro.id, source: macro.source });
  }
  return { artifacts, covered, unapprovable };
}

/**
 * The artifact list ONE package record covers: the package's object scripts
 * first, then the macros {@link packageConsentPlan} could claim an id for.
 */
export function packageConsentArtifacts(
  objectScripts: Array<{ id: string; source: string }>,
  macros: PackageMacro[],
): ConsentArtifact[] {
  return packageConsentPlan(objectScripts, macros).artifacts;
}

/**
 * Whether the persisted record still covers EVERYTHING this package would run:
 * its object scripts at the full standard (hash + no capability expansion) and
 * its macros at the hash standard.
 *
 * A macro whose source changed upstream fails here exactly as a changed object
 * script does — which is the point of storing the hash rather than the name.
 *
 * IT ASKS ONLY ABOUT THE MACROS A RECORD CAN HOLD. This check and the recorder
 * must agree on the same set, and they did not: the recorder dropped an
 * id-colliding macro while this function still required its hash, so the record
 * the grant wrote could never satisfy the check that decides whether to prompt.
 * The application re-prompted on every open, and Allow — which writes that same
 * record again — could never end the loop. A prompt the user cannot satisfy is
 * worse than a refusal, because it never says what is wrong.
 */
export async function isPackageConsentCurrent(
  consents: ConsentRecord[],
  packageName: string,
  objectScripts: Array<{ id: string; source: string }>,
  macros: PackageMacro[],
): Promise<boolean> {
  if (!(await isConsentCurrent(consents, packageName, objectScripts))) return false;
  const { covered } = packageConsentPlan(objectScripts, macros);
  if (covered.length === 0) return true;
  return areScriptsConsented(consents, packageName, covered);
}
