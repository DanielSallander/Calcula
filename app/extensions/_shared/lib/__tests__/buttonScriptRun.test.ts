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
    // This assertion was missing, which is how the defect below shipped: the
    // program was right and the NOTICE was wrong.
    expect(plan.unavailable).toEqual([]);
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
// A local module shadowing a distributed one is not a false notice
// ============================================================================

describe("a local module that shadows a distributed one of the same name", () => {
  // The defect: with a local `Report` and a distributed `Report`, an action of
  // exactly `Report()` ran the local module (correct) and THEN reported the
  // publisher's module as unavailable — a toast saying `Report()` is "not
  // defined here" and to "set the button's action to exactly Report()". Both
  // clauses were false: the action already was `Report()`, and it was defined,
  // by the user's own module. Step 2 asked only "was the name mentioned?".
  it("runs the local module and reports NOTHING for an action of exactly Name()", () => {
    const plan = runPlan(
      planInlineButtonRun("Report()", [
        localModule("Report", "Calcula.log('mine');"),
        packageModule("Report", "__publisherPayload();"),
      ]),
    );
    expect(plan.source).toBe("function Report() {\nCalcula.log('mine');\n}\nReport()");
    expect(plan.source).not.toContain("__publisherPayload");
    expect(plan.module).toBeNull();
    expect(plan.unavailable).toEqual([]);
  });

  it("reports nothing for composed code either — the name IS defined, by the user's module", () => {
    const plan = runPlan(
      planInlineButtonRun("if (ready) Report(); Helper();", [
        localModule("Report", "Calcula.log('mine');"),
        localModule("Helper", "Calcula.log('helper');"),
        packageModule("Report", "__publisherPayload();"),
      ]),
    );
    expect(plan.source).toContain("function Report() {");
    expect(plan.source).not.toContain("__publisherPayload");
    expect(plan.unavailable).toEqual([]);
  });

  it("still reports a distributed module that NO local module answers to", () => {
    // The positive control for the rule above: the notice survives where it is
    // true. `Other` has no local namesake, so the user really cannot call it
    // this way and is told so; `Report` has one, so it is not mentioned.
    const plan = runPlan(
      planInlineButtonRun("Report(); Other();", [
        localModule("Report", "Calcula.log('mine');"),
        packageModule("Report", "__publisherPayload();"),
        packageModule("Other", "__otherPayload();", "FinanceApp"),
      ]),
    );
    expect(plan.unavailable.map((u) => u.name)).toEqual(["Other"]);
    expect(plan.unavailable[0]?.message).toContain("FinanceApp");
  });

  it("an EMPTY or unreadable local module does not shadow — nothing of it would be defined", () => {
    // `buildLocalPreamble` wraps only a local module with a body and no read
    // error. A shadow set built from EVERY local record let an empty one
    // suppress both the delegation and the notice: `Report()` then ran with
    // nothing defined, and nobody was told why.
    const theirs = packageModule("Report", "__publisherPayload();");
    const empty = localModule("Report", "   ");
    const direct = runPlan(planInlineButtonRun("Report();", [empty, theirs]));
    expect(direct.module?.id, "an empty local must not stand in for the module").toBe(theirs.id);
    expect(direct.source).toBe("__publisherPayload();");

    const composed = runPlan(planInlineButtonRun("Calcula.log(1); Report();", [empty, theirs]));
    expect(composed.unavailable.map((u) => u.name)).toEqual(["Report"]);

    const broken = { ...localModule("Report", "x();"), loadError: "record is corrupt" };
    const viaBroken = runPlan(planInlineButtonRun("Report();", [broken, theirs]));
    expect(viaBroken.module?.id).toBe(theirs.id);
  });

  it("lets the local module win even when SEVERAL distributed ones share the name", () => {
    // Local-wins is the first rule; the ambiguity refusal below only applies
    // when nothing of the user's own answers to the name.
    const plan = runPlan(
      planInlineButtonRun("Report();", [
        localModule("Report", "Calcula.log('mine');"),
        packageModule("Report", "__salesPayload();", "SalesApp"),
        { ...packageModule("Report", "__financePayload();", "FinanceApp"), id: "pkg-Report-2" },
      ]),
    );
    expect(plan.source).toBe("function Report() {\nCalcula.log('mine');\n}\nReport();");
    expect(plan.unavailable).toEqual([]);
  });
});

