// Tests for the unified script-surface taxonomy (Wave 3 / C3). Keeps the
// in-app source of truth honest: every surface in the design doc is present,
// capabilities reference only the one vocabulary, and the executes-user-code
// split matches the documented taxonomy.

import { describe, it, expect } from "vitest";
import {
  SCRIPT_SURFACES,
  getScriptSurface,
  executableScriptSurfaces,
  scriptSurfacesReferenceOnlyKnownCapabilities,
  type ScriptSurfaceId,
} from "../scriptSurfaces";

describe("script-surface taxonomy", () => {
  it("covers exactly the documented surfaces", () => {
    const ids = SCRIPT_SURFACES.map((s) => s.id).sort();
    const expected: ScriptSurfaceId[] = [
      "chart-mark",
      "chart-transform",
      "chart-transform-sandbox",
      "formula-udf",
      "mcp-tool",
      "notebook-cell",
      "object-script",
      "one-off-script",
    ];
    expect(ids).toEqual(expected);
  });

  it("references only capabilities from the single vocabulary", () => {
    expect(scriptSurfacesReferenceOnlyKnownCapabilities()).toBe(true);
  });

  it("classifies which surfaces execute imperative user code", () => {
    const exec = executableScriptSurfaces()
      .map((s) => s.id)
      .sort();
    // Worker-realm user code runs: object scripts, UDFs, sandboxed chart marks +
    // transforms, notebooks, one-off scripts. The built-in chart-transform pipeline
    // (pure declarative) and MCP (first-party Rust) do not.
    expect(exec).toEqual([
      "chart-mark",
      "chart-transform-sandbox",
      "formula-udf",
      "notebook-cell",
      "object-script",
      "one-off-script",
    ]);
  });

  it("only the worker-realm surfaces carry grantable capabilities", () => {
    for (const s of SCRIPT_SURFACES) {
      if (s.capabilities.length > 0) {
        expect(s.runtime).toBe("worker-realm");
      }
    }
  });

  it("getScriptSurface resolves by id", () => {
    expect(getScriptSurface("notebook-cell")?.runtime).toBe("rust-quickjs");
    expect(getScriptSurface("object-script")?.runtime).toBe("worker-realm");
    expect(getScriptSurface("nope" as ScriptSurfaceId)).toBeUndefined();
  });
});
