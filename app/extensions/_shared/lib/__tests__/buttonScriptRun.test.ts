//! FILENAME: app/extensions/_shared/lib/__tests__/buttonScriptRun.test.ts
// PURPOSE: Pin THE ONE RULE every button surface now shares — code that arrived
//          in a .calp application is never composed with other code — and the
//          escape check that keeps any module body, of any provenance, inside
//          the function it is wrapped in.
//
// The two defects this file exists for:
//   1. `buildScriptPreamble()` fanned out over EVERY module in the workbook,
//      distributed ones included, so a publisher's code was defined (and, with
//      one `Name()` in any button, executed) with no package consent anywhere in
//      the path — the Rust gate decides by exact source equality and a
//      concatenated program equals no stored record.
//   2. The wrap was textual, so a module body containing `}` reached TOP LEVEL
//      and ran on every click of every button in the workbook.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  buildLocalPreamble,
  planInlineButtonRun,
  planStoredModuleRun,
  sanitizeScriptName,
  singleModuleCallName,
  type ButtonScriptModule,
} from "../buttonScriptRun";

/** A module body that closes its wrapper and puts its payload at top level. */
const ESCAPING_BODY = "} __payload(); function __pad() {";

function localModule(name: string, source: string): ButtonScriptModule {
  return { id: `local-${name}`, name, source, sourcePackage: null, loadError: null };
}

function packageModule(
  name: string,
  source: string,
  app = "SalesApp",
): ButtonScriptModule {
  return { id: `pkg-${name}`, name, source, sourcePackage: app, loadError: null };
}

function runPlan(plan: ReturnType<typeof planInlineButtonRun>) {
  if (plan.kind !== "run") throw new Error(`expected a run plan, got: ${plan.message}`);
  return plan;
}

// ============================================================================
// The escape check is GONE, deliberately — and this is why
// ============================================================================

describe("a module body that escapes its wrapper", () => {
  // A first version of this module refused such a body, using
  // `new Function(body)` as a parser. Both halves of that were wrong.
  //
  // It could not work: the application ships a content-security policy with no
  // 'unsafe-eval' (`app/src-tauri/tauri.conf.json`), so the Function
  // constructor THROWS in the real app and every module would have been read as
  // "not a function body" and dropped from every button click. jsdom enforces
  // no CSP, so the check's own tests passed while the feature was broken.
  //
  // And it was not needed: the escape only ever mattered for code the user did
  // not write, and a module that arrived in an application is no longer
  // composed into anything at all (see the distributed cases below). What is
  // left is the user's own code in their own workbook.
  it("is the user's own code, and runs — the boundary is provenance, not syntax", () => {
    const plan = runPlan(
      planInlineButtonRun("Good();", [
        localModule("Good", "Calcula.log('ok');"),
        localModule("Evil", ESCAPING_BODY),
      ]),
    );
    // Present, because the user wrote it. This is the pre-existing behaviour of
    // the preamble, restored: nothing here is a boundary being crossed.
    expect(plan.source).toContain("__payload");
    expect(plan.source).toContain("function Good() {");
  });

  it("does NOT rely on eval anywhere, so the app's CSP cannot disable it", () => {
    // The regression this pins: if any code path here reaches for the Function
    // constructor again, it throws under the shipped CSP and every module
    // silently disappears from every button. Read as source so the assertion
    // holds regardless of what jsdom permits.
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "buttonScriptRun.ts"),
      "utf8",
    );
    // Comments are stripped first: this file's own prose names the
    // constructor it is banning, and so does the module's. A scanner that
    // matched comments would fail on the explanation of the rule.
    const code = src
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(code).not.toContain("new Function(");
    expect(code).not.toMatch(/\beval\s*\(/);
  });

  it("keeps every other button working when one module is unusable", () => {
    const plan = runPlan(
      planInlineButtonRun("Good();", [
        localModule("Evil", ESCAPING_BODY),
        localModule("Good", "Calcula.log('ok');"),
      ]),
    );
    expect(plan.source).toContain("function Good() {");
  });
});

// ============================================================================
// A distributed module is not silently included
// ============================================================================

