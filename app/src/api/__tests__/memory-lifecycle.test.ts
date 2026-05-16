//! FILENAME: app/src/api/__tests__/memory-lifecycle.test.ts
// PURPOSE: Detect potential memory leaks through lifecycle patterns.
// CONTEXT: Verifies that subscribe/unsubscribe, register/unregister cycles
//          leave no residual state in API registries.

import { describe, it, expect, beforeEach } from "vitest";
import { onAppEvent, emitAppEvent, AppEvents } from "../events";
import {
  subscribeToSettings,
  registerSettingDefinitions,
  getAllSettingDefinitions,
} from "../settings";
import {
  registerStyleInterceptor,
  getStyleInterceptors,
  hasStyleInterceptors,
  clearDirtyState,
} from "../styleInterceptors";
import {
  registerGridOverlay,
  setGridRegions,
  getGridRegions,
  addGridRegions,
  removeGridRegionsByType,
  onRegionChange,
  getOverlayRenderers,
  registerPostHeaderOverlay,
  getPostHeaderOverlayRenderers,
} from "../gridOverlays";

// ============================================================================
// Event Subscription Lifecycle
// ============================================================================

describe("Event subscription lifecycle", () => {
  it("subscribe/unsubscribe 2K times leaves no lingering listeners", () => {
    const eventName = AppEvents.GRID_REFRESH;
    const callbacks: (() => void)[] = [];

    // Subscribe 2K listeners
    for (let i = 0; i < 2_000; i++) {
      callbacks.push(onAppEvent(eventName, () => {}));
    }

    // Unsubscribe all
    for (const unsub of callbacks) {
      unsub();
    }

    // Verify: emitting the event should not trigger any callback
    let callCount = 0;
    const probe = onAppEvent(eventName, () => {
      callCount++;
    });
    emitAppEvent(eventName);
    expect(callCount).toBe(1); // Only our probe fires
    probe();
  });

  it("double-unsubscribe is safe", () => {
    const unsub = onAppEvent(AppEvents.DATA_CHANGED, () => {});
    unsub();
    unsub(); // Should not throw
  });

  it("interleaved subscribe/unsubscribe leaves correct listener count", () => {
    const unsubs: (() => void)[] = [];
    let count = 0;

    for (let i = 0; i < 1000; i++) {
      unsubs.push(onAppEvent(AppEvents.SELECTION_CHANGED, () => { count++; }));
    }

    // Unsubscribe odd-indexed
    for (let i = 1; i < unsubs.length; i += 2) {
      unsubs[i]();
    }

    count = 0;
    emitAppEvent(AppEvents.SELECTION_CHANGED);
    expect(count).toBe(500);

    // Clean up remaining
    for (let i = 0; i < unsubs.length; i += 2) {
      unsubs[i]();
    }

    count = 0;
    emitAppEvent(AppEvents.SELECTION_CHANGED);
    expect(count).toBe(0);
  });
});

// ============================================================================
// Command Registry Lifecycle
// ============================================================================

describe("Command registry lifecycle", () => {
  // Import the concrete implementation to access .clear()
  let CommandRegistry: typeof import("../commands").CommandRegistry;

  beforeEach(async () => {
    const mod = await import("../commands");
    CommandRegistry = mod.CommandRegistry;
    // Cast to access internal clear method
    (CommandRegistry as any).clear?.();
  });

  it("register/unregister 1K commands leaves registry empty", () => {
    for (let i = 0; i < 1000; i++) {
      CommandRegistry.register(`test.cmd.${i}`, () => {});
    }

    for (let i = 0; i < 1000; i++) {
      CommandRegistry.unregister(`test.cmd.${i}`);
    }

    // Verify none of our test commands remain
    for (let i = 0; i < 1000; i++) {
      expect(CommandRegistry.has(`test.cmd.${i}`)).toBe(false);
    }
  });

  it("unregistering non-existent command is safe", () => {
    CommandRegistry.unregister("nonexistent.command");
    expect(CommandRegistry.has("nonexistent.command")).toBe(false);
  });

  it("re-register overwrites cleanly", () => {
    let callA = 0;
    let callB = 0;

    CommandRegistry.register("test.overwrite", () => { callA++; });
    CommandRegistry.register("test.overwrite", () => { callB++; });

    CommandRegistry.execute("test.overwrite");
    // Only the second handler should be effective
    expect(callA).toBe(0);
    expect(callB).toBe(1);

    CommandRegistry.unregister("test.overwrite");
    expect(CommandRegistry.has("test.overwrite")).toBe(false);
  });
});

// ============================================================================
// Settings Listeners Lifecycle
// ============================================================================

