//! FILENAME: app/src/api/__tests__/scriptableObjects.test.ts
// PURPOSE: Tests for the ObjectScriptManager — mounting, unmounting, lifecycle, and context building.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ObjectScriptManager,
  resetObjectScriptManager,
} from "../scriptableObjects";
import type {
  ObjectScriptDefinition,
  ScriptableObjectType,
} from "../scriptableObjects";

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

  // ---------- Mounting ----------

  describe("mounting", () => {
    it("mounts a simple script", async () => {
      const script = makeScript("workbook", `
        function setup(ctx) {
          ctx.log("mounted!");
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);
      expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(true);
    });

    it("unmounts a script", async () => {
      const script = makeScript("workbook", "function setup(ctx) {}");
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);
      expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(true);

      ObjectScriptManager.unmountScript(script.id);
      expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(false);
    });

    it("calls teardown function on unmount", async () => {
      const teardownCalled = { value: false };
      // Use a global to communicate since the script runs in a sandboxed function
      (globalThis as Record<string, unknown>).__testTeardownCalled = teardownCalled;

      const script = makeScript("workbook", `
        function setup(ctx) {
          return function() {
            globalThis.__testTeardownCalled.value = true;
          };
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);
      ObjectScriptManager.unmountScript(script.id);

      expect(teardownCalled.value).toBe(true);
      delete (globalThis as Record<string, unknown>).__testTeardownCalled;
    });

    it("handles script compilation errors gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const script = makeScript("workbook", "function setup(ctx { INVALID SYNTAX }");
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);
      // Should not crash, but script should not be mounted
      expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(false);
      consoleError.mockRestore();
    });

    it("handles runtime errors gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const script = makeScript("workbook", `
        function setup(ctx) {
          throw new Error("boom");
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);
      expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(false);
      consoleError.mockRestore();
    });

    it("unmounts previous instance when re-mounting", async () => {
      let mountCount = 0;
      (globalThis as Record<string, unknown>).__testMountCount = { get: () => mountCount, inc: () => mountCount++ };

      const script = makeScript("workbook", `
        function setup(ctx) {
          globalThis.__testMountCount.inc();
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);
      await ObjectScriptManager.mountScript(script.id);
      expect(mountCount).toBe(2);
      expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(true);

      delete (globalThis as Record<string, unknown>).__testMountCount;
    });
  });

  // ---------- Reset ----------

  describe("reset", () => {
    it("unmounts all scripts and clears registrations", async () => {
      const s1 = makeScript("workbook", "function setup(ctx) {}");
      const s2 = makeScript("cell", "function setup(ctx) {}");
      ObjectScriptManager.registerScript(s1);
      ObjectScriptManager.registerScript(s2);
      await ObjectScriptManager.mountScript(s1.id);
      await ObjectScriptManager.mountScript(s2.id);

      expect(ObjectScriptManager.getAllScripts()).toHaveLength(2);
      expect(ObjectScriptManager.isScriptMounted(s1.id)).toBe(true);

      resetObjectScriptManager();
      expect(ObjectScriptManager.getAllScripts()).toHaveLength(0);
      expect(ObjectScriptManager.isScriptMounted(s1.id)).toBe(false);
    });
  });

  // ---------- Context Types ----------

  describe("context types", () => {
    it("provides correct objectType on context", async () => {
      (globalThis as Record<string, unknown>).__testObjectType = { value: "" };

      const script = makeScript("cell", `
        function setup(ctx) {
          globalThis.__testObjectType.value = ctx.objectType;
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      expect((globalThis as Record<string, unknown>).__testObjectType).toEqual({ value: "cell" });
      delete (globalThis as Record<string, unknown>).__testObjectType;
    });

    it("provides null api in restricted mode", async () => {
      (globalThis as Record<string, unknown>).__testApi = { value: "unset" };

      const script = makeScript("workbook", `
        function setup(ctx) {
          globalThis.__testApi.value = ctx.api;
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      expect((globalThis as Record<string, unknown>).__testApi).toEqual({ value: null });
      delete (globalThis as Record<string, unknown>).__testApi;
    });

    it("provides api object in unlocked mode", async () => {
      (globalThis as Record<string, unknown>).__testApi = { value: "unset" };

      const script = makeScript("workbook", `
        function setup(ctx) {
          globalThis.__testApi.value = typeof ctx.api;
        }
      `, { accessLevel: "unlocked" });
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      expect((globalThis as Record<string, unknown>).__testApi).toEqual({ value: "object" });
      delete (globalThis as Record<string, unknown>).__testApi;
    });

    it("expose() makes methods available", async () => {
      const script = makeScript("workbook", `
        function setup(ctx) {
          ctx.expose("greet", (name) => "Hello " + name);
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);
      // The exposed method is internal — we just verify no error
      expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(true);
    });
  });

  // ---------- Script Compilation Styles ----------

  describe("script compilation", () => {
    it("handles setup() function style", async () => {
      (globalThis as Record<string, unknown>).__testSetupCalled = { value: false };

      const script = makeScript("workbook", `
        function setup(context) {
          globalThis.__testSetupCalled.value = true;
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      expect((globalThis as Record<string, unknown>).__testSetupCalled).toEqual({ value: true });
      delete (globalThis as Record<string, unknown>).__testSetupCalled;
    });

    it("handles direct code style (no setup function)", async () => {
      (globalThis as Record<string, unknown>).__testDirectCalled = { value: false };

      const script = makeScript("workbook", `
        globalThis.__testDirectCalled.value = true;
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      expect((globalThis as Record<string, unknown>).__testDirectCalled).toEqual({ value: true });
      delete (globalThis as Record<string, unknown>).__testDirectCalled;
    });

    it("strips import statements", async () => {
      (globalThis as Record<string, unknown>).__testImportStripped = { value: false };

      const script = makeScript("workbook", `
        import type { WorkbookContext } from '@calcula/api'

        function setup(context) {
          globalThis.__testImportStripped.value = true;
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      expect((globalThis as Record<string, unknown>).__testImportStripped).toEqual({ value: true });
      delete (globalThis as Record<string, unknown>).__testImportStripped;
    });
  });

  // ---------- Inter-Script Communication ----------

  describe("inter-script communication", () => {
    it("allows scripts to expose and call methods across objects", async () => {
      (globalThis as Record<string, unknown>).__testCallResult = { value: "" };

      // Script 1: workbook script that exposes a "greet" method
      const s1 = makeScript("workbook", `
        function setup(ctx) {
          ctx.expose("greet", (name) => "Hello " + name);
        }
      `);

      // Script 2: cell script that calls the workbook's greet method
      const s2 = makeScript("cell", `
        function setup(ctx) {
          const result = ctx.callMethod("workbook", null, "greet", "World");
          globalThis.__testCallResult.value = result;
        }
      `);

      ObjectScriptManager.registerScript(s1);
      ObjectScriptManager.registerScript(s2);
      await ObjectScriptManager.mountScript(s1.id);
      await ObjectScriptManager.mountScript(s2.id);

      expect((globalThis as Record<string, unknown>).__testCallResult).toEqual({ value: "Hello World" });
      delete (globalThis as Record<string, unknown>).__testCallResult;
    });

    it("returns undefined for non-existent methods", async () => {
      (globalThis as Record<string, unknown>).__testMissing = { value: "not-set" };

      const script = makeScript("workbook", `
        function setup(ctx) {
          const result = ctx.callMethod("slicer", "999", "nonExistent");
          globalThis.__testMissing.value = result;
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      expect((globalThis as Record<string, unknown>).__testMissing).toEqual({ value: undefined });
      delete (globalThis as Record<string, unknown>).__testMissing;
    });

    it("cleans up exposed methods on unmount", async () => {
      const script = makeScript("workbook", `
        function setup(ctx) {
          ctx.expose("myMethod", () => 42);
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      // Method should be callable
      const { callExposedMethod } = await import("../scriptableObjects");
      expect(callExposedMethod("workbook", null, "myMethod")).toBe(42);

      // After unmount, method should be gone
      ObjectScriptManager.unmountScript(script.id);
      expect(callExposedMethod("workbook", null, "myMethod")).toBeUndefined();
    });
  });

  // ---------- API Versioning ----------

  describe("API versioning", () => {
    it("provides apiVersion on context", async () => {
      (globalThis as Record<string, unknown>).__testVersion = { value: "" };

      const script = makeScript("workbook", `
        function setup(ctx) {
          globalThis.__testVersion.value = ctx.apiVersion;
        }
      `);
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      const { SCRIPT_API_VERSION } = await import("../scriptableObjects");
      expect((globalThis as Record<string, unknown>).__testVersion).toEqual({ value: SCRIPT_API_VERSION });
      delete (globalThis as Record<string, unknown>).__testVersion;
    });

    it("rejects scripts with incompatible API version", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const script = makeScript("workbook", "function setup(ctx) {}", {
        requiredApiVersion: "99.0.0",
      });
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      // Should not mount due to version mismatch
      expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(false);
      consoleError.mockRestore();
    });

    it("accepts scripts with compatible API version", async () => {
      const { SCRIPT_API_VERSION } = await import("../scriptableObjects");
      const script = makeScript("workbook", "function setup(ctx) {}", {
        requiredApiVersion: SCRIPT_API_VERSION,
      });
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      expect(ObjectScriptManager.isScriptMounted(script.id)).toBe(true);
    });
  });

  // ---------- Batch Transactions ----------

  describe("batch transactions", () => {
    it("provides batch methods in unlocked mode", async () => {
      (globalThis as Record<string, unknown>).__testBatch = { hasBegin: false, hasCommit: false, hasCancel: false };

      const script = makeScript("workbook", `
        function setup(ctx) {
          globalThis.__testBatch.hasBegin = typeof ctx.api.beginBatch === "function";
          globalThis.__testBatch.hasCommit = typeof ctx.api.commitBatch === "function";
          globalThis.__testBatch.hasCancel = typeof ctx.api.cancelBatch === "function";
        }
      `, { accessLevel: "unlocked" });
      ObjectScriptManager.registerScript(script);
      await ObjectScriptManager.mountScript(script.id);

      expect((globalThis as Record<string, unknown>).__testBatch).toEqual({
        hasBegin: true,
        hasCommit: true,
        hasCancel: true,
      });
      delete (globalThis as Record<string, unknown>).__testBatch;
    });
  });
});
