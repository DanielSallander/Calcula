//! FILENAME: app/extensions/ScriptableObjects/__tests__/macroConsentTriggerHonesty.test.ts
// PURPOSE: The macro paragraph of the package-consent prompt must name every
//          trigger the grant it produces actually arms — and no more.
// CONTEXT: `ScriptConsentDialog` told the user "Nothing runs them on its own —
//          you run them yourself, from the macro library". That stopped being
//          true the moment an application's MACROS were folded into the same one
//          grant its object scripts get (packageMacroConsent.test.ts), because
//          the macro library is not the only surface that can start one, and the
//          other surface belongs to the PUBLISHER:
//
//            a `calcula.button` CELL carries `action: { kind: "script",
//            scriptId }` in its cell-type params; those params publish as a
//            `cellType` custom object, the pull keeps the action when it names
//            a macro the application brought in (BUG-0260 removes every other
//            action on the way in); and one click asks the Rust button door
//            (`run_control_action`, phase 4 of BUG-0257), which resolves the
//            module by id from its own store and runs its stored source
//            verbatim, behind that module's approval.
//
//          A .calp therefore ships the button AND the macro, and "Allow" is what
//          arms the click. A consent screen that understates reach is worse than
//          none — the user's Allow answers a different question from the one the
//          code will act on (the same finding consentTextHonesty.test.ts records
//          for the grid-reach sentences).
//
//          Written the way formConsentHonesty.test.ts is: the user-facing
//          sentences are pinned as SOURCE TEXT, and every claim they make is
//          established from the code that would have to change for the sentence
//          to go stale — the allowlist as data, and the button door (Rust, since
//          phase 4 of BUG-0257: its planner is called by control_action_tests.rs)
//          and the publish/pull paths as source.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ALLOWLIST } from "@api/scriptHost/allowlist";
import { accessLevelForOrigin, packageOrigin } from "@api/scriptHost/scriptOrigin";

const APP_ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

/**
 * Strip comments before matching, then flatten whitespace.
 *
 * BOTH HALVES ARE LOAD-BEARING. The comment beside the fixed paragraph QUOTES
 * the sentence that was removed, so an un-stripped scan fails on the very file
 * that was fixed (consentTextHonesty.test.ts records the same trap). And JSX
 * wraps prose across lines, so a sentence only exists as one string after the
 * whitespace collapse.
 */
function prose(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\s+/g, " ");
}

const DIALOG_SRC = read("extensions/ScriptableObjects/components/ScriptConsentDialog.tsx");
const DIALOG = prose(DIALOG_SRC);

describe("the macro paragraph no longer claims the macro library is the only way in", () => {
  it("the old sentence is gone from the prompt (not merely from the rendered text)", () => {
    expect(DIALOG).not.toContain("you run them yourself, from the macro library");
    expect(DIALOG).not.toContain("Nothing runs them on its own");
  });

  it("...and the removed sentence is still quoted in the comment that explains why", () => {
    // The positive control for the stripper above. Without it the assertions in
    // this file could pass because the scan never saw the paragraph at all.
    expect(DIALOG_SRC).toContain("you run them yourself, from the macro library");
    expect(DIALOG).toContain("macro");
  });
});