describe("Settings listeners lifecycle", () => {
  it("subscribe/unsubscribe settings listeners does not accumulate", () => {
    const unsubs: (() => void)[] = [];

    for (let i = 0; i < 500; i++) {
      unsubs.push(subscribeToSettings(() => {}));
    }

    for (const unsub of unsubs) {
      unsub();
    }

    // After cleanup, registering a setting should not trigger 500 stale listeners
    let callCount = 0;
    const probe = subscribeToSettings(() => { callCount++; });
    const cleanup = registerSettingDefinitions("test-ext", [
      { key: "probe", label: "Probe", type: "boolean", defaultValue: false },
    ]);
    expect(callCount).toBe(1); // Only our probe
    probe();
    cleanup();
  });

  it("registerSettingDefinitions cleanup removes definitions", () => {
    const cleanups: (() => void)[] = [];

    for (let i = 0; i < 100; i++) {
      cleanups.push(
        registerSettingDefinitions(`ext-${i}`, [
          { key: "k", label: "K", type: "string", defaultValue: "" },
        ])
      );
    }

    const beforeCount = getAllSettingDefinitions().length;
    expect(beforeCount).toBeGreaterThanOrEqual(100);

    for (const cleanup of cleanups) {
      cleanup();
    }

    // All our test definitions should be gone
    const remaining = getAllSettingDefinitions().filter(
      (d) => d.extensionId.startsWith("ext-")
    );
    expect(remaining.length).toBe(0);
  });
});

// ============================================================================
// Style Interceptor Registry Lifecycle
// ============================================================================

describe("Style interceptor registry lifecycle", () => {
  beforeEach(() => {
    clearDirtyState();
  });

  it("register/unregister 500 interceptors leaves registry empty", () => {
    const cleanups: (() => void)[] = [];

    for (let i = 0; i < 500; i++) {
      cleanups.push(
        registerStyleInterceptor(`interceptor-${i}`, () => null, i)
      );
    }

    expect(hasStyleInterceptors()).toBe(true);
    expect(getStyleInterceptors().length).toBe(500);

    for (const cleanup of cleanups) {
      cleanup();
    }

    expect(hasStyleInterceptors()).toBe(false);
    expect(getStyleInterceptors().length).toBe(0);
  });

  it("cleanup function is idempotent", () => {
    const cleanup = registerStyleInterceptor("once", () => null);
    cleanup();
    cleanup(); // Should not throw or corrupt state
    expect(hasStyleInterceptors()).toBe(false);
  });
});

// ============================================================================
// Overlay Registry Lifecycle
// ============================================================================

describe("Overlay registry lifecycle", () => {
  beforeEach(() => {
    setGridRegions([]);
  });

  it("register/unregister overlay renderers leaves registry empty", () => {
    const cleanups: (() => void)[] = [];

    for (let i = 0; i < 100; i++) {
      cleanups.push(
        registerGridOverlay({
          type: `test-overlay-${i}`,
          render: () => {},
        })
      );
    }

    expect(getOverlayRenderers().length).toBe(100);

    for (const cleanup of cleanups) {
      cleanup();
    }

    expect(getOverlayRenderers().length).toBe(0);
  });

  it("postHeaderOverlay register/unregister cycle is clean", () => {
    const cleanups: (() => void)[] = [];

    for (let i = 0; i < 50; i++) {
      cleanups.push(registerPostHeaderOverlay(`post-${i}`, () => {}));
    }

    expect(getPostHeaderOverlayRenderers().length).toBe(50);

    for (const cleanup of cleanups) {
      cleanup();
    }

    expect(getPostHeaderOverlayRenderers().length).toBe(0);
  });
});

// ============================================================================
// Grid Region Lifecycle
// ============================================================================

describe("Grid region lifecycle", () => {
  beforeEach(() => {
    setGridRegions([]);
  });

  it("add then remove regions by type leaves empty list", () => {
    for (let i = 0; i < 200; i++) {
      addGridRegions([
        { id: `r-${i}`, type: "test", startRow: i, startCol: 0, endRow: i, endCol: 5 },
      ]);
    }

    expect(getGridRegions().length).toBe(200);

    removeGridRegionsByType("test");
    expect(getGridRegions().length).toBe(0);
  });

  it("setGridRegions replaces all existing regions", () => {
    addGridRegions([
      { id: "old-1", type: "old", startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    ]);

    setGridRegions([
      { id: "new-1", type: "new", startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    ]);

    const regions = getGridRegions();
    expect(regions.length).toBe(1);
    expect(regions[0].id).toBe("new-1");
  });

  it("region change listeners cleanup", () => {
    const unsubs: (() => void)[] = [];
    let callCount = 0;

    for (let i = 0; i < 200; i++) {
      unsubs.push(onRegionChange(() => { callCount++; }));
    }

    callCount = 0;
    setGridRegions([]);
    expect(callCount).toBe(200);

    for (const unsub of unsubs) {
      unsub();
    }

    callCount = 0;
    setGridRegions([]);
    expect(callCount).toBe(0);
  });
});
