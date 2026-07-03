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

  it("capability-bearing surfaces are worker-realm or the Rust-gated notebook", () => {
    for (const s of SCRIPT_SURFACES) {
      if (s.capabilities.length > 0) {
        // Worker-realm surfaces are broker-gated; the notebook (rust-quickjs)
        // is the ONE non-worker surface with capabilities — its gate is the
        // server-side CapabilityStore (see notebook-analysis-workbench.md).
        const rustGatedNotebook = s.id === "notebook-cell" && s.runtime === "rust-quickjs";
        expect(
          s.runtime === "worker-realm" || rustGatedNotebook,
          `unexpected capability-bearing surface: ${s.id} (${s.runtime})`,
        ).toBe(true);
      }
    }
  });

  it("the notebook carries EXACTLY the read-only model pair (anti-goal pin)", () => {
    // The analysis-workbench identity forbids net.fetch/storage/ui.html/
    // formula.udf on notebook cells — model reads only. A change here is a
    // deliberate security-design decision, not a drive-by.
    expect(getScriptSurface("notebook-cell")?.capabilities.slice().sort()).toEqual([
      "bi.query",
      "bi.sql",
    ]);
    expect(getScriptSurface("one-off-script")?.capabilities).toEqual([]);
  });

  it("getScriptSurface resolves by id", () => {
    expect(getScriptSurface("notebook-cell")?.runtime).toBe("rust-quickjs");
    expect(getScriptSurface("object-script")?.runtime).toBe("worker-realm");
    expect(getScriptSurface("nope" as ScriptSurfaceId)).toBeUndefined();
  });
});
