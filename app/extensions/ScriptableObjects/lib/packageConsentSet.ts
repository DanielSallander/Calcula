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
//
// BUTTON ACTIONS JOIN THE SAME RECORD (M6, phase 4 of BUG-0257). An
// application's held inline button code is approved by the hash of its exact
// bytes, as `buttonAction:<sha256>` in this same bare record -- the one the Rust
// button door asks (`application_code_gate::button_run_gate`). Like macros they
// are held to the hash question alone and add nothing to the capability union.
// The `buttonAction:` id space belongs to them: an object script or macro whose
// id starts with it is UNAPPROVABLE here (Rust refuses such an id at pull, and
// its record writer refuses a `buttonAction:` id that does not name the sha256 of
// the source beside it -- so letting one into the record would make Allow fail
// for the whole application).

//
// COMMAND BUTTONS GET THEIR OWN RECORD (plan_M8 S3, BUG-0257 phase 5). A button
// cell that came with an application may run a Calcula command on Rust's list
// once approved under `button-commands:<application>` -- the key Rust's command
// gate asks, never the bare record: `recordConsent` replaces a key's WHOLE
// record (so the two approvals would erase each other), and the bare key is the
// object-script mount floor's, which admits a mount on any non-empty record
// under it. The artifact of a command is its id, hashed as its own bytes
// ({id: commandId, source: commandId}), which is exactly what Rust asks for.
// Only a command a click could run is approvable -- its LIVE registration opts
// in and is not shadowed (`judgeApplicationCommand`, the click's own rule) --
// and any other is named on the screen as one that will not run.

