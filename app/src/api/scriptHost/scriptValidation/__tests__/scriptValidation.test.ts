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
import { SURFACE_SIZE, suggestChains } from "../surface";
import { capabilitiesFor, isKnownChain } from "../surface";

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
    expect(a.contextBindings).toEqual(["ctx"]);
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
