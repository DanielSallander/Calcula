/**
 * Type-level pin for `api.range()`'s return shape.
 *
 * A comma address answers a ScriptRangeAreas, a plain one answers a ScriptRange,
 * and the two objects deliberately do NOT share the rectangle ops — so the
 * declared type has to resolve to the right one. Every other test in this repo
 * checks the .d.ts as TEXT, which cannot tell whether a conditional type
 * actually resolves; this one runs the real compiler over the GENERATED
 * typings, which is the only thing that can.
 *
 * The negative cases matter as much as the positive ones: without them a
 * `RangeShapeFor` that collapsed to `any` would pass every positive assertion.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO = path.resolve(__dirname, "../../../../..");
const TYPINGS = path.join(REPO, "app/extensions/ScriptableObjects/objectContexts.d.ts");

/** Exact-type equality: assignability is too weak here (every ScriptRangeAreas
 *  case would pass against `ScriptRange | ScriptRangeAreas`). */
const PRELUDE = `
type __Eq<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
declare function __assert<T extends true>(): void;
declare const __api: UnlockedAPI;
declare const __dynamic: string;
`;

/** Compile the generated typings plus `snippet`, and return the errors raised
 *  inside the snippet only (the .d.ts itself is checked by check:script-typings). */
function typeCheck(snippet: string): string[] {
  const dts = fs.readFileSync(TYPINGS, "utf8");
  const files: Record<string, string> = {
    "typings.d.ts": dts,
    "case.ts": PRELUDE + snippet,
  };
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
    typeRoots: [],
    skipLibCheck: true,
  };
  const lib = path.dirname(require.resolve("typescript"));
  const host: ts.CompilerHost = {
    fileExists: (f) => f in files || fs.existsSync(f),
    readFile: (f) => files[f] ?? (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined),
    getSourceFile: (f, lang) => {
      const text = host.readFile(f);
      return text === undefined ? undefined : ts.createSourceFile(f, text, lang, true);
    },
    getDefaultLibFileName: () => path.join(lib, "lib.es2022.full.d.ts"),
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    getCanonicalFileName: (f) => f,
    getNewLine: () => "\n",
    useCaseSensitiveFileNames: () => false,
  };
  const program = ts.createProgram(["typings.d.ts", "case.ts"], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === "case.ts")
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

describe("api.range() resolves its return shape from the address", () => {
  it("compiles the generated typings at all (guards the harness itself)", () => {
    expect(typeCheck(`const __ok: number = 1; void __ok;`)).toEqual([]);
  });

  it("a literal single-area address is a ScriptRange, with nothing to narrow", () => {
    expect(
      typeCheck(`
        async function f() {
          const r = await __api.range("A1:B5");
          __assert<__Eq<typeof r, ScriptRange>>();
          // The whole point of the refinement: the rectangle ops are reachable
          // WITHOUT an \`if ("areas" in r)\` dance.
          await r.setValue("x");
          await r.select();
        }
        void f;
      `),
    ).toEqual([]);
  });

  it("a literal comma address is a ScriptRangeAreas, also with nothing to narrow", () => {
    expect(
      typeCheck(`
        async function f() {
          const r = await __api.range("A1:B2,D4:E5");
          __assert<__Eq<typeof r, ScriptRangeAreas>>();
          await r.format({ bold: true });
          await r.areas[0].setValues([["1"]]);
        }
        void f;
      `),
    ).toEqual([]);
  });

  it("a sheet-prefixed comma address is still multi-area", () => {
    expect(
      typeCheck(`
        async function f() {
          const r = await __api.range("Data!A1:B2,D4:E5");
          __assert<__Eq<typeof r, ScriptRangeAreas>>();
        }
        void f;
      `),
    ).toEqual([]);
  });

  it("a RUNTIME-built address is the union and must be narrowed", () => {
    expect(
      typeCheck(`
        async function f() {
          const r = await __api.range(__dynamic);
          __assert<__Eq<typeof r, ScriptRange | ScriptRangeAreas>>();
          if ("areas" in r) {
            __assert<__Eq<typeof r, ScriptRangeAreas>>();
          } else {
            __assert<__Eq<typeof r, ScriptRange>>();
          }
        }
        void f;
      `),
    ).toEqual([]);
  });

  // ---- teeth: these MUST fail to compile ----

  it("REFUSES a rectangle op on a multi-area range at compile time", () => {
    // This is contract (d) enforced by the type system: applying setValues to a
    // comma address would otherwise be the silent first-area-only bug.
    const errors = typeCheck(`
      async function f() {
        const r = await __api.range("A1:B2,D4:E5");
        await r.setValues([["1"]]);
      }
      void f;
    `);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/setValues/);
  });

  it("REFUSES the rectangle ops on an un-narrowed dynamic address", () => {
    const errors = typeCheck(`
      async function f() {
        const r = await __api.range(__dynamic);
        await r.setValue("x");
      }
      void f;
    `);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("does not collapse to any (a positive-only suite would miss this)", () => {
    const errors = typeCheck(`
      async function f() {
        const r = await __api.range("A1:B5");
        __assert<__Eq<typeof r, ScriptRangeAreas>>();
      }
      void f;
    `);
    expect(errors.length).toBeGreaterThan(0);
  });
});
