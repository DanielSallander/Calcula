//! FILENAME: app/src/api/__tests__/macroStarter.test.ts
// PURPOSE: The starter a new macro begins from has a SHAPE the product depends
//          on, and this file pins it: it parses; it declares exactly one
//          function besides `setup` (so Run (F5) in the editor has one target
//          from any cursor line); the validator does not call it un-runnable;
//          it carries no capability pragma, no module syntax and no bytes; its
//          cell-access sentence is GENERATED from `macroNeedsCellAccessMessage`
//          (never retyped); and `api.getSelection` is its ONLY call outside the
//          explicit-run grant -- which is what its "PUBLISHING IT" header tells
//          the user, so a grant change must come back here and update the text.
// CONTEXT: docs/design/open-items.md section 2.ap. The naming cases prove the
//          builder rules: a name becomes an identifier through the one
//          `toIdentifier` rule, `setup` can never be the work function's name,
//          and a quote or a line break in a name is escaped, not injected.

import { describe, it, expect } from "vitest";
import {
  MACRO_STARTER_DEFAULT_NAME,
  buildMacroStarterSource,
  macroNeedsCellAccessMessage,
  macroStarterFunctionName,
  toIdentifier,
} from "@api/scriptHost/macroStarter";
import { topLevelFunctions } from "@api/scriptHost/worker/debugInstrument";
import { validateScriptSource } from "@api/scriptHost/scriptValidation";
import { ungrantedApiCalls } from "@api/scriptHost/explicitRunGrant";

const src = buildMacroStarterSource("Macro1");

/** The declared top-level functions as `{ name, arity }` only. */
function declaredFunctions(source: string): { name: string; arity: number }[] {
  return topLevelFunctions(source).map((f) => ({ name: f.name, arity: f.arity }));
}

