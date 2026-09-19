//! FILENAME: app/src/api/__tests__/functionBuilders.test.ts
// PURPOSE: The function-argument-builder seam — the contract the fx dialog and
//          the CUBE extension meet across.
//
// WHAT IS ACTUALLY AT RISK HERE. The registry is keyed by function NAME, and
// the two ends spell names differently: the catalog ships "CUBEVALUE" upper
// case, while an extension registering by hand may not. A lookup miss is not an
// error anywhere — it silently degrades to the plain template path, which is
// exactly the behaviour a function with no builder is supposed to have. So a
// case mismatch would look like "the builder just never appears", with nothing
// logged. Hence the normalization, and hence these tests.

import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import {
  registerFunctionBuilder,
  findFunctionBuilder,
  hasFunctionBuilder,
  subscribeToFunctionBuilders,
  resetFunctionBuilders,
  type FunctionBuilderRegistration,
} from "../functionBuilders";

const Panel: React.ComponentType<never> = () => null;

function reg(id: string, functions: string[]): FunctionBuilderRegistration {
  return { id, functions, component: Panel as FunctionBuilderRegistration["component"] };
}

describe("function builder seam", () => {
  beforeEach(() => {
    resetFunctionBuilders();
  });

  it("finds a builder by any casing of the function name", () => {
    registerFunctionBuilder(reg("cube", ["CUBEVALUE", "cubemember"]));

    expect(findFunctionBuilder("CUBEVALUE")?.id).toBe("cube");
    expect(findFunctionBuilder("cubevalue")?.id).toBe("cube");
    expect(findFunctionBuilder("CubeValue")?.id).toBe("cube");
    // Registered lower case, looked up the way the catalog spells it.
    expect(findFunctionBuilder("CUBEMEMBER")?.id).toBe("cube");
    expect(hasFunctionBuilder("cubeMember")).toBe(true);
  });

  it("returns null for a function with no builder, rather than throwing", () => {
    registerFunctionBuilder(reg("cube", ["CUBEVALUE"]));

    // SUM must keep the template path. A throw here would take out the whole
    // Insert button for every ordinary function.
    expect(findFunctionBuilder("SUM")).toBeNull();
    expect(hasFunctionBuilder("SUM")).toBe(false);
  });

  it("unregisters only the names still pointing at that registration", () => {
    const stale = registerFunctionBuilder(reg("v1", ["CUBEVALUE"]));
    registerFunctionBuilder(reg("v2", ["CUBEVALUE"]));

    // A re-activated extension replaced the entry; the OLD cleanup then runs.
    stale();

    expect(findFunctionBuilder("CUBEVALUE")?.id).toBe("v2");
  });

  it("removes a builder when its own unregister runs", () => {
    const off = registerFunctionBuilder(reg("cube", ["CUBEVALUE", "CUBESET"]));
    expect(hasFunctionBuilder("CUBESET")).toBe(true);

    off();

    expect(findFunctionBuilder("CUBEVALUE")).toBeNull();
    expect(findFunctionBuilder("CUBESET")).toBeNull();
  });

  it("notifies subscribers on register and on unregister", () => {
    // The fx dialog mounts before extensions activate, so without this the
    // builder would be invisible for the rest of the session.
    let ticks = 0;
    const off = subscribeToFunctionBuilders(() => {
      ticks += 1;
    });

    const unregister = registerFunctionBuilder(reg("cube", ["CUBEVALUE"]));
    expect(ticks).toBe(1);

    unregister();
    expect(ticks).toBe(2);

    // A no-op unregister must not fire — nothing changed.
    unregister();
    expect(ticks).toBe(2);

    off();
    registerFunctionBuilder(reg("cube", ["CUBEVALUE"]));
    expect(ticks).toBe(2);
  });

  it("survives a throwing subscriber", () => {
    subscribeToFunctionBuilders(() => {
      throw new Error("listener blew up");
    });
    let reached = false;
    subscribeToFunctionBuilders(() => {
      reached = true;
    });

    expect(() => registerFunctionBuilder(reg("cube", ["CUBEVALUE"]))).not.toThrow();
    expect(reached).toBe(true);
    expect(hasFunctionBuilder("CUBEVALUE")).toBe(true);
  });
});
