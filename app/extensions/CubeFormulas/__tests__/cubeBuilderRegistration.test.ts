//! FILENAME: app/extensions/CubeFormulas/__tests__/cubeBuilderRegistration.test.ts
// PURPOSE: The extension's half of the fx contract — that it contributes the
//          builder for EVERY CUBE function the engine actually ships, and takes
//          it back down on deactivate.
//
// WHY THE CATALOG IS READ FROM RUST AT TEST TIME.
// The list of CUBE functions lives in `core/parser/src/ast.rs`, where the
// function catalog is declared; `CUBE_FUNCTION_NAMES` here is a hand-written
// copy of the "Cube" slice of it. Two hand-kept lists drift, and this one drifts
// SILENTLY in the direction that matters: add an eighth CUBE function to the
// engine and it appears in the fx dialog with no builder behind it, so Insert
// hands the user a bare `=CUBEXYZ(` template for arguments that only the model
// can spell — which is the exact failure the builder exists to prevent. The
// direction is fixed Rust -> TypeScript, because Rust is where the function
// actually is.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@api/contract";
import {
  findFunctionBuilder,
  hasFunctionBuilder,
  resetFunctionBuilders,
} from "@api";
import extension from "../index";
import { CUBE_FUNCTION_NAMES } from "../components/CubeFormulaBuilderPanel";

/** Every function the Rust catalog files under the "Cube" category. */
function cubeFunctionsInRustCatalog(): string[] {
  const astPath = resolve(__dirname, "../../../../core/parser/src/ast.rs");
  const src = readFileSync(astPath, "utf8");
  const names: string[] = [];
  const re = /FunctionMeta::new\(\s*"([A-Z0-9_.]+)"\s*,\s*"Cube"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  return names;
}

function makeContext(): ExtensionContext {
  const noop = (): void => undefined;
  return {
    ui: { dialogs: { register: noop, unregister: noop } },
    events: { on: () => () => undefined },
  } as unknown as ExtensionContext;
}

describe("CUBE builder registration", () => {
  beforeEach(() => {
    resetFunctionBuilders();
    vi.restoreAllMocks();
  });

  it("covers exactly the Cube category the Rust catalog ships", () => {
    const fromRust = cubeFunctionsInRustCatalog();

    // A parse that finds nothing would make every assertion below vacuous.
    expect(fromRust.length).toBeGreaterThan(0);
    expect([...fromRust].sort()).toEqual([...CUBE_FUNCTION_NAMES].sort());
  });

  it("registers a builder for every one of them on activate", () => {
    extension.activate?.(makeContext());

    for (const name of cubeFunctionsInRustCatalog()) {
      expect(hasFunctionBuilder(name), `no builder for ${name}`).toBe(true);
    }
    // And for nothing else: SUM must keep the ordinary template path.
    expect(findFunctionBuilder("SUM")).toBeNull();
  });

  it("takes the builder back down on deactivate", () => {
    extension.activate?.(makeContext());
    expect(hasFunctionBuilder("CUBEVALUE")).toBe(true);

    extension.deactivate?.();

    // A disabled extension must leave fx working, not leave a dangling panel
    // that renders against a model nobody is loading any more.
    expect(hasFunctionBuilder("CUBEVALUE")).toBe(false);
  });
});
