//! FILENAME: app/src/api/scriptHost/scriptValidation/__tests__/scriptValidation.test.ts
// PURPOSE: Pin the draft validator's three checks and — above all — the
//          ASYMMETRY §11.2 rests on: an undeclared capability is an ERROR, a
//          declared-but-unobserved one is a NOTICE.
// CONTEXT: The asymmetry is the part most likely to be "simplified" later by
//          someone who reads the code and not the design doc, so it is asserted
//          in both directions with the reason in the test names.

import { describe, it, expect } from "vitest";
import { validateScriptSource, repairPrompt } from "../index";
import { analyzeScript, parseDeclaredCapabilities } from "../analyze";
import { SURFACE_SIZE, suggestChains, surfaceScopeFor } from "../surface";
import { capabilitiesFor, isKnownChain } from "../surface";
import { SCRIPTABLE_OBJECT_TYPES } from "../../../scriptableObjects";
import { contextInterfaceFor, objectHooksFor } from "../../scriptPreview/objectHooks";
import { OBJECT_TYPE_CONTEXTS, SCRIPT_SURFACE } from "../../generated/scriptSurfacePolicy";
import { chainsForObjectType } from "../../generated/scriptSurfaceSlices";

describe("the generated surface is present and indexed", () => {
  it("is not empty (every other test would pass vacuously)", () => {
    expect(SURFACE_SIZE).toBeGreaterThan(300);
  });

  it("indexes chains an author actually writes, at every depth", () => {
    expect(isKnownChain("caps.fetch"), "depth 2 under caps").toBe(true);
    expect(isKnownChain("caps.storage.get"), "depth 3 under a named sub-api").toBe(true);
    expect(isKnownChain("log"), "a root context member").toBe(true);
  });

  it("carries the capability the broker will demand", () => {
    expect([...capabilitiesFor("caps.fetch")]).toEqual(["net.fetch"]);
    expect([...capabilitiesFor("caps.storage.get")]).toEqual(["storage"]);
    // An unpoliced member requires nothing.
    expect([...capabilitiesFor("log")]).toEqual([]);
  });
});

describe("L0 - parsing", () => {
  it("rejects a script that does not parse, naming the line", () => {
    const r = validateScriptSource("export function setup(context) {\n  context.log('x'\n}\n");
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe("parse-error");
    expect(r.findings[0].line).toBeGreaterThan(0);
  });

  it("accepts modern syntax (optional chaining, top-level await, classes)", () => {
    const src = [
      "export async function setup(context) {",
      "  const v = context?.api?.getCellValue?.(0, 0);",
      "  class Helper { #x = 1; get x() { return this.#x; } }",
      "  context.log(String(v ?? new Helper().x));",
      "}",
    ].join("\n");
    expect(validateScriptSource(src).analysis.parsed).toBe(true);
  });
});

describe("the entry point, and the vacuous pass it used to allow", () => {
  // Found by the M5 eval corpus on a real 3B model's first answer. The model
  // replied with a bare top-level handler and no `setup`, and BOTH the reach
  // check and the capability check reported a clean bill of health -- because
  // with no recognisable entry point nothing was rooted, so nothing was
  // examined. A script like that mounts and does nothing: the wrapper tail is
  // `typeof setup === "function" ? setup(context) : undefined`.
  const noSetup = [
    "onClick(() => {",
    "  const v = context.api.getCellValue(0, 0);",
    "  context.api.setCellValue(0, 1, v);",
    "});",
  ].join("\n");

  it("rejects a script with no setup function", () => {
    const r = validateScriptSource(noSetup);
    expect(r.ok).toBe(false);
    const f = r.findings.find((x) => x.code === "no-entry-point")!;
    expect(f.severity).toBe("error");
    expect(f.message).toMatch(/nothing would run/);
  });

  it("still examines the calls in it, instead of passing vacuously", () => {
    // The bare-`context` fallback. Without it the analysis found no bindings and
    // reported no calls at all, so an undeclared capability in a script like
    // this would have gone unnoticed.
    const r = validateScriptSource(noSetup);
    expect(r.analysis.calls.map((c) => c.chain)).toEqual(
      expect.arrayContaining(["api.getCellValue", "api.setCellValue"]),
    );
  });

  it("catches an undeclared capability even without an entry point", () => {
    const r = validateScriptSource("context.caps.fetch('https://example.com');\n");
    expect(r.findings.some((f) => f.code === "undeclared-capability")).toBe(true);
    expect(r.findings.some((f) => f.code === "no-entry-point")).toBe(true);
  });

  it("accepts setup declared as a const arrow, not only as a function", () => {
    const r = validateScriptSource("export const setup = (context) => { context.log('x'); };\n");
    expect(r.findings.some((f) => f.code === "no-entry-point")).toBe(false);
  });

  it("accepts a plain (unexported) setup declaration", () => {
    const r = validateScriptSource("function setup(context) { context.log('x'); }\n");
    expect(r.findings.some((f) => f.code === "no-entry-point")).toBe(false);
  });
});