// ============================================================================
// Name() answered by two applications is refused, not guessed
// ============================================================================

describe("a Name() that more than one distributed module answers to", () => {
  // The defect: `distributed.find(...)` took the first match in listing order,
  // and `list_scripts` sorts by name only with a stable sort over
  // `HashMap::values()`, so equal names keep RandomState iteration order — it
  // could differ between two launches of the same workbook. The plan was
  // `kind: "run"` with the arbitrary winner and `unavailable: []`: one of two
  // publishers' code ran by coin-flip, undisclosed.
  const sales = packageModule("Report", "__salesPayload();", "SalesApp");
  const finance: ButtonScriptModule = {
    ...packageModule("Report", "__financePayload();", "FinanceApp"),
    id: "pkg-Report-finance",
  };

  function refusal(plan: ReturnType<typeof planInlineButtonRun>): string {
    expect(plan.kind).toBe("refuse");
    return plan.kind === "refuse" ? plan.message : "";
  }

  it("refuses, naming the module and EACH application", () => {
    const message = refusal(planInlineButtonRun("Report()", [sales, finance]));
    expect(message).toContain("Report()");
    expect(message).toContain('"Report" from the application "SalesApp"');
    expect(message).toContain('"Report" from the application "FinanceApp"');
    expect(message).toContain("will not run");
    // The remedies: bind directly, or rename.
    expect(message).toMatch(/bind the button/i);
    expect(message).toMatch(/rename/i);
  });

  it("refuses identically whichever order the listing arrives in", () => {
    // The message must not inherit the nondeterminism it discloses.
    const a = refusal(planInlineButtonRun("Report();", [sales, finance]));
    const b = refusal(planInlineButtonRun("Report();", [finance, sales]));
    expect(a).toBe(b);
  });

  it("never runs either candidate's source", () => {
    for (const order of [[sales, finance], [finance, sales]]) {
      const plan = planInlineButtonRun("Report()", order);
      expect(plan.kind).toBe("refuse");
      if (plan.kind === "run") {
        expect(plan.source).not.toContain("__salesPayload");
        expect(plan.source).not.toContain("__financePayload");
      }
    }
  });

  it("counts an unreadable candidate too — its read failing is not a tie-break", () => {
    const broken: ButtonScriptModule = { ...finance, source: "", loadError: "record is corrupt" };
    const message = refusal(planInlineButtonRun("Report()", [sales, broken]));
    expect(message).toContain('"Report" from the application "FinanceApp"');
    expect(message).toContain('"Report" from the application "SalesApp"');
  });

  it("refuses two modules of ONE application that sanitize to the same identifier", () => {
    const message = refusal(
      planInlineButtonRun("My_Report()", [
        packageModule("My Report", "__a();", "SalesApp"),
        packageModule("My_Report", "__b();", "SalesApp"),
      ]),
    );
    expect(message).toContain('"My Report" from the application "SalesApp"');
    expect(message).toContain('"My_Report" from the application "SalesApp"');
  });

  it("composed code that names the tie gets ONE notice, whose remedy is the one that works", () => {
    // A notice per MODULE told the user twice to "set the button's action to
    // exactly Report()" — the one thing the planner then refuses as ambiguous.
    const plan = runPlan(
      planInlineButtonRun("Calcula.log(1); Report();", [
        packageModule("Report", "a();", "SalesApp"),
        packageModule("Report", "b();", "FinancePack"),
      ]),
    );
    const notices = plan.unavailable.filter((u) => u.name === "Report");
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain('"SalesApp"');
    expect(notices[0].message).toContain('"FinancePack"');
    expect(notices[0].message).not.toContain("set the button's action to exactly");
    expect(notices[0].message).toContain("Bind the button to one module directly");
  });

  it("still runs the ONE module that answers when there is no tie", () => {
    // Positive control: the refusal is for ties only.
    const plan = runPlan(planInlineButtonRun("Report()", [sales]));
    expect(plan.source).toBe("__salesPayload();");
    expect(plan.module?.id).toBe(sales.id);
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
