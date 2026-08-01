// PURPOSE: Guard that the shared QuickJS type surface (_shared/lib/calcula.d.ts,
//          fed to the Notebook Monaco editor) documents EVERY op the Rust script
//          engine registers — all of them, from every ops module, with no
//          per-file allowlist to fall behind.
// CONTEXT: The notebook/one-off surface is the Rust QuickJS interpreter, whose
//          ops are registered as `something.set("name", ...)` in
//          core/script-engine/src/ops/*.rs. There is NO type information on the
//          Rust side — an op is a name bound to a native closure — so generating
//          the .d.ts from it would replace hand-written signatures and prose
//          with `(...args: any): any` and LOSE documentation. The drift guard is
//          therefore a TEST, not a generator; that is the deliberate choice, and
//          it is the option the object-script surface did not have (there the
//          shape IS typed TypeScript, so objectContexts.d.ts is generated —
//          see app/scripts/scriptTypings/).
//
//          WHAT CHANGED: the previous version enumerated three files by name
//          (extended.rs, worksheet_props.rs, and cells/sheets/utility) with
//          hard-coded counts, and matched only `function name(` in the .d.ts.
//          That silently skipped application.rs, bookmarks.rs and the 24
//          canonical_model.rs ops, and could not see a documented INTERFACE
//          MEMBER at all. It now reads the whole ops directory and extracts
//          declared names with the TypeScript compiler API, so a new ops FILE is
//          covered the moment it exists.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";

const OPS_DIR = path.resolve(__dirname, "../../../../core/script-engine/src/ops");
const ENGINE_SRC = path.resolve(__dirname, "../../../../core/script-engine/src");
const DTS_PATH = path.resolve(__dirname, "../../_shared/lib/calcula.d.ts");

const DTS = fs.readFileSync(DTS_PATH, "utf8");

/**
 * Op names registered from Rust: `X.set("name", ...)`.
 *
 * Letter-initial only, which deliberately skips the hidden `__calcula_*` native
 * sinks the JS glue wraps — those are an implementation detail no author can
 * call.
 */
