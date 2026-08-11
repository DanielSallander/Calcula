//! FILENAME: app/src/api/__tests__/dialogGlobalsBan.test.ts
// PURPOSE: Prove that the mechanism which retires the async-confirm defect class
//          actually FIRES on newly written code — and keep it fired.
// CONTEXT: The window.confirm-returns-a-Promise defect was fixed at the call
//          site five times before this and returned every time, because a
//          per-site fix leaves the NEXT site to be written. The class is now
//          closed by a lint rule (`dialogGuardConfigs` in eslint.boundaries.js,
//          run by `npm run lint:boundaries`). A rule nobody runs is not a
//          mechanism, so this test runs ESLint with the real project config over
//          synthetic sources and asserts each banned shape is reported.
//
//          If someone deletes or weakens the rule, THIS test fails — the guard
//          on the guard.

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// ONE ESLint instance for the whole file, not one per case.
//
// Loading the real project config is the expensive part, and it was being paid
// 23 times. Under the full suite (`npx vitest run`, everything in parallel) the
// FIRST case took 40s and blew the 30s test timeout, while the same file passes
// in 2s on its own -- a load-order flake that looks exactly like a broken lint
// rule in the log. Nothing about the check depends on a fresh instance: `cwd`
// and the config are constant, and the per-case `filePath` is an argument to
// `lintText`.
let shared: ESLint | null = null;
function eslintInstance(): ESLint {
  shared ??= new ESLint({
    cwd: APP_DIR,
    overrideConfigFile: path.join(APP_DIR, "eslint.config.boundaries.js"),
    // The file does not exist on disk; ignore-file resolution must not object.
    ignore: false,
  });
  return shared;
}

/** Lint a synthetic source as if it lived at `relPath`, using the real config. */
async function lint(relPath: string, source: string): Promise<ESLint.LintResult> {
  const [result] = await eslintInstance().lintText(source, {
    filePath: path.join(APP_DIR, relPath),
  });
  return result;
}

const DIALOG_RULES = new Set(["no-restricted-globals", "no-restricted-properties"]);

function dialogErrors(result: ESLint.LintResult): string[] {
  return result.messages
    .filter((m) => m.ruleId !== null && DIALOG_RULES.has(m.ruleId))
    .map((m) => `${m.line}:${m.ruleId}`);
}

describe("the dialog-globals ban", () => {
  // WARM THE CONFIG IN SETUP, because that is where the cost actually is.
  //
  // Sharing one `ESLint` instance (above) cut 23 config loads to one, but the
  // surviving load is still charged to whichever test runs FIRST, and it is a
  // real project config resolved over a large tree. Under `npx vitest run` with
  // every other file in flight it has been measured at over 30s, so the first
  // case died on the default per-test timeout and the whole file reported a
  // failure that reads exactly like a deleted lint rule. Nothing was wrong with
  // the rule on any of those runs.
  //
  // The load is SETUP, not assertion, so it is billed to setup with a budget
  // that reflects the worst contention seen (212s in one full run). Every test
  // below then keeps the ordinary timeout and stays a real signal: this hook
  // makes the guard reliable, it does not soften anything it checks.
  beforeAll(async () => {
    await lint("src/core/lib/__warmup__.ts", "export const warm = 1;\n");
  }, 300_000);

  // Every syntactic shape the defect has actually taken in this repo.
  const SHAPES: [name: string, code: string][] = [
    ["qualified window.confirm", `if (!window.confirm("q")) { /* */ }`],
    ["bare confirm", `if (!confirm("q")) { /* */ }`],
    ["bare alert", `alert("boom");`],
    ["qualified window.alert", `window.alert("boom");`],
    ["qualified window.prompt", `const a = window.prompt("q"); void a;`],
    ["bare prompt", `const b = prompt("q"); void b;`],
    ["globalThis alias", `globalThis.confirm("q");`],
    ["self alias", `self.confirm("q");`],
    // The shape that smuggled a raw global past review as a "feature probe":
    // not a call at all, so a call-expression-only rule would miss it.
    ["non-call reference", `const ok = typeof window.confirm === "function"; void ok;`],
  ];

  it.each(SHAPES)("rejects %s in src/", async (_name, code) => {
    const result = await lint("src/core/lib/__synthetic__.ts", `export function f() { ${code} }\n`);
    expect(dialogErrors(result).length).toBeGreaterThan(0);
  });

  it.each(SHAPES)("rejects %s in extensions/", async (_name, code) => {
    const result = await lint(
      "extensions/Charts/__synthetic__.ts",
      `export function f() { ${code} }\n`,
    );
    expect(dialogErrors(result).length).toBeGreaterThan(0);
  });

  it("names the sanctioned replacement in the message, not just the ban", async () => {
    const result = await lint(
      "src/core/lib/__synthetic__.ts",
      `export function f() { if (!window.confirm("q")) { /* */ } }\n`,
    );
    const message = result.messages.find((m) => DIALOG_RULES.has(m.ruleId ?? ""))?.message ?? "";
    expect(message).toContain("confirmAsync");
    expect(message).toContain("@api/dialogs");
    expect(message).toContain("AWAIT");
  });

  it("ACCEPTS the sanctioned wrappers, so the rule is not a blanket ban on asking", async () => {
    const result = await lint(
      "extensions/Charts/__synthetic__.ts",
      `import { confirmAsync, alertAsync, promptAsync } from "@api/dialogs";\n` +
        `export async function f() {\n` +
        `  if (!(await confirmAsync("q"))) return;\n` +
        `  await alertAsync("done");\n` +
        `  const name = await promptAsync("name?");\n` +
        `  void name;\n` +
        `}\n`,
    );
    expect(dialogErrors(result)).toEqual([]);
  });

  it("leaves an unrelated local named `alert` alone (scope-aware, unlike a text search)", async () => {
    const result = await lint(
      "src/core/lib/__synthetic__.ts",
      `export function f(alert: (m: string) => void) {\n` +
        `  const confirm = { ok: true };\n` +
        `  alert("this is a parameter, not the global");\n` +
        `  return confirm.ok;\n` +
        `}\n`,
    );
    expect(dialogErrors(result)).toEqual([]);
  });

  it("does not police TEST files, which legitimately stub the globals", async () => {
    const result = await lint(
      "src/core/lib/__tests__/__synthetic__.test.ts",
      `export function f() { window.confirm = () => true; }\n`,
    );
    expect(dialogErrors(result)).toEqual([]);
  });

  it("exempts ONLY the wrapper module itself", async () => {
    const wrapper = await lint(
      "src/core/lib/dialogs.ts",
      `export function f() { return window.confirm("q"); }\n`,
    );
    expect(dialogErrors(wrapper)).toEqual([]);

    // A neighbour in the same folder gets no such licence.
    const neighbour = await lint(
      "src/core/lib/dialogsHelper.ts",
      `export function f() { return window.confirm("q"); }\n`,
    );
    expect(dialogErrors(neighbour).length).toBeGreaterThan(0);
  });
});
