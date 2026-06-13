//! FILENAME: app/src/api/__tests__/scriptableObjects.test.ts
// PURPOSE: Tests for the ObjectScriptManager — registration lifecycle and the
//          broker-backed exposed-method helpers.
// NOTE: Object scripts now execute ONLY in per-script Web Worker realms
//       (sandbox Phase 3). jsdom (the vitest env) has no Worker, so mounting
//       cannot run here — mount/context behavior is covered by e2e specs
//       (app/e2e/tests/worker-realm-blit.spec.ts, scriptable-objects.spec.ts).
//       The tests below exercise only the path-independent surface:
//       registration bookkeeping and the host-side exposed-method registry.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ObjectScriptManager,
  resetObjectScriptManager,
  callExposedMethod,
  listExposedMethods,
} from "../scriptableObjects";
import type {
  ObjectScriptDefinition,
  ScriptableObjectType,
} from "../scriptableObjects";
import { buildHandleFromDefinition, registerExposed } from "../scriptHost/broker";

// ============================================================================
// Helpers
// ============================================================================

function makeScript(
  objectType: ScriptableObjectType,
  source: string,
  overrides?: Partial<ObjectScriptDefinition>,
): ObjectScriptDefinition {
  return {
    id: crypto.randomUUID(),
    name: `${objectType} test script`,
    objectType,
    instanceId: null,
    source,
    accessLevel: "restricted",
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("ObjectScriptManager", () => {
  beforeEach(() => {
    resetObjectScriptManager();
  });

  // ---------- Registration ----------

  describe("registration", () => {
    it("registers a script", () => {
      const script = makeScript("workbook", "function setup(ctx) {}");
      ObjectScriptManager.registerScript(script);
      expect(ObjectScriptManager.getAllScripts()).toHaveLength(1);
      expect(ObjectScriptManager.getAllScripts()[0].id).toBe(script.id);
    });

    it("retrieves script by type for primitives", () => {
      const script = makeScript("cell", "function setup(ctx) {}");
      ObjectScriptManager.registerScript(script);
      const found = ObjectScriptManager.getScript("cell");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(script.id);
    });

    it("retrieves script by type + instanceId for components", () => {
      const script = makeScript("slicer", "function setup(ctx) {}", {
        instanceId: "slicer-42",
      });
      ObjectScriptManager.registerScript(script);

      // Should find by type + instanceId
      expect(ObjectScriptManager.getScript("slicer", "slicer-42")).not.toBeNull();
      // Should NOT find without instanceId
      expect(ObjectScriptManager.getScript("slicer")).toBeNull();
      // Should NOT find with wrong instanceId
      expect(ObjectScriptManager.getScript("slicer", "slicer-99")).toBeNull();
    });

    it("removes a script", () => {
      const script = makeScript("sheet", "function setup(ctx) {}");
      ObjectScriptManager.registerScript(script);
      expect(ObjectScriptManager.getAllScripts()).toHaveLength(1);

      ObjectScriptManager.removeScript(script.id);
      expect(ObjectScriptManager.getAllScripts()).toHaveLength(0);
    });

    it("notifies listeners on change", () => {
      const listener = vi.fn();
      const unsub = ObjectScriptManager.onScriptChange(listener);

      const script = makeScript("workbook", "function setup(ctx) {}");
      ObjectScriptManager.registerScript(script);
      expect(listener).toHaveBeenCalledTimes(1);

      ObjectScriptManager.removeScript(script.id);
      expect(listener).toHaveBeenCalledTimes(2);

      unsub();
      ObjectScriptManager.registerScript(script);
      expect(listener).toHaveBeenCalledTimes(2); // No more calls after unsub
    });
  });

  // ---------- Exposed-method registry (broker-backed) ----------
  // These exercise callExposedMethod/listExposedMethods directly against the
  // broker's exposed-method registry — no script mount (and thus no Worker)
  // is required, so they run under jsdom.

  describe("exposed methods", () => {
    it("calls a method registered with the broker", () => {
      const handle = buildHandleFromDefinition(
        makeScript("workbook", ""),
      );
      registerExposed(handle, "greet", (name) => "Hello " + name, false);

      expect(callExposedMethod("workbook", null, "greet", "World")).toBe("Hello World");
    });

    it("returns undefined for a method that was not registered", () => {
      expect(callExposedMethod("slicer", "999", "nonExistent")).toBeUndefined();
    });

    it("lists registered exposed methods", () => {
      const handle = buildHandleFromDefinition(
        makeScript("workbook", ""),
      );
      registerExposed(handle, "myMethod", () => 42, false);

      const listed = listExposedMethods();
      expect(listed).toContainEqual({
        objectType: "workbook",
        instanceId: null,
        methodName: "myMethod",
      });
    });

    it("drops exposed methods when the registration cleanup runs", () => {
      const handle = buildHandleFromDefinition(
        makeScript("workbook", ""),
      );
      const cleanup = registerExposed(handle, "myMethod", () => 42, false);

      expect(callExposedMethod("workbook", null, "myMethod")).toBe(42);

      cleanup();
      expect(callExposedMethod("workbook", null, "myMethod")).toBeUndefined();
    });
  });
});