function rustOpNames(file: string): string[] {
  const src = fs.readFileSync(path.join(OPS_DIR, file), "utf8");
  return [...src.matchAll(/\.set\(\s*"([a-zA-Z][a-zA-Z0-9_]*)"/g)].map((m) => m[1]);
}

/** Every ops module in the directory — no hard-coded list to fall behind. */
function opsFiles(): string[] {
  return fs
    .readdirSync(OPS_DIR)
    .filter((f) => f.endsWith(".rs") && f !== "mod.rs")
    .sort();
}

/**
 * Every name the .d.ts DECLARES, at any depth: top-level functions and consts,
 * namespace members, and interface/type-literal members. Parsed with the
 * TypeScript compiler API rather than matched with a regex, because the
 * previous regex could not see `getValue(): string;` inside an interface and so
 * reported 24 real declarations as missing.
 */
function declaredNames(): Set<string> {
  const sourceFile = ts.createSourceFile(path.basename(DTS_PATH), DTS, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  const add = (node: ts.Node | undefined): void => {
    if (!node) return;
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) names.add(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      add(node.name as ts.Node | undefined);
    }
    if (
      ts.isPropertySignature(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isEnumMember(node)
    ) {
      add(node.name as ts.Node | undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/**
 * KNOWN GAP, tracked not suppressed.
 *
 * `canonical_model.rs` puts these four on every NotebookRange (lines 134-137),
 * and the OBJECT-SCRIPT typings already declare all four on ScriptRange — so
 * the two runtimes' typings disagree about one canonical model. The fix is four
 * `readonly startRow: number;`-shaped lines in
 * app/extensions/_shared/lib/calcula.d.ts, which is not this extension's file.
 *
 * The exception RETIRES ITSELF: the test below fails if these ever become
 * documented, so whoever adds them is told to delete this list rather than
 * leaving a suppression behind.
 */
const UNDOCUMENTED_OPS: ReadonlyArray<readonly [file: string, op: string]> = [
  ["canonical_model.rs", "startRow"],
  ["canonical_model.rs", "startCol"],
  ["canonical_model.rs", "endRow"],
  ["canonical_model.rs", "endCol"],
];

function knownGapsFor(file: string): Set<string> {
  return new Set(UNDOCUMENTED_OPS.filter(([f]) => f === file).map(([, op]) => op));
}

describe("calcula.d.ts documents the whole QuickJS op surface", () => {
  const documented = declaredNames();
  const files = opsFiles();

  it("finds the ops directory and a plausible number of ops", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    const total = files.reduce((n, f) => n + rustOpNames(f).length, 0);
    // A floor, not a pin: a pinned count is a chore that gets bumped without
    // anyone opening the .d.ts. The per-file assertions below are the real gate.
    expect(total, "the op-name extraction stopped matching Rust registrations").toBeGreaterThanOrEqual(70);
  });

  it.each(opsFiles())("documents every op registered in %s", (file) => {
    const known = knownGapsFor(file);
    const missing = rustOpNames(file).filter((op) => !documented.has(op) && !known.has(op));
    expect(
      missing,
      `ops registered in core/script-engine/src/ops/${file} with no entry in ` +
        `app/extensions/_shared/lib/calcula.d.ts: ${missing.join(", ")}. ` +
        "Add them (with a signature and a sentence) — an undocumented op is an op no author can find.",
    ).toEqual([]);
  });

  it("keeps the known-gap list honest (it retires itself once the gap is closed)", () => {
    const stillMissing = UNDOCUMENTED_OPS.filter(([, op]) => !documented.has(op)).map(([, op]) => op);
    const nowDocumented = UNDOCUMENTED_OPS.filter(([, op]) => documented.has(op)).map(([, op]) => op);
    expect(
      nowDocumented,
      `these ops are now documented in calcula.d.ts — delete them from ` +
        `UNDOCUMENTED_OPS in this file so the gate goes back to being total: ${nowDocumented.join(", ")}`,
    ).toEqual([]);
    // And the entries must still name real, registered ops.
    const registered = new Set(opsFiles().flatMap((f) => rustOpNames(f)));
    for (const op of stillMissing) {
      expect(registered.has(op), `UNDOCUMENTED_OPS names \`${op}\`, which no ops module registers`).toBe(true);
    }
  });

  it("documents the model global (glue-installed, hidden native sinks)", () => {
    // model.* is installed via JS glue in core/script-engine/src/ops/model.rs;
    // the native sinks are hidden __calcula_model_* names the op extraction
    // (letter-initial) deliberately skips. Pin the JS-facing surface here.
    const modelSrc = fs.readFileSync(path.join(OPS_DIR, "model.rs"), "utf8");
    expect(modelSrc).toContain("globalThis.model");
    expect(DTS).toContain("declare namespace model");
    for (const fn of ["connections", "info", "query", "sql", "value", "members", "kpi"]) {
      expect(documented.has(fn), `model.${fn} missing from calcula.d.ts`).toBe(true);
    }
  });

  it("documents the display global (display.rs lives outside ops/)", () => {
    const displaySrc = fs.readFileSync(path.join(ENGINE_SRC, "display.rs"), "utf8");
    expect(displaySrc).toContain("globalThis.display");
    expect(DTS).toContain("declare namespace display");
    expect(documented.has("table"), "display.table missing from calcula.d.ts").toBe(true);
  });

  it("declares a VALUE for every global an author types, not only its type", () => {
    // The lesson from objectContexts.d.ts, applied here: a file full of
    // `declare interface` and no `declare const` gives Monaco nothing to
    // complete. Each notebook global must be reachable as a value.
    for (const globalName of ["model", "display"]) {
      expect(
        new RegExp(`declare\\s+(namespace|const|var|function)\\s+${globalName}\\b`).test(DTS),
        `\`${globalName}\` is documented as a type but never declared as a value, so ` +
          "typing it in the notebook editor completes to nothing",
      ).toBe(true);
    }
  });
});
