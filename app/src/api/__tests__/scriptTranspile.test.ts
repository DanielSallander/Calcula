// PURPOSE: Prove the save-time compile gate behaves the way the storage
//          contract depends on — including the properties the CONSENT binding
//          rests on, which are not obvious from reading the function.
// CONTEXT: `script.source` is hashed by scriptSecurity.ts to bind a persisted
//          capability grant to the code that earned it. That hash is over the
//          stored text, so anything this module does to the stored text is a
//          consent question, not a formatting question:
//
//            * re-saving an unchanged JavaScript script must produce the SAME
//              BYTES, or every save would lapse the script's grant and re-prompt
//              the user for permissions they already gave;
//            * a source that does not compile must never be stored at all;
//            * compiling must be idempotent, so saving twice does not produce
//              two different artifacts (and two different hashes) for one script.

import { describe, it, expect } from "vitest";
import {
  transpileScriptToJavaScript,
  formatScriptSyntaxErrors,
  resetScriptTranspilerForTest,
} from "../scriptTranspile";
import { sha256Hex } from "../distributedConsent";

const JS_SCRIPT = `/** @param {ObjectScriptContext} context */
function setup(context) {
  // a blank line follows on purpose

  const rows = context.range("A1:B2").getValues();
  return () => context.log("bye");
}
`;

const TS_SCRIPT = `/** A typed object script. */
// @capability net.fetch
function setup(context: ObjectScriptContext): () => void {
  const rows: string[][] = context.range("A1:B2").getValues();
  context.log(rows.length);
  return () => context.log("bye");
}
`;

describe("JavaScript is stored verbatim", () => {
  it("returns the author's exact bytes — blank lines, indentation and all", async () => {
    const result = await transpileScriptToJavaScript(JS_SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.javascript).toBe(JS_SCRIPT);
    expect(result.transformed).toBe(false);
  });

  it("does not churn the source hash a capability grant is bound to", async () => {
    const before = await sha256Hex(JS_SCRIPT);
    const result = await transpileScriptToJavaScript(JS_SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Re-saving an unchanged script must leave the grant intact. If the gate
    // re-printed the source instead of passing it through, this hash would move
    // and scriptSecurity.restorePersistedScriptCapabilityGrant would drop the
    // stored grant on every save.
    expect(await sha256Hex(result.javascript)).toBe(before);
  });

  it("keeps CRLF line endings and module syntax untouched", async () => {
    const crlf = "import { helper } from './x.js';\r\n\r\nexport function setup(c) { return helper(c); }\r\n";
    const result = await transpileScriptToJavaScript(crlf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.javascript).toBe(crlf);
  });

  it("accepts an empty script", async () => {
    const result = await transpileScriptToJavaScript("");
    expect(result).toEqual({ ok: true, javascript: "", transformed: false });
  });
});

describe("TypeScript is compiled to the JavaScript that will run", () => {
  it("strips annotations and reports that it transformed the text", async () => {
    const result = await transpileScriptToJavaScript(TS_SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transformed).toBe(true);
    expect(result.javascript).toContain("function setup(context)");
    expect(result.javascript).not.toContain(": ObjectScriptContext");
    expect(result.javascript).not.toContain("string[][]");
  });

  it("keeps the // @capability pragma the backend derives the ceiling from", async () => {
    const result = await transpileScriptToJavaScript(TS_SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A transpile that dropped comments would silently change what the backend
    // believes this script is allowed to reach.
    expect(result.javascript).toContain("// @capability net.fetch");
    expect(result.javascript).toContain("/** A typed object script. */");
  });

  it("emits ES modules, because the worker imports the stored text as one", async () => {
    const result = await transpileScriptToJavaScript(
      "import { helper } from './x.js';\nexport function setup(c: unknown) { return helper(c); }\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.javascript).toContain("import { helper }");
    expect(result.javascript).toContain("export function setup");
    expect(result.javascript).not.toContain("require(");
  });

  it("is idempotent: compiling the emitted JavaScript again changes nothing", async () => {
    const first = await transpileScriptToJavaScript(TS_SCRIPT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await transpileScriptToJavaScript(first.javascript);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.javascript).toBe(first.javascript);
    expect(second.transformed).toBe(false);
    expect(await sha256Hex(second.javascript)).toBe(await sha256Hex(first.javascript));
  });

  it("an annotation-only edit produces the same artifact, so consent does not lapse", async () => {
    const untyped = "function setup(context) {\n    context.log(1);\n}\n";
    const typed = "function setup(context: ObjectScriptContext) {\n    context.log(1);\n}\n";
    const a = await transpileScriptToJavaScript(untyped);
    const b = await transpileScriptToJavaScript(typed);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Types have no runtime effect, so adding one must not change the executed
    // text — and therefore must not lapse a capability grant. What CAN lapse it
    // is a behaviour change, which is the next test.
    expect(b.javascript).toBe(a.javascript);
    expect(await sha256Hex(b.javascript)).toBe(await sha256Hex(a.javascript));
  });

  it("a behaviour change DOES move the hash", async () => {
    const before = await transpileScriptToJavaScript("function setup(context) {\n    context.log(1);\n}\n");
    const after = await transpileScriptToJavaScript(
      "function setup(context: ObjectScriptContext) {\n    context.caps.fetch('https://evil.example');\n}\n",
    );
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(await sha256Hex(after.javascript)).not.toBe(await sha256Hex(before.javascript));
  });
});

describe("a source that cannot run is never stored", () => {
  it("blocks on a TypeScript syntax error and says where", async () => {
    const result = await transpileScriptToJavaScript("function setup(context: {\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].line).toBeGreaterThanOrEqual(1);
    expect(result.message).toMatch(/does not compile/i);
    expect(formatScriptSyntaxErrors(result.errors)).toMatch(/^Line \d+:\d+ — .+ \(TS\d+\)/);
  });

  it("blocks on a broken JavaScript script too", async () => {
    const result = await transpileScriptToJavaScript("function setup(context) { if (true) { \n");
    expect(result.ok).toBe(false);
  });

  it("does NOT block on a TYPE error — that is the editor's job, not the gate's", async () => {
    // A type mistake must never make a script unsaveable: the language service
    // shows it as a squiggle, and the text still compiles to runnable JS.
    const result = await transpileScriptToJavaScript(
      "function setup(context: ObjectScriptContext) {\n  const n: number = 'not a number';\n  context.log(n);\n}\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.javascript).toContain("const n = 'not a number'");
  });

  it("blocks JSX, which no script runtime can execute", async () => {
    // TypeScript parses .js files with the JSX variant, so this text is a
    // CLEAN JavaScript parse — without the explicit JSX check it would sail
    // through as "already JavaScript" and be stored as a script that can never
    // be imported.
    const result = await transpileScriptToJavaScript("const a = <div>hi</div>;\n");
    expect(result.ok).toBe(false);
  });

  it("still compiles the angle-bracket TYPE ASSERTION that looks like JSX", async () => {
    const result = await transpileScriptToJavaScript("function setup(c) {\n  const n = <number>c.value;\n  return n;\n}\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.javascript).toContain("const n = c.value");
  });
});

describe("the compiler is loaded lazily and only once", () => {
  it("recovers after a reset (the cache is a cache, not a latch)", async () => {
    resetScriptTranspilerForTest();
    const result = await transpileScriptToJavaScript(TS_SCRIPT);
    expect(result.ok).toBe(true);
  });
});