describe("L1 - reach", () => {
  it("accepts a script that only calls real members", () => {
    const src = [
      "export function setup(context) {",
      "  context.log('hello');",
      "  context.api.setCellValue(0, 0, 'x');",
      "}",
    ].join("\n");
    const r = validateScriptSource(src);
    expect(r.findings.filter((f) => f.code === "unknown-member")).toEqual([]);
  });

  it("rejects an invented member and suggests the real one", () => {
    const src = "export function setup(context) {\n  context.api.setCellValu(0, 0, 'x');\n}";
    const r = validateScriptSource(src);
    const f = r.findings.find((x) => x.code === "unknown-member");
    expect(f, "a one-character typo must be caught").toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.suggestions).toContain("api.setCellValue");
  });

  it("does NOT flag methods on a value a real call returned", () => {
    // `api.getCellValue(...).toString()` flattens to api.getCellValue.toString,
    // which is not a surface member — but the ancestor is, so the tail belongs
    // to the returned string. Flagging it would reject valid code.
    const src = [
      "export function setup(context) {",
      "  const s = context.api.getCellValue(0, 0).toString().trim();",
      "  context.log(s);",
      "}",
    ].join("\n");
    expect(validateScriptSource(src).findings.filter((f) => f.code === "unknown-member")).toEqual([]);
  });

  it("does NOT flag the script's own locals, imports or globals", () => {
    const src = [
      "export function setup(context) {",
      "  const rows = [1, 2, 3];",
      "  const total = rows.reduce((a, b) => a + b, 0);",
      "  JSON.stringify({ total });",
      "  Math.max(1, 2);",
      "  context.log(String(total));",
      "}",
    ].join("\n");
    expect(validateScriptSource(src).findings.filter((f) => f.code === "unknown-member")).toEqual([]);
  });

  it("follows a handle through a local alias", () => {
    const src = [
      "export function setup(context) {",
      "  const api = context.api;",
      "  api.setCellValu(0, 0, 'x');",
      "}",
    ].join("\n");
    const f = validateScriptSource(src).findings.find((x) => x.code === "unknown-member");
    expect(f, "an alias must not hide a bad call").toBeDefined();
    expect(f!.message).toContain("api.setCellValu");
  });

  it("honours whatever the author named the context parameter", () => {
    const src = "export function setup(ctx) {\n  ctx.api.setCellValu(0, 0, 'x');\n}";
    expect(validateScriptSource(src).findings.some((f) => f.code === "unknown-member")).toBe(true);
  });
});