describe("the starter's shape", () => {
  it("is named Macro1 by default", () => {
    expect(MACRO_STARTER_DEFAULT_NAME).toBe("Macro1");
  });

  it("parses as a script body", () => {
    expect(() => new Function(src)).not.toThrow();
  });

  it("declares exactly one function besides setup, so F5 has one run target", () => {
    expect(declaredFunctions(src)).toEqual([
      { name: "macro1", arity: 1 },
      { name: "setup", arity: 1 },
    ]);
  });

  it("is not reported as un-runnable by the validator, and shares the recorder's ONE known narrowing error", () => {
    const report = validateScriptSource(src, "workbook");
    expect(report.findings.map((f) => f.code)).not.toContain("no-run-target");
    expect(report.findings.map((f) => f.code)).not.toContain("no-entry-point");
    expect(report.findings.map((f) => f.code)).not.toContain("parse-error");
    // WHAT THE VALIDATOR DOES SAY, pinned so a change in either direction is
    // seen. A module macro is validated NARROWED to "workbook" (the editor
    // synthesises that type for a macro document), and `setup`'s button branch
    // -- `context.onClick`, the SAME branch the recorder's wrapper emits
    // (actionCodegen.ts wrapObjectScript) -- is a `wrong-object-type` ERROR under
    // that narrowing, because WorkbookContext declares no onClick. That is a
    // property of validating a two-shaped module as one shape, shared by every
    // recorded macro, and it is recorded in open-items 2.ap; it is NOT a reason
    // to drop the branch here and diverge from the recorder. Everything else
    // must be clean: the only error-severity finding is that one, on that chain.
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(
      errors.map((f) => `${f.code}: ${f.message}`),
      "the starter must carry no validator error beyond the recorder's shared onClick narrowing",
    ).toEqual(errors.filter((f) => f.code === "wrong-object-type" && /onClick/.test(f.message)).map((f) => `${f.code}: ${f.message}`));
    expect(errors.length, "exactly one narrowing error (context.onClick under 'workbook')").toBe(1);
    // Unnarrowed -- a module is a workbook-shaped mount that may also be
    // button-shaped -- the starter validates clean.
    expect(validateScriptSource(src).ok, "the starter must validate clean with no object type").toBe(true);
  });

  it("declares no capability, no module syntax and no bytes", () => {
    expect(src).not.toContain("@capability");
    expect(src).not.toContain("import ");
    expect(src).not.toContain("export ");
    expect(src).not.toContain("data:");
  });

  it("generates the cell-access sentence from macroNeedsCellAccessMessage, quotes included", () => {
    expect(src).toContain(JSON.stringify(macroNeedsCellAccessMessage("Macro1")));
    // The name IS wrapped in double quotes: in the source they travel escaped
    // inside the literal, and the value the script throws carries them as-is.
    expect(src).toContain('\\"Macro1\\" did not run: it needs cell access');
    const thrown = (() => {
      try {
        new Function("context", src + "\nreturn setup(context);")({ api: null });
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      return "nothing was thrown";
    })();
    expect(thrown.startsWith('"Macro1" did not run: it needs cell access')).toBe(true);
    expect(thrown).toBe(macroNeedsCellAccessMessage("Macro1"));
  });

  it("calls api.getSelection and nothing else outside the explicit-run grant", () => {
    // This pins the header's "PUBLISHING IT" claim. If `api.getSelection` is
    // ever added to EXPLICIT_RUN_CELL_METHODS this list becomes empty and the
    // header paragraph must change with it; if the starter ever reaches for
    // another ungranted call, the paragraph is no longer the whole truth.
    expect(ungrantedApiCalls(src)).toEqual(["api.getSelection"]);
  });

  it("names the doors the user has, and the run button's exact label", () => {
    expect(src).toContain("Run (object script)");
    expect(src).toContain("Type  run Macro1  in the command line (View > Command Line, Ctrl+Shift+P).");
    expect(src).toContain('await api.beginBatch("Macro1");');
    expect(src).toContain("const AMOUNT = 1; // CHANGE ME");
  });
});

describe("the builder rules", () => {
  it("turns the name into the work function's identifier everywhere", () => {
    const named = buildMacroStarterSource("Add one");
    expect(named).toContain("async function addOne(api)");
    expect(named).toContain('api.beginBatch("Add one")');
    expect(named).toContain("run Add one again");
    expect(named).toContain("report(await addOne(context.api));");
    expect(named).toContain("return addOne(context.api).then((n) => {");
    expect(named).toContain("// Add one -- adds 1 to every selected cell");
    expect(declaredFunctions(named)).toEqual([
      { name: "addOne", arity: 1 },
      { name: "setup", arity: 1 },
    ]);
  });

  it("never names the work function setup", () => {
    expect(macroStarterFunctionName("setup")).toBe("setupMacro");
    const named = buildMacroStarterSource("setup");
    expect(named).toContain("async function setupMacro(api)");
    expect(declaredFunctions(named)).toEqual([
      { name: "setupMacro", arity: 1 },
      { name: "setup", arity: 1 },
    ]);
  });

  it("falls back to `macro` for a name with no identifier in it", () => {
    expect(macroStarterFunctionName("***")).toBe("macro");
    const named = buildMacroStarterSource("***");
    expect(named).toContain("async function macro(api)");
    expect(() => new Function(named)).not.toThrow();
  });

  it("escapes a quote and a line break in the name instead of injecting them", () => {
    const hostile = 'Say "hi"\nnow // not a comment';
    const named = buildMacroStarterSource(hostile);
    expect(() => new Function(named)).not.toThrow();
    expect(named).toContain("api.beginBatch(" + JSON.stringify(hostile) + ")");
    expect(named).toContain(JSON.stringify(macroNeedsCellAccessMessage(hostile)));
    // In a `//` comment the line break became a space, so the comment is one line.
    expect(named).toContain('// Say "hi" now // not a comment -- adds 1 to every selected cell');
    expect(declaredFunctions(named).map((f) => f.name)).toEqual(["sayHiNowNotAComment", "setup"]);
  });

  it("treats U+2028 and U+2029 as line breaks too: they end a `//` comment in JavaScript", () => {
    // A `//` comment ends at ANY ECMAScript line terminator, not only CR/LF. A
    // name carrying LINE SEPARATOR would otherwise turn the rest of the header
    // line into a top-level statement -- in a file that later runs unlocked.
    const hostile = "Totals\u2028throw new Error(1)\u2029// end";
    const named = buildMacroStarterSource(hostile);
    // The first LINE is the whole header comment (the separators became spaces).
    // Split on the line feed by char code: a backslash-n written in this file's
    // source has been expanded into a real newline by an editing tool before.
    const firstLine = named.split(String.fromCharCode(10))[0];
    expect(firstLine).toBe("// Totals throw new Error(1) // end -- adds 1 to every selected cell that holds a number.");
    expect(() => new Function(named)).not.toThrow();
    expect(declaredFunctions(named).map((f) => f.name)).toEqual(["totalsThrowNewError1End", "setup"]);
    // The literals still carry the real characters, escaped by JSON.stringify.
    expect(named).toContain("api.beginBatch(" + JSON.stringify(hostile) + ")");
  });
});

describe("toIdentifier keeps the recorder's pinned cases", () => {
  it("camel-cases words", () => {
    expect(toIdentifier("Monthly close")).toBe("monthlyClose");
    expect(toIdentifier("Macro 1")).toBe("macro1");
  });

  it("prefixes a leading digit", () => {
    expect(toIdentifier("2026 rollforward")).toBe("_2026Rollforward");
  });

  it("falls back for unusable input", () => {
    expect(toIdentifier("***")).toBe("recordedMacro");
    expect(toIdentifier("***", "macro")).toBe("macro");
    expect(toIdentifier("")).toBe("recordedMacro");
  });
});