describe("a distributed module is never spliced into a button's program", () => {
  it("is absent from the preamble a user-authored button runs", () => {
    const plan = runPlan(
      planInlineButtonRun("Helper();", [
        localModule("Helper", "Calcula.log('mine');"),
        packageModule("Report", "__publisherPayload();"),
      ]),
    );
    expect(plan.source).toContain("function Helper() {");
    expect(plan.source).not.toContain("function Report() {");
    expect(plan.source).not.toContain("__publisherPayload");
    // A button that never mentioned it is not nagged about it either.
    expect(plan.unavailable).toEqual([]);
  });

  it("is absent even when its name would shadow one of the user's own", () => {
    const plan = runPlan(
      planInlineButtonRun("Helper();", [
        localModule("Helper", "Calcula.log('mine');"),
        packageModule("Helper", "__publisherPayload();"),
      ]),
    );
    expect(plan.source).toBe("function Helper() {\nCalcula.log('mine');\n}\nHelper();");
    expect(plan.module).toBeNull();
  });

  it("is REPORTED, not silently dropped, when the inline code names it", () => {
    const plan = runPlan(
      planInlineButtonRun("Report(); Helper();", [
        localModule("Helper", "Calcula.log('mine');"),
        packageModule("Report", "__publisherPayload();"),
      ]),
    );
    expect(plan.source).not.toContain("__publisherPayload");
    const notice = plan.unavailable.find((u) => u.name === "Report");
    expect(notice?.reason).toBe("distributed");
    expect(notice?.message).toContain("SalesApp");
    expect(notice?.message).toContain('"Report()"');
  });

  it("runs a distributed module's stored source VERBATIM when invoked directly", () => {
    // The legitimate case: a distributed report's own button calling its own
    // module. The program handed to the runtime is byte-for-byte the stored
    // record, which is the only shape the Rust consent gate can rule on — so
    // consent decides, here, instead of being walked around.
    const target = packageModule("Report", "__publisherPayload();");
    const plan = runPlan(planInlineButtonRun(" Report() ; ", [target]));
    expect(plan.source).toBe("__publisherPayload();");
    expect(plan.module?.id).toBe(target.id);
    expect(plan.filename).toBe(`button_module_${target.id}.js`);
  });

  it("only treats a bare zero-argument call as an invocation", () => {
    expect(singleModuleCallName("Report()")).toBe("Report");
    expect(singleModuleCallName("Report();")).toBe("Report");
    expect(singleModuleCallName("  Report ( ) ; ")).toBe("Report");
    expect(singleModuleCallName("Report(1)")).toBeNull();
    expect(singleModuleCallName("Report(); evil();")).toBeNull();
    expect(singleModuleCallName("if (x) Report();")).toBeNull();
    expect(singleModuleCallName("a.Report()")).toBeNull();
  });

  it("does not delegate for code that merely ends in a call", () => {
    const plan = runPlan(
      planInlineButtonRun("Calcula.log('x'); Report();", [
        packageModule("Report", "__publisherPayload();"),
      ]),
    );
    expect(plan.module).toBeNull();
    expect(plan.source).toBe("Calcula.log('x'); Report();");
    expect(plan.source).not.toContain("__publisherPayload");
  });
});

// ============================================================================
// The user's own code is unchanged
// ============================================================================

describe("a user-authored button calling a user-authored module", () => {
  it("produces exactly the program it always did", () => {
    const plan = runPlan(
      planInlineButtonRun("MyMacro();", [localModule("My Macro", "Calcula.log(1);")]),
    );
    expect(plan.source).toBe("function My_Macro() {\nCalcula.log(1);\n}\nMyMacro();");
    expect(plan.filename).toBe("button_onSelect.js");
  });

  it("still wraps names the same way the Properties Pane spells them", () => {
    expect(sanitizeScriptName("My Macro")).toBe("My_Macro");
    expect(sanitizeScriptName("2nd pass")).toBe("_2nd_pass");
    expect(sanitizeScriptName("!!!")).toBe("___");
  });
});

// ============================================================================
// The cell type's stored-module binding
// ============================================================================

describe("planStoredModuleRun", () => {
  it("runs a bound module's stored source unchanged when no function is named", () => {
    const module = packageModule("Report", "__publisherPayload();");
    const plan = planStoredModuleRun(module);
    expect(plan).toMatchObject({
      kind: "run",
      source: "__publisherPayload();",
      module: { id: module.id },
    });
  });

  it("still appends the call for the user's OWN module", () => {
    const plan = planStoredModuleRun(localModule("Mine", "function Go() { x(); }"), "Go");
    expect(plan).toMatchObject({
      kind: "run",
      source: "function Go() { x(); }\nGo();",
    });
  });

  it("refuses to append a call into a module that arrived in an application", () => {
    const plan = planStoredModuleRun(packageModule("Report", "function Go() {}"), "Go");
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") return;
    expect(plan.message).toContain("SalesApp");
    expect(plan.message).toContain("Go()");
  });

  it("refuses a functionName that is not an identifier", () => {
    // The button's params can themselves have arrived in a .calp, so this field
    // is an identifier or it is nothing.
    const plan = planStoredModuleRun(
      localModule("Mine", "var a = 1;"),
      "Go(); __publisherPayload()",
    );
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") return;
    expect(plan.message).toContain("is not a function name");
  });

  it("reports an unreadable record instead of running nothing", () => {
    const plan = planStoredModuleRun({
      id: "x",
      name: "Broken",
      source: "",
      sourcePackage: null,
      loadError: "record is corrupt",
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") return;
    expect(plan.message).toContain("record is corrupt");
  });
});