describe("every trigger the sentence names is a trigger the code has", () => {
  it("names the macro library", () => {
    expect(DIALOG).toContain("Developer &#9656; Macros, where you pick one and press Run.");
    // The library's Run goes through `runMacroModule`, which routes on the
    // runtime marker and passes the SAME Rust consent gate on both routes.
    const library = read("extensions/MacroRecorder/lib/macroLibrary.ts");
    expect(library).toContain("export async function runMacroModule(");
    expect(library).toContain("return runWorkbookScript(entry.source,");
  });

  it("names a button the PUBLISHER put on a sheet", () => {
    expect(DIALOG).toContain("A button the publisher put on a sheet");
    expect(DIALOG).toContain("one click runs the macro it names");
    // ...and, since phase 3 of BUG-0257, it NAMES those buttons under each macro
    // rather than only saying "a button" (consentButtonsListing.test.tsx).
    expect(DIALOG).toContain("Each macro below lists the buttons that run it.");
    expect(DIALOG).toContain("Buttons that run this macro:");
  });

  it("names the surfaces the USER can point at a macro afterwards", () => {
    // Owner decision B: a run a SCRIPT starts never gets the macro's reach --
    // the module runtime refuses it (follow-up F10), the object-script route
    // runs it restricted -- so "one of your own scripts" is no longer listed as
    // something that runs it, and the screen says what happens instead.
    // SABOTAGE: put "or one of your own scripts" back into the list.
    expect(DIALOG).toContain(
      "Anything of your own you point at one later: a button, a view bookmark, " +
        "or the command line. One of your own scripts can start one too, but never " +
        "with its reach: a macro for the workbook script runtime is then refused, and " +
        "one written as an object script runs restricted.",
    );
    expect(DIALOG).not.toContain("the command line, or one of your own scripts.");
    // Each of those exists. A macro-linked button and the command line both go
    // through the @api/macroRunService seam -- a button through Controls' ONE
    // click rule, whose own live link runs with no application requirement; a
    // view bookmark's onActivate runs a stored module by id through the
    // workbook-script runner.
    // The user's own link: the button trigger, no application requirement, and
    // -- when a person clicked it -- the pass their gesture minted (owner
    // decision B). Whitespace-collapsed: the call spans lines.
    expect(read("extensions/Controls/lib/applicationMacroLink.ts").replace(/\s+/g, " ")).toContain(
      "requireMacroRunProvider().runMacroByRef(link.macroId, { trigger, ...(explicitRun ? { explicitRun } : {}), })",
    );
    // The command line: the seam, with the pass the typed line minted
    // (follow-up F2) and no application requirement.
    expect(read("extensions/CommandLine/cli/appGateway.ts")).toContain(
      "requireMacroRunProvider().runMacroByRef(macroId, { explicitRun })",
    );
    // A view bookmark: the workbook-script runner, told who activated it
    // (follow-up F10: a script's activation cannot run an application's macro).
    const bookmarks = read("extensions/BuiltIn/CellBookmarks/index.ts");
    expect(bookmarks).toContain("setScriptRunner(async (scriptId: string, activatedBy: ViewBookmarkActivator) => {");
    expect(bookmarks).toContain("await runWorkbookScript(");
    expect(bookmarks).toContain('startedBy: { kind: "viewBookmark", activatedBy },');
  });

  it("still says the grant is what switches them on at all", () => {
    expect(DIALOG).toContain(
      "They will not run at all until this application&apos;s code is approved, " +
        "and allowing approves them:",
    );
  });
});

/** The body of a Rust `fn` from its signature to the closing brace at column 0. */
function rustFn(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `\`${signature}\` moved`).toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf("\n}\n", start));
}

