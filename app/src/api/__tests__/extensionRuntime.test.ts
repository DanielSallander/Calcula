// PURPOSE: Pin the C2 contract — the host publishes its React instance as a
//          shared runtime singleton for runtime-loaded extensions, and does NOT
//          publish a global @api (scoping/sandbox-aligned).

import { describe, it, expect } from "vitest";
import React from "react";
import {
  exposeExtensionRuntimeGlobals,
  getExtensionReact,
  REACT_GLOBAL,
} from "../extensionRuntime";

describe("extensionRuntime (C2 shared React singleton)", () => {
  it("publishes the host React instance under the documented global", () => {
    exposeExtensionRuntimeGlobals();
    expect((globalThis as Record<string, unknown>)[REACT_GLOBAL]).toBe(React);
  });

  it("getExtensionReact returns the SAME React instance (so hooks/context work)", () => {
    exposeExtensionRuntimeGlobals();
    const shared = getExtensionReact();
    expect(shared).toBe(React);
    // A second bundled React would be a different object — the whole point is identity.
    expect(shared?.useState).toBe(React.useState);
  });

  it("does NOT publish a global @api facade (vision: scoped access via the injected context)", () => {
    exposeExtensionRuntimeGlobals();
    const g = globalThis as Record<string, unknown>;
    expect(g.CalculaAPI).toBeUndefined();
    expect(g["@api"]).toBeUndefined();
  });
});