describe("L2 - capability reconciliation, the asymmetry from §11.2", () => {
  it("ERRORS when a call needs a capability the script did not declare", () => {
    // The scanner saw a real call, so this is provably broken: broker.ts:162
    // refuses it at run time WITHOUT prompting.
    const src = [
      "export async function setup(context) {",
      "  const res = await context.caps.fetch('https://example.com/x');",
      "  context.log(String(res));",
      "}",
    ].join("\n");
    const r = validateScriptSource(src);
    expect(r.ok).toBe(false);
    const f = r.findings.find((x) => x.code === "undeclared-capability")!;
    expect(f.severity).toBe("error");
    expect(f.capability).toBe("net.fetch");
    expect(f.message).toContain("// @capability net.fetch");
    expect(f.message, "the consequence must be stated, not just the rule").toContain("PermissionDenied");
  });

  it("accepts the same script once it declares the capability", () => {
    const src = [
      "// @capability net.fetch",
      "export async function setup(context) {",
      "  const res = await context.caps.fetch('https://example.com/x');",
      "  context.log(String(res));",
      "}",
    ].join("\n");
    const r = validateScriptSource(src);
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
    expect(r.observed).toEqual(["net.fetch"]);
  });

  it("NOTICES, never rejects, a declaration it could not observe", () => {
    const src = [
      "// @capability net.fetch",
      "export function setup(context) {",
      "  context.log('nothing fetches here');",
      "}",
    ].join("\n");
    const r = validateScriptSource(src);
    expect(r.ok, "an over-broad declaration must NOT block the draft").toBe(true);
    const f = r.findings.find((x) => x.code === "declared-not-observed")!;
    expect(f.severity).toBe("notice");
    expect(f.capability).toBe("net.fetch");
  });

  it("explains a declared-not-observed notice by the computed access that caused it", () => {
    // This is the case that makes auto-declaring unsafe: no `caps.fetch` token
    // exists anywhere, yet the capability is genuinely required.
    const src = [
      "// @capability net.fetch",
      "export async function setup(context) {",
      "  const method = Math.random() > 0.5 ? 'fetch' : 'log';",
      "  await context.caps[method]('https://example.com');",
      "}",
    ].join("\n");
    const r = validateScriptSource(src);
    expect(r.ok).toBe(true);
    expect(r.hasDynamicAccess, "the scanner must admit it was blinded").toBe(true);
    const f = r.findings.find((x) => x.code === "declared-not-observed")!;
    expect(f.message).toContain("computed member access");
    expect(f.message).toContain("may well be correct");
  });

  it("says the plainer thing when nothing blinded the scanner", () => {
    const src = "// @capability storage\nexport function setup(context) {\n  context.log('x');\n}";
    const f = validateScriptSource(src).findings.find((x) => x.code === "declared-not-observed")!;
    expect(f.message).toContain("broader than the script needs");
    expect(f.message).not.toContain("computed member access");
  });

  it("rejects a capability id that does not exist", () => {
    const src = "// @capability net.fetchall\nexport function setup(context) {\n  context.log('x');\n}";
    const r = validateScriptSource(src);
    expect(r.ok).toBe(false);
    expect(r.findings.find((f) => f.code === "unknown-capability-id")!.capability).toBe("net.fetchall");
  });

  it("reports declared and observed separately, which is what the reviewer sees", () => {
    const src = [
      "// @capability net.fetch",
      "// @capability storage",
      "export async function setup(context) {",
      "  await context.caps.storage.get('k');",
      "}",
    ].join("\n");
    const r = validateScriptSource(src);
    expect(r.declared).toEqual(["net.fetch", "storage"]);
    expect(r.observed).toEqual(["storage"]);
    expect(r.ok, "the gap is shown, not enforced").toBe(true);
  });
});

describe("pragma parsing mirrors the Rust ceiling parser", () => {
  it("reads one id per line and de-duplicates", () => {
    expect(parseDeclaredCapabilities("// @capability bi.query\n//  @capability  net.fetch\n// @capability bi.query\n"))
      .toEqual(["bi.query", "net.fetch"]);
  });

  it("ignores a pragma that is not at the start of a line", () => {
    expect(parseDeclaredCapabilities("const s = 'x'; // @capability net.fetch")).toEqual([]);
  });
});

describe("the repair prompt", () => {
  it("names the fix and the suggestion, and carries no notices", () => {
    const src = [
      "// @capability storage",
      "export async function setup(context) {",
      "  await context.caps.fetch('https://example.com');",
      "  context.api.setCellValu(0, 0, 'x');",
      "}",
    ].join("\n");
    const prompt = repairPrompt(validateScriptSource(src));
    expect(prompt).toContain("// @capability net.fetch");
    expect(prompt).toContain("api.setCellValue");
    // The notice about `storage` is for the human; feeding it to the model
    // would teach it to strip declarations it cannot prove it needs.
    expect(prompt).not.toContain("broader than the script needs");
  });

  it("is empty for a clean script", () => {
    expect(repairPrompt(validateScriptSource("export function setup(context) { context.log('x'); }"))).toBe("");
  });
});

describe("suggestions", () => {
  it("prefers a candidate in the same namespace", () => {
    expect(suggestChains("caps.fetchUrl")[0]).toBe("caps.fetch");
  });

  it("returns nothing for a name close to no real member", () => {
    expect(suggestChains("zzzzzzzzzzzzzzzzqqqq")).toEqual([]);
  });
});