describe("THE PUBLISHER'S BUTTON: the claim that a click runs the macro it names", () => {
  // Phase 4 of BUG-0257: the button cell's rule is Rust's
  // (scripting/control_action.rs `plan_cell_action`, CALLED case for case by
  // control_action_tests.rs -- "verbatim" is a property of what it returns,
  // pinned there). What this file establishes is that the click reaches THAT
  // planner and nothing on the page stands in for it.
  const door = read("src-tauri/src/scripting/control_action.rs");

  it("a stored module with no function name runs its OWN source, unchanged", () => {
    const planner = rustFn(door, "pub(crate) fn plan_cell_action(");
    // Resolved by id among the stored modules...
    expect(planner).toContain("let Some(module) = modules.iter().find(|m| m.id == script_id) else {");
    // ...and with no "Function to call", run as the record itself -- the one
    // shape the module's approval can be asked of.
    const verbatim = planner.slice(planner.indexOf("if function.is_empty() {"));
    expect(verbatim.slice(0, verbatim.indexOf("}"))).toContain("source: module.source.clone(),");
  });

  it("the button cell asks the door, which plans from its OWN store, and the page composes nothing", () => {
    const button = read("extensions/CellTypes/types/button.ts");
    expect(button).toContain('{ kind: "cell", sheetIndex: at.sheetIndex, row: at.row, col: at.col }');
    expect(prose(button)).not.toContain("getWorkbookScript(");
    expect(prose(button)).not.toContain("runWorkbookScript(");
    // The door reads the cell's params from its own store, never from the page.
    const decide = rustFn(door, "pub(crate) fn decide(");
    expect(decide).toContain("state.cell_types.read()");
    expect(rustFn(door, "fn decide_cell(")).toContain(
      "match plan_cell_action(action, application.as_deref(), modules) {",
    );
    // ...and runs nothing until the gate has ruled on the FINAL source. (The
    // production core is a wrapper over the list-taking one, plan_M8 S1.)
    expect(rustFn(door, "pub(crate) fn run_control_action_core(")).toContain("run_control_action_core_with(");
    const core = rustFn(door, "pub(crate) fn run_control_action_core_with(");
    expect(core.indexOf("decide(state, &modules, request)?")).toBeGreaterThan(-1);
    expect(core.indexOf("button_run_gate(")).toBeGreaterThan(core.indexOf("decide(state, &modules, request)?"));
  });

  it("a cell's button action TRAVELS inside the application -- when it names the application's own macro", () => {
    const calp = read("src-tauri/src/calp_commands.rs");
    // Publish: the sheet's cell-type assignments — params and all — become one
    // opaque `cellType` custom object.
    expect(calp).toContain('kind: "cellType".to_string(),');
    expect(calp).toContain("payload: s.cells,");
    // Pull: materialized into the subscriber's cell-type store...
    expect(calp).toContain("crate::cell_types::materialize_saved_cell_types(");
    // ...through the admission (BUG-0260), which keeps a script action only when
    // it names a module THIS pull applied for the application.
    expect(calp).toContain("crate::button_cells::admit_button_cells(");
    const cells = read("src-tauri/src/button_cells.rs");
    expect(cells).toContain("Some(id) if applied.contains(id) => Ok(()),");
    expect(cells).toContain("cells: co.payload.clone(),");
  });

  it("...and the click refuses a publisher's button that names a macro that is not the publisher's", () => {
    // The second layer, for a stamped button that reached the store some other
    // way (a sheet copy, a file): decided by the door BEFORE anything else, so
    // no call is ever composed onto a module the button's application does not
    // own. (Called with the user's own `macro-report` in control_action_tests.rs.)
    const door = read("src-tauri/src/scripting/control_action.rs");
    const planner = rustFn(door, "pub(crate) fn plan_cell_action(");
    const guard = planner.indexOf("if module.application() != Some(app) {");
    expect(guard, "the door no longer checks whose macro a stamped button names").toBeGreaterThan(0);
    expect(guard).toBeLessThan(planner.indexOf("let function = text(\"functionName\")"));
    expect(planner).toContain("reason: PlanRefusal::MacroNotFromApplication,");
    expect(rustFn(door, "pub(crate) fn describe_macro_not_from_application(")).toContain(
      'None => "is one of your own".to_string(),',
    );
  });

  it("...and so does a button CONTROL's link to the application's macro (phase 3)", () => {
    // A button CONTROL no longer arrives disarmed. A macroRef naming a macro
    // THIS pull landed for the application is kept HELD and stamped --
    // `DistributedWiring::LinkLanded`, the subscribe door's arm of
    // `admit_wiring` -- and any other link is removed and named. (Its inline
    // onSelect is held too since phase 4; the next case pins that.)
    const held = read("src-tauri/src/held_button_code.rs");
    expect(held).toContain("pub fn admit_wiring(");
    expect(held).toContain("props.remove(*key);");
    expect(held).toContain("DistributedWiring::LinkLanded { from, landed_macros, sheet_names } => {");
    expect(held).toContain("} else if landed_macros.contains(&text) {");
    const calp = read("src-tauri/src/calp_commands.rs");
    expect(calp).toContain(
      "MaterializeMode::Subscribe => crate::held_button_code::DistributedWiring::LinkLanded {",
    );
    // The click is the second, independent layer: the held link runs only as
    // THAT application's macro (`requirePackage`), which is the grant this
    // prompt gives -- the prompt's "a button the publisher put on a sheet" is
    // now literally true of controls too, and each one is named.
    const link = read("extensions/Controls/lib/applicationMacroLink.ts");
    expect(link).toContain("requirePackage: link.application");
    // The dev pull and the image migration still strip: they carry no macro a
    // link could land on.
    const controls = read("src-tauri/src/controls.rs");
    expect(controls).toContain(
      "pub const EXECUTABLE_CONTROL_PROPERTIES: &[&str] = &[ON_SELECT_PROPERTY, MACRO_REF_PROPERTY];",
    );
    expect(controls).toContain("pub fn sanitize_distributed_controls(");
    expect(controls).toContain("DistributedWiring::Strip");
  });

  it("...and a button CONTROL's INLINE code arrives held, and runs only after THIS approval (phase 4)", () => {
    // The prompt's button-action list claims three things; each is established
    // from the code that would have to change for the claim to go stale.
    //
    // (1) It ARRIVES HELD: the LinkLanded arm moves a STATIC onSelect into the
    //     held compartment under the pull's stamp -- never live -- and removes
    //     (and names) a formula-typed one.
    const held = read("src-tauri/src/held_button_code.rs");
    const arm = held.slice(held.indexOf("DistributedWiring::LinkLanded { from, landed_macros, sheet_names } => {"));
    const inlineBranch = arm.slice(arm.indexOf("if *key == ON_SELECT_PROPERTY {"), arm.indexOf("} else if landed_macros"));
    expect(inlineBranch).toContain('if value_type == "static" {');
    expect(inlineBranch).toContain("Some(from)");
    expect(inlineBranch).toContain("report.inline_removed.push(inline_removed_notice(&cell()));");
    //
    // (2) It runs only after THIS approval, of its exact bytes: the button door
    //     asks `buttonAction:<sha256>` in the stamp's application's record --
    //     the bare record this prompt's Allow writes.
    const gate = read("src-tauri/src/scripting/application_code_gate.rs");
    expect(gate).toContain("let id = super::control_action::button_action_consent_id(&held.code);");
    expect(gate).toContain("crate::calp_commands::consent_granted_in(f, &held.application, &id, &code_hash)");
    const door = read("src-tauri/src/scripting/control_action.rs");
    expect(door).toContain('pub(crate) const BUTTON_ACTION_CONSENT_PREFIX: &str = "buttonAction:";');
    expect(read("src-tauri/src/lib.rs")).toContain("scripting::control_action::run_control_action,");
    //
    // (3) It runs as its OWN code -- never composed with the user's modules --
    //     and a held `Name()` reaches only the application's own modules.
    expect(door).toContain("match plan_held_inline(&code, &from.application, modules) {");
    const planner = door.slice(door.indexOf("pub(crate) fn plan_held_inline("));
    expect(planner.slice(0, planner.indexOf("\n}\n"))).toContain(
      ".filter(|m| m.application() == Some(application) && sanitize_script_name(&m.name) == called)",
    );
    //
    // ...and the prompt says all three, verbatim.
    expect(DIALOG).toContain("Each arrived held &mdash; it runs only after this approval");
    expect(DIALOG).toContain("and as its own code, never mixed with yours.");
    expect(DIALOG).toContain("Runs the application&apos;s macro {action.runsMacro}.");
  });

  it("the old 'inline code is removed' claim is gone from the prompt", () => {
    // Phase 3's prompt and its comments said a pull REMOVES a button's inline
    // code. Since phase 4 that is false for a static onSelect.
    expect(DIALOG).not.toContain("inline code is removed");
    expect(DIALOG).not.toContain("still removes its inline");
    expect(DIALOG_SRC).not.toContain("a pull still removes its inline");
  });
});

