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
//            `cellType` custom object and are materialized on pull byte-for-byte
//            with NO sanitizing; and one click resolves the module by id and
//            hands its stored source verbatim to `run_script`.
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
//          to go stale — the allowlist as data, the button planner by CALLING it,
//          and the publish/pull paths as source.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ALLOWLIST } from "@api/scriptHost/allowlist";
import { accessLevelForOrigin, packageOrigin } from "@api/scriptHost/scriptOrigin";
import { planStoredModuleRun } from "../../_shared/lib/buttonScriptRun";

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
  });

  it("names the surfaces the USER can point at a macro afterwards", () => {
    expect(DIALOG).toContain(
      "Anything of your own you point at one later: a button, a view bookmark, " +
        "the command line, or one of your own scripts.",
    );
    // Each of those exists. A macro-linked button and the command line both go
    // through the @api/macroRunService seam; a view bookmark's onActivate runs a
    // stored module by id through the workbook-script runner.
    expect(read("extensions/Controls/index.ts")).toContain(
      "requireMacroRunProvider().runMacroByRef(macroRef)",
    );
    expect(read("extensions/CommandLine/cli/appGateway.ts")).toContain(
      "requireMacroRunProvider().runMacroByRef(macroId)",
    );
    const bookmarks = read("extensions/BuiltIn/CellBookmarks/index.ts");
    expect(bookmarks).toContain("setScriptRunner(async (scriptId: string) => {");
    expect(bookmarks).toContain("await runWorkbookScript(");
  });

  it("still says the grant is what switches them on at all", () => {
    expect(DIALOG).toContain(
      "They will not run at all until this application&apos;s code is approved, " +
        "and allowing approves them:",
    );
  });
});

describe("THE PUBLISHER'S BUTTON: the claim that a click runs the macro it names", () => {
  it("a stored module with no function name runs its OWN source, unchanged", () => {
    // Called, not read: this is the planner the button cell uses, and "verbatim"
    // is a property of what it returns.
    const plan = planStoredModuleRun({
      id: "macro-month-end",
      name: "Month end",
      source: "Calcula.setCellValue('A1', 1);",
      sourcePackage: "Quarterly Reports",
    });
    expect(plan.kind).toBe("run");
    if (plan.kind === "run") {
      expect(plan.source).toBe("Calcula.setCellValue('A1', 1);");
      // `module` non-null is the shape the Rust consent gate can rule on — the
      // stored record, byte for byte.
      expect(plan.module?.id).toBe("macro-month-end");
    }
  });

  it("the button cell resolves the module by id and runs that plan", () => {
    const button = read("extensions/CellTypes/types/button.ts");
    expect(button).toContain("const script = await getWorkbookScript(action.scriptId);");
    expect(button).toContain("const plan = planStoredModuleRun(");
    expect(button).toContain("await runWorkbookScript(plan.source, plan.filename)");
  });

  it("a cell's button action TRAVELS inside the application, unsanitized", () => {
    const calp = read("src-tauri/src/calp_commands.rs");
    // Publish: the sheet's cell-type assignments — params and all — become one
    // opaque `cellType` custom object.
    expect(calp).toContain('kind: "cellType".to_string(),');
    expect(calp).toContain("payload: s.cells,");
    // Pull: materialized straight into the subscriber's cell-type store.
    expect(calp).toContain("crate::cell_types::materialize_saved_cell_types(");
    // ...from the published payload, cloned, with nothing in between.
    expect(calp).toContain("cells: co.payload.clone(),");
  });

  it("...unlike an on-grid button CONTROL, which arrives DISARMED", () => {
    // Why the bullet about the user's own wiring says "of your own": a published
    // control's inline code and macro link are stripped on the way in, so the
    // publisher cannot arm those two. The prompt still warns about "a button the
    // publisher put on a sheet" because a button CELL is not a control and does
    // arrive armed — and a consent screen is the wrong place to teach that
    // distinction. Erring toward the click that cannot happen is the safe error.
    const controls = read("src-tauri/src/controls.rs");
    expect(controls).toContain(
      "pub const EXECUTABLE_CONTROL_PROPERTIES: &[&str] = &[ON_SELECT_PROPERTY, MACRO_REF_PROPERTY];",
    );
    expect(controls).toContain("pub fn sanitize_distributed_controls(");
    expect(controls).toContain("props.remove(*key);");
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