describe("analysis reports what it saw", () => {
  it("records the context binding it walked from", () => {
    const a = analyzeScript("export function setup(ctx) { ctx.log('x'); }");
    // `ctx` is setup's own parameter; the literal `context` is ALSO bound,
    // always — the wrapper's parameter is reachable by closure from anywhere
    // in the script, whatever setup calls its own (absent shadowing).
    expect([...a.contextBindings].sort()).toEqual(["context", "ctx"].sort());
    expect(a.calls.map((c) => c.chain)).toContain("log");
  });
});

describe("only `setup` receives the context", () => {
  /**
   * The mount tail is `typeof setup === "function" ? setup(context)`, so `setup`
   * is the only function the context is ever passed to. Binding the first
   * parameter of EVERY exported function made an exported helper's parameter a
   * context binding, so its ordinary JS resolved to a bare context chain and was
   * reported as an invented API member — a valid draft REJECTED, which is the
   * costliest way a checker can be wrong.
   */
  it("does not treat an exported helper's parameter as the context", () => {
    const source = [
      "export function setup(context) {",
      "  context.expose('onClick', () => {",
      "    context.api.setCellValue(100, 1, String(total([1, 2, 3])));",
      "  });",
      "}",
      "export function total(values) {",
      "  return values.reduce((a, b) => a + Number(b), 0);",
      "}",
      "",
    ].join("\n");

    const report = validateScriptSource(source);

    expect(report.findings.filter((f) => f.code === "unknown-member")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("still binds `setup`'s own parameter, whatever it is named", () => {
    const source = [
      "export function setup(ctx) {",
      "  ctx.api.setCellValu(0, 0, 'typo');",
      "}",
      "",
    ].join("\n");

    const report = validateScriptSource(source);

    expect(report.findings.some((f) => f.code === "unknown-member")).toBe(true);
  });

  it("binds an arrow `export const setup`, and no other exported const", () => {
    const bad = "export const setup = (context) => { context.api.nope(0, 0); };\n";
    expect(validateScriptSource(bad).findings.some((f) => f.code === "unknown-member")).toBe(true);

    const fine = [
      "export function setup(context) { context.log('x'); }",
      "export const format = (row) => row.map((c) => c.trim()).join(',');",
      "",
    ].join("\n");
    expect(validateScriptSource(fine).findings.filter((f) => f.code === "unknown-member")).toEqual([]);
  });
});

describe("what counts as an entry point", () => {
  /**
   * The wrapper's parameter is literally named `context`, so a top-level
   * `context.expose(...)` registers its handler at mount and WORKS. Rejecting
   * it as "nothing would run" was a false claim about a working script —
   * the unentitled-verdict shape again (found by adversarial review).
   */
  it("accepts a top-level context.expose script — it genuinely runs", () => {
    const report = validateScriptSource(
      "context.expose('onClick', async () => {\n" +
      "  await context.api.setCellValue(0, 0, 'works');\n" +
      "});\n",
    );
    expect(report.findings.filter((f) => f.code === "no-entry-point")).toEqual([]);
  });

  it("rejects ctx.expose at top level — `ctx` is a ReferenceError at mount", () => {
    const report = validateScriptSource(
      "ctx.expose('onClick', () => { ctx.log('x'); });\n",
    );
    expect(report.findings.some((f) => f.code === "no-entry-point")).toBe(true);
  });

  it("does not count an expose buried in a function nothing calls", () => {
    const report = validateScriptSource(
      "function helper() {\n" +
      "  context.expose('onClick', () => {});\n" +
      "}\n",
    );
    expect(report.findings.some((f) => f.code === "no-entry-point")).toBe(true);
  });

  /**
   * The un-exported arrow form: hasSetupEntryPoint accepted it, but the
   * binding fallback only knew `function setup`, so a parameter not named
   * context/ctx left NOTHING bound and every reach/capability check passed
   * vacuously.
   */
  it("binds an un-exported `const setup = (c) => …`'s parameter", () => {
    const report = validateScriptSource(
      "const setup = (c) => {\n" +
      "  c.api.setCellValu(0, 0, 'typo');\n" +
      "};\n",
    );
    expect(report.findings.some((f) => f.code === "unknown-member")).toBe(true);
  });
});

describe("the RUN TARGET notice — a warning, never a rejection", () => {
  // Reported 2026-08-26: "again I could not run it due to it lacking some sort
  // of entry point function." A script whose whole body is inside setup() or a
  // hook handler MOUNTS correctly and does exactly what it was asked to do when
  // the hook fires — it simply has nothing for Run (F5) to start, because setup
  // is excluded from run-at-cursor (the mount already called it).
  //
  // THE SEVERITY IS THE WHOLE POINT. A false rejection sends a correct draft
  // into repair rounds, which is minutes per round on a local model and strictly
  // worse than the gap it would be closing.
  const hasRunTargetNotice = (src: string, objectType?: string) => {
    const report = validateScriptSource(src, objectType);
    return {
      notice: report.findings.find((f) => f.code === "no-run-target"),
      ok: report.ok,
    };
  };

  it("warns about a hook-only script, and still calls it VALID", () => {
    const { notice, ok } = hasRunTargetNotice(
      "export function setup(context) {\n" +
      "  context.onClick(async () => { await context.api.setCellValue(0, 0, 'hi'); });\n" +
      "}\n",
      "button",
    );
    expect(notice, "the gap the owner hit must be reported").toBeTruthy();
    expect(notice!.severity, "a notice, so nothing blocks and no round is spent").toBe("notice");
    expect(ok, "report.ok must stay true").toBe(true);
    expect(notice!.message).toContain("async function run()");
  });

  it("says nothing when there IS a top-level run target", () => {
    const { notice } = hasRunTargetNotice(
      "async function run() {\n" +
      "  await context.api.setCellValue(0, 0, 'hi');\n" +
      "}\n" +
      "export function setup(context) {\n" +
      "  context.onClick(async () => { await run(); });\n" +
      "}\n",
      "button",
    );
    expect(notice).toBeUndefined();
  });

  it("says nothing about a context.expose command — that IS startable", () => {
    // An exposed handler is reachable from a schedule, a shortcut and another
    // script. Nagging about it would be nagging about a script that already has
    // the thing the notice asks for.
    const { notice } = hasRunTargetNotice(
      "export function setup(context) {\n" +
      "  context.expose('refresh', async () => { await context.api.setCellValue(0, 0, 'x'); });\n" +
      "}\n",
      "button",
    );
    expect(notice).toBeUndefined();
  });

  it("says nothing about a VETO hook, where the return value is the point", () => {
    // THE SUPPRESSION WITH THE MOST AT STAKE. A refactor that moved the work out
    // of `onBeforeSave` to satisfy this notice would silently disarm a veto, and
    // `report.ok` cannot see that.
    const { notice, ok } = hasRunTargetNotice(
      "export function setup(context) {\n" +
      "  context.onBeforeSave(() => ({ cancel: true }));\n" +
      "}\n",
      "workbook",
    );
    expect(notice, "a one-line veto script is CORRECT").toBeUndefined();
    expect(ok).toBe(true);
  });

  it("says nothing about an onRender painter either", () => {
    const { notice } = hasRunTargetNotice(
      "export function setup(context) {\n" +
      "  context.onRender((c) => { c.fillRect(0, 0, 1, 1); });\n" +
      "}\n",
      "chartMark",
    );
    expect(notice).toBeUndefined();
  });

  it("says nothing about a script with no setup at all", () => {
    // That script has a DIFFERENT, harder defect — `no-entry-point`, an ERROR —
    // and piling a second finding on top of it would only crowd the repair
    // prompt at the exact moment the model needs one clear instruction.
    const { notice } = hasRunTargetNotice("onClick(() => { context.log('x'); });\n", "button");
    expect(notice).toBeUndefined();
  });
});

describe("context flow — the false-pass half of the setup-only trade", () => {
  /**
   * `setup(context) { helper(context); }` makes helper's parameter the context
   * at runtime. The setup-only narrowing fixed drafts being REJECTED for an
   * exported helper's ordinary JS, but left an invented member INSIDE a
   * context-fed helper invisible — and the dry run declines object scripts, so
   * nothing downstream caught it either.
   */
  it("flags an invented member inside a helper the context is passed to", () => {
    const report = validateScriptSource(
      [
        "export function setup(context) {",
        "  context.expose('onClick', () => helper(context));",
        "}",
        "function helper(c) {",
        "  c.api.setCellValu(0, 0, 'typo');",
        "}",
        "",
      ].join("\n"),
    );
    expect(report.findings.some((f) => f.code === "unknown-member")).toBe(true);
  });

  it("follows the context through TWO helpers (fixpoint)", () => {
    const report = validateScriptSource(
      [
        "export function setup(context) {",
        "  first(context);",
        "}",
        "function first(a) { second(a); }",
        "function second(b) { b.caps.fetch('https://example.com'); }",
        "",
      ].join("\n"),
    );
    expect(report.findings.some((f) => f.code === "undeclared-capability")).toBe(true);
  });

  /** A polymorphic helper is skipped — binding it would false-flag real JS. */
  it("does not bind a helper that is ALSO called with something else", () => {
    const report = validateScriptSource(
      [
        "export function setup(context) {",
        "  context.expose('onClick', () => { render(context); render([1, 2]); });",
        "}",
        "function render(values) {",
        "  return values.reduce ? values.reduce((a, b) => a + b, 0) : 0;",
        "}",
        "",
      ].join("\n"),
    );
    expect(report.findings.filter((f) => f.code === "unknown-member")).toEqual([]);
  });

  /**
   * The wrapper's parameter is LITERALLY `context`, reachable by closure, so a
   * stray top-level use works at runtime even when setup names its parameter
   * something else — and must therefore be examined.
   */
  it("examines a bare top-level context use even when setup(c) binds c", () => {
    const report = validateScriptSource(
      [
        "context.caps.fetch('https://example.com');",
        "export function setup(c) {",
        "  c.log('x');",
        "}",
        "",
      ].join("\n"),
    );
    expect(report.findings.some((f) => f.code === "undeclared-capability")).toBe(true);
  });

  /** A script that declares its OWN `context` is left alone — shadowing. */
  it("does not flag a local named context inside a nested function", () => {
    const report = validateScriptSource(
      [
        "export function setup(c) {",
        "  c.expose('onClick', () => draw());",
        "}",
        "function draw() {",
        "  const context = { fillRect: () => {} };",
        "  context.fillRect();",
        "}",
        "",
      ].join("\n"),
    );
    expect(report.findings.filter((f) => f.code === "unknown-member")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// L1 is narrowed to ONE object type
// ---------------------------------------------------------------------------

/** `onSheetChange` is declared by WorkbookContext and by nothing else. */
const WORKBOOK_HOOK = [
  "export function setup(context) {",
  "  context.onSheetChange(() => {});",
  "}",
  "",
].join("\n");

describe("L1 - reach is object-type aware", () => {
  // Deliberately asserts ONLY that the script is accepted. The report's own
  // `objectType` field is checked in its own case below, so that a narrowing
  // that silently stops narrowing reds the button case and leaves this one
  // green — if BOTH go red, the union broke, not the narrowing.
  it("accepts a workbook hook in a workbook script", () => {
    const r = validateScriptSource(WORKBOOK_HOOK, "workbook");
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
  });

  it("says which object type it checked the script AS", () => {
    expect(validateScriptSource(WORKBOOK_HOOK, "workbook").objectType).toBe("workbook");
  });

  it("rejects that same hook in a BUTTON script, naming both contexts", () => {
    // The defect this check exists for: a button draft calling
    // `context.onSheetChange` used to validate CLEAN and then throw on the first
    // line of `setup`, because at mount the member was `undefined`.
    const r = validateScriptSource(WORKBOOK_HOOK, "button");
    expect(r.ok).toBe(false);
    const f = r.findings.find((x) => x.code === "wrong-object-type")!;
    expect(f, "the member is REAL, so it must not be reported as invented").toBeDefined();
    expect(f.severity).toBe("error");
    expect(f.message).toContain("WorkbookContext");
    expect(f.message, "the author must be told what this script IS").toContain("button");
    expect(f.objectTypes, "the repair is data, not prose to parse back out").toEqual(["workbook"]);
    expect(f.line).toBe(2);
    expect(
      r.findings.filter((x) => x.code === "unknown-member"),
      "a real member must never also be reported as invented",
    ).toEqual([]);
    expect(r.objectType).toBe("button");
  });

  it("carries the wrong-object-type error into the repair prompt", () => {
    const prompt = repairPrompt(validateScriptSource(WORKBOOK_HOOK, "button"));
    expect(prompt).toContain("WorkbookContext");
    expect(prompt).toContain("onSheetChange");
  });

  it("names EVERY object type that could call it, not just the first", () => {
    // onSelectionChange is declared by SheetContext AND SlicerContext.
    const src = [
      "export function setup(context) {",
      "  context.onSelectionChange(() => {});",
      "}",
      "",
    ].join("\n");
    const f = validateScriptSource(src, "button").findings.find((x) => x.code === "wrong-object-type")!;
    expect(f).toBeDefined();
    expect(f.objectTypes).toEqual(["sheet", "slicer"]);
  });

  it("still suggests the member this object DOES have", () => {
    // `context.setCellValue` is a sheet's and a table's. A button has to go
    // through `context.api`, and being told only "wrong object" would leave a
    // model with nothing to do.
    const src = [
      "export function setup(context) {",
      "  context.setCellValue(0, 0, 'x');",
      "}",
      "",
    ].join("\n");
    const f = validateScriptSource(src, "button").findings.find((x) => x.code === "wrong-object-type")!;
    expect(f).toBeDefined();
    expect(f.objectTypes).toEqual(["sheet", "table"]);
    expect(f.suggestions).toContain("api.setCellValue");
  });

  it("leaves an ordinary typo an ordinary typo", () => {
    // `api.setCellValu` is on nobody's context; its only known prefix is the
    // `api` namespace, which this button CAN reach. It must not be diverted into
    // the wrong-object branch.
    const src = "export function setup(context) {\n  context.api.setCellValu(0, 0, 'x');\n}";
    const r = validateScriptSource(src, "button");
    expect(r.findings.some((f) => f.code === "wrong-object-type")).toBe(false);
    const f = r.findings.find((x) => x.code === "unknown-member")!;
    expect(f).toBeDefined();
    expect(f.suggestions).toContain("api.setCellValue");
  });

  it("keeps its suggestions inside the scope it is checking", () => {
    // `onSheetChanged` is one edit from a member a button cannot call. Offering
    // it would send the repair loop at a member that does not exist here, and
    // the loop could not converge.
    const src = "export function setup(context) {\n  context.onSheetChanged(() => {});\n}";
    const suggestions =
      validateScriptSource(src, "button").findings.find((f) => f.code === "unknown-member")
        ?.suggestions ?? [];
    expect(suggestions).not.toContain("onSheetChange");
    // NOT VACUOUS: over the whole surface it really is the nearest neighbour.
    expect(suggestChains("onSheetChanged")).toContain("onSheetChange");
  });

  it("narrows NOTHING for an object type the generated table does not know", () => {
    // The fail-open direction. A type added to the product before
    // `npm run gen:script-typings` is re-run must not have its own hooks
    // rejected: this is a linter, and inventing a defect costs more than missing
    // one.
    const r = validateScriptSource(WORKBOOK_HOOK, "spaceship");
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
    expect(r.objectType).toBeUndefined();
  });

  it("narrows NOTHING when the caller names no object type at all", () => {
    const r = validateScriptSource(WORKBOOK_HOOK);
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
    expect(r.objectType).toBeUndefined();
  });
});

describe("a sub-object is reachable only through the member that hands it out", () => {
  /**
   * The gap the iface-based first draft of this check left open, now CLOSED.
   *
   * `cell()` is declared by SheetContext and TableContext alone, so `cell.*` is
   * not shared. A button that writes `context.cell.getValue()` cannot obtain a
   * cell at all, and the call is a TypeError at mount.
   */
  const CELL_USE = [
    "export function setup(context) {",
    "  context.cell.getValue();",
    "}",
    "",
  ].join("\n");

  it("rejects `context.cell` in a button script, naming sheet and table", () => {
    const r = validateScriptSource(CELL_USE, "button");
    expect(r.ok).toBe(false);
    const f = r.findings.find((x) => x.code === "wrong-object-type")!;
    expect(f).toBeDefined();
    expect(f.objectTypes).toEqual(["sheet", "table"]);
  });

  it("accepts the identical source in a SHEET script", () => {
    const r = validateScriptSource(CELL_USE, "sheet");
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE THING THAT MUST NOT HAPPEN: rejecting code that is correct today
// ---------------------------------------------------------------------------

const ALL_OBJECT_TYPES = OBJECT_TYPE_CONTEXTS.map(([objectType]) => objectType);

/** Only members BaseObjectContext declares — legal in every script there is. */
const BASE_MEMBERS_ONLY = [
  "// @capability storage",
  "export function setup(context) {",
  "  context.log('hello');",
  "  context.notify('hi');",
  "  context.expose('doThing', async () => {",
  "    await context.caps.storage.set('k', '1');",
  "    const v = await context.caps.storage.get('k');",
  "    await context.api.setCellValue(0, 0, String(v));",
  "    await context.api.getCellValue(0, 0);",
  "  });",
  "}",
  "",
].join("\n");

describe("narrowing must never reject correct code", () => {
  it.each(ALL_OBJECT_TYPES)("%s - a script using only base members is clean", (objectType) => {
    const r = validateScriptSource(BASE_MEMBERS_ONLY, objectType);
    expect(
      r.findings.filter((f) => f.severity === "error"),
      `${objectType}: ${JSON.stringify(r.findings)}`,
    ).toEqual([]);
  });

  it.each(ALL_OBJECT_TYPES)("%s - registering its OWN hooks is clean", (objectType) => {
    const hooks = objectHooksFor(objectType);
    const body = hooks.length > 0
      ? hooks.map((h) => `  context.${h}(() => {});`)
      : ["  context.log('this type declares no hooks of its own');"];
    const src = ["export function setup(context) {", ...body, "}", ""].join("\n");
    const r = validateScriptSource(src, objectType);
    expect(
      r.findings.filter((f) => f.severity === "error"),
      `${objectType} hooks ${JSON.stringify(hooks)}: ${JSON.stringify(r.findings)}`,
    ).toEqual([]);
  });

  it("keeps every BaseObjectContext member legal for every object type", () => {
    const baseChains = [
      ...new Set(SCRIPT_SURFACE.filter((m) => m.iface === "BaseObjectContext").map((m) => m.chain)),
    ];
    expect(baseChains.length, "not vacuous").toBeGreaterThan(5);
    for (const objectType of ALL_OBJECT_TYPES) {
      const scope = surfaceScopeFor(objectType);
      const missing = baseChains.filter((c) => !scope.isKnownChain(c));
      expect(missing, `${objectType} lost base members`).toEqual([]);
    }
  });

  it("accepts a handle obtained through a member this object DOES have", () => {
    // The false positive that matters most: `api.range` is shared and is the
    // prefix of nothing, so `r.setValue` must resolve through its callable
    // ancestor rather than being reported as an invented member.
    const src = [
      "export function setup(context) {",
      "  context.onClick(async () => {",
      "    const r = await context.api.range('A1');",
      "    r.setValue('x');",
      "  });",
      "}",
      "",
    ].join("\n");
    const r = validateScriptSource(src, "button");
    expect(r.findings.filter((f) => f.severity === "error"), JSON.stringify(r.findings)).toEqual([]);
  });
});

describe("the validator's scope and the prompt's slice are the same set", () => {
  /**
   * Two independent derivations of one fact, deliberately not one shared import:
   * this module walks `SCRIPT_SURFACE` (94 KB, already in the main bundle),
   * while the prompt reads the generated slices (~209 KB, lazily imported). If
   * they ever disagree, a model is shown a member the checker will reject, or
   * the checker admits one the model was never told about.
   */
  it.each(ALL_OBJECT_TYPES)("%s accepts exactly what the prompt shows", (objectType) => {
    const mine = [...surfaceScopeFor(objectType).chains].sort();
    const theirs = [...chainsForObjectType(objectType)].sort();
    expect(mine.length, "not vacuous").toBeGreaterThan(300);
    expect(mine).toEqual(theirs);
  });
});

describe("the tripwires under the narrowing", () => {
  it("knows an object type for every context interface in the surface", () => {
    // A `*Context` interface with no row in OBJECT_TYPE_CONTEXTS is a context
    // nobody is ever handed -- or, far likelier, a table that stopped being
    // regenerated. Either way the narrowing is judging scripts against a
    // surface that no longer describes them.
    const known = new Set(OBJECT_TYPE_CONTEXTS.map(([, iface]) => iface));
    const orphans = [
      ...new Set(SCRIPT_SURFACE.map((m) => m.iface).filter((i) => /Context$/.test(i))),
    ].filter((i) => !known.has(i));
    expect(orphans).toEqual([]);
  });

  it("narrows every scriptable object type the product actually offers", () => {
    for (const objectType of SCRIPTABLE_OBJECT_TYPES) {
      expect(surfaceScopeFor(objectType).narrowed, `${objectType} narrowed nothing`).toBe(true);
    }
  });

  it("agrees with the preview about which interface each type is handed", () => {
    for (const objectType of ALL_OBJECT_TYPES) {
      expect(surfaceScopeFor(objectType).iface, objectType).toBe(contextInterfaceFor(objectType));
    }
  });
});