describe("THE TWO NEGATIVES: no timer, and nothing at open", () => {
  it("the prompt makes both claims", () => {
    expect(DIALOG).toContain(
      "Nothing puts a macro on a timer and nothing starts one when you open this workbook",
    );
    expect(DIALOG).toContain("allowing arms every way one can be started here:");
  });

  it("a schedule runs the SCRIPT'S OWN methods — never a stored macro", () => {
    for (const row of ["cap.scheduleEvery", "cap.scheduleAt", "cap.scheduleOnce"]) {
      const entry = ALLOWLIST[row];
      expect(entry, row).toBeDefined();
      expect(entry.capability, row).toBe("schedule");
      expect(entry.desc, row).toContain("one of its own methods");
    }
  });

  it("a distributed script can never reach api.runMacro, so it cannot start one either", () => {
    // The Application.Run row is UNLOCKED tier...
    expect(ALLOWLIST["api.runMacro"]).toBeDefined();
    expect(ALLOWLIST["api.runMacro"].tier).toBe("unlocked");
    // ...and code that arrived in an application is capped at restricted, no
    // matter what the caller asks for. That cap is what keeps a mounted
    // publisher script — the half of this grant that DOES run at open — from
    // starting a macro without a click.
    expect(accessLevelForOrigin(packageOrigin("Quarterly Reports"), "unlocked")).toBe(
      "restricted",
    );
    expect(accessLevelForOrigin({ kind: "local" }, "unlocked")).toBe("unlocked");
  });
});