import { listDistributedWorkbookScriptRecords } from "@api";
import { ExtensionRegistry } from "@api/extensions";
import {
  BUTTON_ACTION_CONSENT_PREFIX,
  buttonCommandConsentKey,
  describeApplicationCommandRefusal,
  judgeApplicationCommand,
  listApplicationCellCommands,
  type ApplicationCellCommand,
  type HeldButtonAction,
} from "@api/heldButtonCode";
import { areScriptsConsented, isConsentCurrent } from "./consentStore";
import type { ConsentRecord } from "./consentStore";
import type { ConsentMacroButton } from "./consentMacroButtons";

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
 * close.
 *
 * A BLANK OR WHITESPACE-ONLY STAMP IS EXCLUDED, AND DELIBERATELY NOT MAPPED TO
 * THE PLACEHOLDER. `scriptOriginForStoredRecord` reads such a stamp as a
 * package with the placeholder name (Rust holds any `Some(..)` stamp to be a
 * publisher's), so the TIER of a module stamped `"   "` is restricted — that
 * part is settled there. But the module gate asks `consent_granted_in` with the
 * RAW stamp, `"   "`, and nothing this side can write under `"   "`: a record
 * under the placeholder would never satisfy it, so listing the macro on a
 * prompt as something Allow covers would promise a run Rust still refuses. It
 * is left out of the grant instead, and stays refused at Run — fail closed,
 * and said out loud there rather than lied about here.
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
  /**
   * The module's description, which carries the Macro Recorder's runtime
   * marker (`runtime=objectScript`): the button door refuses a held `Name()` of
   * an object-script macro by name, and the screen says so up front. Never part
   * of what is recorded.
   */
  description?: string | null;
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
 * THROUGH THE DISTRIBUTED-ONLY DOOR. This runs on every workbook open and every
 * `.calp` update, and it needs source ONLY for the records it will hash into a
 * consent entry — the distributed ones. `listWorkbookScriptRecords` fetched
 * every module's body, the user's own recorded macros included, and threw the
 * local ones away below; `listDistributedWorkbookScriptRecords` decides which
 * rows are distributed from the summary (the row already carries
 * `sourcePackage`) and fetches those alone. Asking once per package would still
 * walk the store N times on a workbook that subscribes to several
 * applications, so the load path groups from this one listing.
 */
export async function listMacrosByPackage(): Promise<Map<string, PackageMacro[]>> {
  const records = await listDistributedWorkbookScriptRecords();
  const byPackage = new Map<string, PackageMacro[]>();
  for (const r of records) {
    if (r.loadError !== null) continue;
    if (r.id.startsWith(RESERVED_SCRIPT_PREFIX)) continue;
    const pkg = consentPackageKey(r.sourcePackage);
    if (pkg === "") continue;
    const list = byPackage.get(pkg) ?? [];
    list.push({ id: r.id, name: r.name, source: r.source, description: r.description ?? null });
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
export interface PackageConsentPlan<S extends ConsentArtifact = ConsentArtifact> {
  /**
   * Exactly what goes into the record: object scripts first, then macros, then
   * button actions.
   */
  artifacts: ConsentArtifact[];
  /** The object scripts the record covers (every one whose id is not reserved). */
  objectScripts: S[];
  /** The macros the record covers. */
  covered: PackageMacro[];
  /**
   * The macros this record CANNOT cover, because something already claimed
   * their id (an object script, or an earlier macro with the same id). They stay
   * refused by `distributed_module_refusal` at Run, and the prompt says so.
   */
  unapprovable: PackageMacro[];
  /**
   * Object scripts and macros whose id starts with `buttonAction:` -- the id
   * space of button actions. None can be approved: Rust refuses such an id at
   * pull and at mount, and refuses to RECORD one whose id is not the hash of
   * its source. They stay refused, and the prompt names them.
   */
  reserved: Array<{ id: string; name: string }>;
  /** The button actions the record covers: all of them (their ids are content hashes). */
  buttonActions: HeldButtonAction[];
}

/** True for an id in the button-action namespace, which only a button action may use. */
export function isReservedButtonActionId(id: string): boolean {
  return id.startsWith(BUTTON_ACTION_CONSENT_PREFIX);
}

/**
 * Split a package's artifacts into "what Allow will record" and "what Allow
 * cannot record", by the one rule a flat id-keyed record can enforce: first
 * claim on an id wins, object scripts claim first, then macros, and the
 * `buttonAction:` namespace belongs to button actions alone.
 *
 * Button actions are listed by the hash of their exact bytes, so two never
 * share an id and nothing else may claim one: every one is covered.
 */
export function packageConsentPlan<S extends ConsentArtifact & { name?: string }>(
  objectScripts: S[],
  macros: PackageMacro[],
  buttonActions: readonly HeldButtonAction[],
): PackageConsentPlan<S> {
  const reserved: Array<{ id: string; name: string }> = [];
  const approvableScripts: S[] = [];
  for (const script of objectScripts) {
    if (isReservedButtonActionId(script.id)) {
      reserved.push({ id: script.id, name: script.name ?? script.id });
    } else {
      approvableScripts.push(script);
    }
  }
  const artifacts: ConsentArtifact[] = approvableScripts.map((s) => ({
    id: s.id,
    source: s.source,
  }));
  const taken = new Set(artifacts.map((a) => a.id));
  const covered: PackageMacro[] = [];
  const unapprovable: PackageMacro[] = [];
  for (const macro of macros) {
    if (isReservedButtonActionId(macro.id)) {
      reserved.push({ id: macro.id, name: macro.name });
      continue;
    }
    if (taken.has(macro.id)) {
      unapprovable.push(macro);
      continue;
    }
    taken.add(macro.id);
    covered.push(macro);
    artifacts.push({ id: macro.id, source: macro.source });
  }
  const coveredActions: HeldButtonAction[] = [];
  for (const action of buttonActions) {
    // The listing groups by hash, so an id repeats only if a caller merged two
    // listings; the first claim wins, exactly as for macros.
    if (taken.has(action.id)) continue;
    taken.add(action.id);
    coveredActions.push(action);
    artifacts.push({ id: action.id, source: action.source });
  }
  return {
    artifacts,
    objectScripts: approvableScripts,
    covered,
    unapprovable,
    reserved,
    buttonActions: coveredActions,
  };
}

/**
 * The artifact list ONE package record covers: the package's object scripts
 * first, then the macros {@link packageConsentPlan} could claim an id for, then
 * its button actions.
 */
export function packageConsentArtifacts(
  objectScripts: Array<{ id: string; source: string }>,
  macros: PackageMacro[],
  buttonActions: readonly HeldButtonAction[],
): ConsentArtifact[] {
  return packageConsentPlan(objectScripts, macros, buttonActions).artifacts;
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
 *
 * BUTTON ACTIONS TOO (M6). Every held inline button action the door could run
 * must be in the record by its id and the hash of its exact bytes -- otherwise
 * an application whose only new code is a button's would hydrate as current,
 * never prompt, and be refused at every click. A reserved-id object script is
 * not demanded: no record can hold it.
 *
 * COMMAND BUTTONS UNDER THEIR OWN KEY (plan_M8 S3). The BARE record is asked
 * only when the application has something that lives under it -- object
 * scripts, macros or button actions: `isConsentCurrent` is false when no record
 * exists, so an application whose only code is command buttons would otherwise
 * be asked again forever (Allow writes no bare record for it). Every command a
 * click could run must then ALSO be in `button-commands:<application>` at the
 * hash of its id; one that never runs is not demanded (nothing records it).
 */
export async function isPackageConsentCurrent(
  consents: ConsentRecord[],
  packageName: string,
  objectScripts: Array<{ id: string; source: string }>,
  macros: PackageMacro[],
  buttonActions: readonly HeldButtonAction[],
  commands: readonly PackageCommand[] = [],
): Promise<boolean> {
  if (objectScripts.length > 0 || macros.length > 0 || buttonActions.length > 0) {
    const plan = packageConsentPlan(objectScripts, macros, buttonActions);
    if (!(await isConsentCurrent(consents, packageName, plan.objectScripts))) return false;
    const demanded: ConsentArtifact[] = [
      ...plan.covered,
      ...plan.buttonActions.map((a) => ({ id: a.id, source: a.source })),
    ];
    if (demanded.length > 0 && !(await areScriptsConsented(consents, packageName, demanded))) return false;
  }
  const commandArtifacts = commandConsentArtifacts(commands);
  if (commandArtifacts.length === 0) return true;
  return areScriptsConsented(consents, buttonCommandConsentKey(packageName), commandArtifacts);
}

// ============================================================================
// Command buttons (plan_M8 S3)
// ============================================================================

/**
 * One Calcula command an application's button cells run, as the approval
 * screen lists it: its id, its name as the LIVE registration gives it, and
 * every button of THAT application that runs it (in the macro-button wording).
 */
export interface PackageCommand {
  commandId: string;
  /** The live registration's name; the id when nothing usable is registered. */
  commandName: string;
  /** The application's buttons that run it, in sheet/row/col order. */
  buttons: ConsentMacroButton[];
  /**
   * Null when a click can run it once it is approved; otherwise WHY no click
   * ever runs it (the page's rule, `judgeApplicationCommand`) -- such a command
   * is named on the screen and never recorded.
   */
  wontRunBecause: string | null;
}

/** The registry as the grouping reads it (the real @api facade in production). */
export interface CommandRegistryView {
  getCommand(commandId: string): { name?: string; distributableTrigger?: unknown } | undefined;
  isCommandShadowed(commandId: string): boolean;
}

/**
 * Group an application's command buttons by the application whose approval
 * they need -- its stamp, through {@link consentPackageKey} like the macros, so
 * one application's macros, button actions and commands are one screen -- and
 * then by command id, each judged ONCE against its live registration. Sorted
 * by command id; each command's buttons by sheet/row/col.
 */
export function groupApplicationCommands(
  entries: readonly ApplicationCellCommand[],
  registry: CommandRegistryView = ExtensionRegistry,
): Map<string, PackageCommand[]> {
  const byPackage = new Map<string, Map<string, { command: PackageCommand; order: ApplicationCellCommand[] }>>();
  for (const entry of entries) {
    const pkg = consentPackageKey(entry.application);
    if (pkg === "") continue;
    const byId = byPackage.get(pkg) ?? new Map<string, { command: PackageCommand; order: ApplicationCellCommand[] }>();
    byPackage.set(pkg, byId);
    let slot = byId.get(entry.commandId);
    if (!slot) {
      const live = registry.getCommand(entry.commandId);
      const refusal = judgeApplicationCommand(live, registry.isCommandShadowed(entry.commandId));
      slot = {
        command: {
          commandId: entry.commandId,
          commandName: typeof live?.name === "string" && live.name !== "" ? live.name : entry.commandId,
          buttons: [],
          wontRunBecause: refusal === null ? null : describeApplicationCommandRefusal(refusal),
        },
        order: [],
      };
      byId.set(entry.commandId, slot);
    }
    slot.order.push(entry);
  }
  const out = new Map<string, PackageCommand[]>();
  for (const [pkg, byId] of byPackage) {
    const commands: PackageCommand[] = [];
    for (const { command, order } of byId.values()) {
      order.sort((a, b) => a.sheetIndex - b.sheetIndex || a.row - b.row || a.col - b.col);
      command.buttons = order.map((e) => ({ cell: e.cell, caption: e.caption, kind: "cell" as const }));
      commands.push(command);
    }
    commands.sort((a, b) => (a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0));
    out.set(pkg, commands);
  }
  return out;
}

/**
 * Every application's command buttons, from ONE walk of the workbook's button
 * cells. Rejects when the workbook cannot be listed: a caller decides whether
 * that degrades (the load pass) or refuses (a grant).
 */
export async function listCommandsByPackage(): Promise<Map<string, PackageCommand[]>> {
  return groupApplicationCommands(await listApplicationCellCommands());
}

/** What one application's command approval can record, and what it names as never running. */
export interface CommandConsentPlan {
  /** The commands Allow records -- every one a click could run once approved. */
  approvable: PackageCommand[];
  /** The commands no click ever runs: named on the screen, never recorded. */
  wontRun: PackageCommand[];
  /** Exactly what goes into `button-commands:<application>`. */
  artifacts: ConsentArtifact[];
}

/** Split an application's commands into what Allow records and what it names as never running. */
export function commandConsentPlan(commands: readonly PackageCommand[]): CommandConsentPlan {
  const approvable = commands.filter((c) => c.wontRunBecause === null);
  return {
    approvable,
    wontRun: commands.filter((c) => c.wontRunBecause !== null),
    artifacts: commandConsentArtifacts(approvable),
  };
}

/**
 * The record items of the commands a click could run: `{id: commandId, source:
 * commandId}`, so the hash Rust's command gate asks (sha256 of the id's bytes)
 * is the hash the store records. A command that never runs is left out.
 */
export function commandConsentArtifacts(commands: readonly PackageCommand[]): ConsentArtifact[] {
  return commands
    .filter((c) => c.wontRunBecause === null)
    .map((c) => ({ id: c.commandId, source: c.commandId }));
}
