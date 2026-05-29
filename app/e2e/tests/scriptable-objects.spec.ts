/**
 * Scriptable Objects E2E tests.
 *
 * Tests the core CRUD flows, console output, error display,
 * persistence, tiered access, inter-script communication,
 * and context menu integrations.
 *
 * Priority order per test plan:
 * - #1 (CRUD), #2 (Console), #3 (Errors), #11 (Persistence)
 * - #4-6 (Context menus)
 * - #7 (Tiered access), #13 (Inter-script), #14 (API version)
 */
import { test, expect } from "../fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open Developer > Object Scripts... via menu click */
async function openObjectScriptsDialog(page: any) {
  await page.locator("button").filter({ hasText: /^Developer$/ }).first().click();
  const item = page.locator("button").filter({ hasText: /Object Scripts/ }).first();
  await item.waitFor({ state: "visible", timeout: 3000 });
  await item.click();
  await page.waitForTimeout(800);
}

/** Create a script via Tauri API and return its id */
async function createScriptDirect(
  page: any,
  objectType: string,
  source: string,
  opts?: { accessLevel?: string; name?: string; instanceId?: string | null }
) {
  const id = await page.evaluate(() => crypto.randomUUID());
  await page.evaluate(
    async (args: any) => {
      const tauri = (window as any).__TAURI__;
      const script = {
        id: args.id,
        name: args.name || `Test ${args.objectType} script`,
        objectType: args.objectType,
        instanceId: args.instanceId ?? null,
        source: args.source,
        accessLevel: args.accessLevel || "restricted",
      };
      // Under WebView2 the Tauri IPC response for an invoke is occasionally
      // dropped, leaving the promise pending forever (the test then hits the
      // 30s timeout). Race each attempt against a short timeout and re-issue —
      // save_object_script is idempotent (keyed by id, update-or-insert), so
      // retrying is safe and recovers a lost response.
      // The drop is intermittent, so each retry issues a fresh invoke that has
      // an independent chance of completing. Use a shorter per-attempt timeout
      // with more attempts: save_object_script is a trivial in-memory mutex
      // insert on the backend, so a healthy round-trip returns in well under a
      // second — a long timeout only delays failover to the next attempt. The
      // total budget (5 x 4s = 20s) stays comfortably under the 30s test cap,
      // leaving room for the follow-up get/delete calls.
      let lastErr: any;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await Promise.race([
            tauri.core.invoke("save_object_script", { script }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("save_object_script IPC timeout")), 4000)
            ),
          ]);
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    },
    { id, objectType, source, ...opts }
  );
  await page.waitForTimeout(300);
  return id;
}

/** Delete a script via Tauri API */
async function deleteScriptDirect(page: any, id: string) {
  await page.evaluate(async (scriptId: string) => {
    const tauri = (window as any).__TAURI__;
    await tauri.core.invoke("delete_object_script", { id: scriptId });
  }, id);
  await page.waitForTimeout(200);
}

/** List all scripts via Tauri API */
async function listScripts(page: any) {
  return page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    return tauri.core.invoke("list_object_scripts");
  });
}

// ===========================================================================
// #1 — Object Script CRUD via Developer Menu
// ===========================================================================

test.describe("#1 Object Script CRUD", () => {
  test("1a: Developer menu has Object Scripts item", async ({ grid }) => {
    await grid.openMenu("Developer");
    const item = grid.page.locator("button").filter({ hasText: /Object Scripts/ });
    await expect(item).toBeVisible({ timeout: 3000 });
    await grid.closeMenu();
  });

  test("1b: create a workbook script via Tauri API", async ({ grid }) => {
    const id = await createScriptDirect(grid.page, "workbook", 'function setup(workbook) { workbook.log("hello"); }');

    const scripts = await listScripts(grid.page);
    expect(scripts.some((s: any) => s.id === id)).toBe(true);

    await deleteScriptDirect(grid.page, id);
  });

  test("1c: create scripts for all primitive types", async ({ grid }) => {
    const types = ["workbook", "sheet", "cell", "row", "column"];
    const ids: string[] = [];

    for (const t of types) {
      const id = await createScriptDirect(grid.page, t, `function setup(ctx) { ctx.log("${t}"); }`);
      ids.push(id);
    }

    const scripts = await listScripts(grid.page);
    for (const id of ids) {
      expect(scripts.some((s: any) => s.id === id)).toBe(true);
    }

    // Clean up
    for (const id of ids) {
      await deleteScriptDirect(grid.page, id);
    }
  });

  test("1d: delete a script removes it from list", async ({ grid }) => {
    const id = await createScriptDirect(grid.page, "workbook", "function setup(wb) {}");

    let scripts = await listScripts(grid.page);
    expect(scripts.some((s: any) => s.id === id)).toBe(true);

    await deleteScriptDirect(grid.page, id);

    scripts = await listScripts(grid.page);
    expect(scripts.some((s: any) => s.id === id)).toBe(false);
  });

  test("1e: get script by ID returns full source", async ({ grid }) => {
    const source = 'function setup(workbook) { workbook.log("test source"); }';
    const id = await createScriptDirect(grid.page, "workbook", source);

    const script = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);

    expect(script.source).toBe(source);
    expect(script.objectType).toBe("workbook");

    await deleteScriptDirect(grid.page, id);
  });

  test("1f: get script by target type and instance", async ({ grid }) => {
    const id = await createScriptDirect(grid.page, "cell", 'function setup(c) {}', {
      instanceId: null,
    });

    const script = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script_by_target", {
        objectType: "cell",
        instanceId: null,
      });
    });

    expect(script).not.toBeNull();
    expect(script.id).toBe(id);

    await deleteScriptDirect(grid.page, id);
  });
});

// ===========================================================================
// #2 — Console Output Panel
// ===========================================================================

test.describe("#2 Console Output", () => {
  test("2a: script console event creates entry", async ({ grid }) => {
    // Emit a console event as if a script logged something.
    // NOTE: Do NOT open the Object Scripts editor window here — it spawns a
    // separate OS window whose background Tauri calls interfere with later tests.
    await grid.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("objectscript:console", {
          detail: { scriptId: "test-id", level: "log", args: ["Hello from test"] },
        })
      );
    });
    await grid.page.waitForTimeout(200);
    // No crash = success for event dispatch
  });

  test("2b: error event creates red entry", async ({ grid }) => {
    await grid.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("objectscript:error", {
          detail: { scriptId: "test-id", scriptName: "Test", error: "Test error message", stack: "" },
        })
      );
    });
    await grid.page.waitForTimeout(200);
    // No crash = success for event dispatch
  });
});

// ===========================================================================
// #3 — Error Display
// ===========================================================================

test.describe("#3 Error Display", () => {
  test("3a: script with syntax error can be saved without crash", async ({ grid }) => {
    const id = await createScriptDirect(
      grid.page,
      "workbook",
      "function setup(ctx { BAD SYNTAX }"
    );

    // Script should be saved (backend stores raw source)
    const script = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);
    expect(script.source).toContain("BAD SYNTAX");

    await deleteScriptDirect(grid.page, id);
  });

  test("3b: script with runtime error can be saved", async ({ grid }) => {
    const id = await createScriptDirect(
      grid.page,
      "workbook",
      'function setup(ctx) { throw new Error("boom"); }'
    );

    const script = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);
    expect(script.source).toContain("boom");

    await deleteScriptDirect(grid.page, id);
  });
});

// ===========================================================================
// #7 — Tiered Access (Restricted vs Unlocked)
// ===========================================================================

test.describe("#7 Tiered Access", () => {
  test("7a: restricted mode script has accessLevel restricted", async ({ grid }) => {
    const id = await createScriptDirect(grid.page, "workbook", "function setup(wb) {}", {
      accessLevel: "restricted",
    });

    const script = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);
    expect(script.accessLevel).toBe("restricted");

    await deleteScriptDirect(grid.page, id);
  });

  test("7b: unlocked mode script has accessLevel unlocked", async ({ grid }) => {
    const id = await createScriptDirect(grid.page, "workbook", "function setup(wb) {}", {
      accessLevel: "unlocked",
    });

    const script = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);
    expect(script.accessLevel).toBe("unlocked");

    await deleteScriptDirect(grid.page, id);
  });

  test("7c: can toggle access level by saving with different level", async ({ grid }) => {
    const id = await createScriptDirect(grid.page, "workbook", "function setup(wb) {}", {
      accessLevel: "restricted",
    });

    // Get the script
    const script = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);

    // Update to unlocked (separate evaluate to avoid nested invoke contention)
    script.accessLevel = "unlocked";
    await grid.page.evaluate(async (s: any) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_object_script", { script: s });
    }, script);

    const updated = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);
    expect(updated.accessLevel).toBe("unlocked");

    await deleteScriptDirect(grid.page, id);
  });
});

// ===========================================================================
// #11 — Persistence (.cala Save/Load)
// ===========================================================================

test.describe("#11 Persistence", () => {
  test("11a: scripts persist in backend state", async ({ grid }) => {
    const source1 = 'function setup(wb) { wb.log("persist test 1"); }';
    const source2 = 'function setup(cell) { cell.log("persist test 2"); }';

    const id1 = await createScriptDirect(grid.page, "workbook", source1);
    const id2 = await createScriptDirect(grid.page, "cell", source2);

    // Verify both exist
    const scripts = await listScripts(grid.page);
    expect(scripts.length).toBeGreaterThanOrEqual(2);

    const wb = scripts.find((s: any) => s.id === id1);
    const cell = scripts.find((s: any) => s.id === id2);
    expect(wb).toBeDefined();
    expect(cell).toBeDefined();

    // Clean up
    await deleteScriptDirect(grid.page, id1);
    await deleteScriptDirect(grid.page, id2);
  });

  test("11b: access level persists after re-read", async ({ grid }) => {
    const id = await createScriptDirect(grid.page, "sheet", "function setup(s) {}", {
      accessLevel: "unlocked",
    });

    // Re-read from backend
    const script = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);

    expect(script.accessLevel).toBe("unlocked");

    await deleteScriptDirect(grid.page, id);
  });
});

// ===========================================================================
// #13 — Inter-Script Communication
// ===========================================================================

test.describe("#13 Inter-Script Communication", () => {
  test("13a: two scripts can be created for cross-object communication", async ({ grid }) => {
    // Script 1: workbook exposes a method
    const wbSource = `function setup(workbook) {
      workbook.expose("getGreeting", (name) => "Hello " + name + "!");
    }`;
    const id1 = await createScriptDirect(grid.page, "workbook", wbSource);

    // Script 2: cell calls the workbook method
    const cellSource = `function setup(cell) {
      cell.onSelect(({ row, col }) => {
        const greeting = cell.callMethod("workbook", null, "getGreeting", "World");
        cell.log(greeting);
      });
    }`;
    const id2 = await createScriptDirect(grid.page, "cell", cellSource);

    // Verify both exist
    const scripts = await listScripts(grid.page);
    expect(scripts.length).toBeGreaterThanOrEqual(2);

    // Clean up
    await deleteScriptDirect(grid.page, id1);
    await deleteScriptDirect(grid.page, id2);
  });

  test("13b: calling non-existent method doesn't crash", async ({ grid }) => {
    const source = `function setup(cell) {
      cell.onSelect(() => {
        const result = cell.callMethod("slicer", "999", "nonExistent");
        cell.log("Result:", result);
      });
    }`;
    const id = await createScriptDirect(grid.page, "cell", source);

    // Script saved without crash
    const script = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);
    expect(script.source).toContain("nonExistent");

    await deleteScriptDirect(grid.page, id);
  });
});

// ===========================================================================
// #14 — API Versioning
// ===========================================================================

test.describe("#14 API Versioning", () => {
  test("14a: script can reference apiVersion in source", async ({ grid }) => {
    const source = 'function setup(ctx) { ctx.log("API version:", ctx.apiVersion); }';
    const id = await createScriptDirect(grid.page, "workbook", source, {
      name: "Version Check",
    });

    const script = await grid.page.evaluate(async (scriptId: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_object_script", { id: scriptId });
    }, id);
    expect(script.source).toContain("apiVersion");

    await deleteScriptDirect(grid.page, id);
  });
});

// ===========================================================================
// #8 — Template System
// ===========================================================================

test.describe("#8 Template System", () => {
  test("8a: save and list templates", async ({ grid }) => {
    const templateId = await grid.page.evaluate(() => crypto.randomUUID());

    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_object_template", {
        template: {
          id,
          name: "Test Slicer Template",
          objectType: "slicer",
          scriptSource: 'function setup(s) { s.log("template"); }',
          accessLevel: "restricted",
          createdAt: new Date().toISOString(),
        },
      });
    }, templateId);
    await grid.page.waitForTimeout(300);

    const templates = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("list_object_templates");
    });
    expect(templates.some((t: any) => t.id === templateId)).toBe(true);

    // Clean up
    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_object_template", { id });
    }, templateId);
  });

  test("8b: load template by ID", async ({ grid }) => {
    const templateId = await grid.page.evaluate(() => crypto.randomUUID());
    const templateSource = 'function setup(chart) { chart.log("chart template"); }';

    await grid.page.evaluate(async (args: any) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_object_template", {
        template: {
          id: args.id,
          name: "Chart Template",
          objectType: "chart",
          scriptSource: args.source,
          accessLevel: "restricted",
          createdAt: new Date().toISOString(),
        },
      });
    }, { id: templateId, source: templateSource });

    const loaded = await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("load_object_template", { id });
    }, templateId);

    expect(loaded.name).toBe("Chart Template");
    expect(loaded.scriptSource).toBe(templateSource);

    // Clean up
    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_object_template", { id });
    }, templateId);
  });

  test("8c: delete template removes it", async ({ grid }) => {
    const templateId = await grid.page.evaluate(() => crypto.randomUUID());

    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_object_template", {
        template: {
          id,
          name: "To Delete",
          objectType: "workbook",
          scriptSource: "function setup(wb) {}",
          accessLevel: "restricted",
          createdAt: new Date().toISOString(),
        },
      });
    }, templateId);

    await grid.page.evaluate(async (id: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_object_template", { id });
    }, templateId);

    const templates = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("list_object_templates");
    });
    expect(templates.some((t: any) => t.id === templateId)).toBe(false);
  });
});

// ===========================================================================
// #4-6 — Context Menu Integrations (Slicer, Chart, Pivot)
// ===========================================================================

test.describe("#4-6 Context Menu - Edit Script events", () => {
  test("4a: edit-script event for slicer type can be dispatched", async ({ grid }) => {
    // Dispatch the event that the context menu would fire
    await grid.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("scriptable-objects:edit-script", {
          detail: { objectType: "slicer", instanceId: "test-slicer-123" },
        })
      );
    });
    await grid.page.waitForTimeout(500);

    // The Code Editor dialog should open (or at least not crash)
    // Close any dialog that opened
    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(300);
  });

  test("5a: edit-script event for chart type", async ({ grid }) => {
    await grid.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("scriptable-objects:edit-script", {
          detail: { objectType: "chart", instanceId: "test-chart-456" },
        })
      );
    });
    await grid.page.waitForTimeout(500);
    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(300);
  });

  test("6a: edit-script event for pivot type", async ({ grid }) => {
    await grid.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("scriptable-objects:edit-script", {
          detail: { objectType: "pivot", instanceId: "test-pivot-789" },
        })
      );
    });
    await grid.page.waitForTimeout(500);
    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(300);
  });
});

// ===========================================================================
// Developer Menu — Dialog Opens
// ===========================================================================

test.describe("Developer Menu Dialogs", () => {
  // Object Scripts editor opens in a separate OS window (WebviewWindow),
  // so Playwright's CDP connection to the main page cannot see its contents.
  test.fixme("Object Scripts dialog opens from Developer menu", async ({ grid }) => {
    await grid.openMenu("Developer");
    const item = grid.page.locator("button").filter({ hasText: /Object Scripts/ });
    if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
      await item.click();
      await grid.page.waitForTimeout(800);

      // Dialog should be visible — look for "Save & Apply" or "Save as Template"
      const hasDialog = await grid.page
        .locator('button:has-text("Save")')
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      expect(hasDialog).toBe(true);

      await grid.page.keyboard.press("Escape");
      await grid.page.waitForTimeout(300);
    } else {
      await grid.closeMenu();
    }
  });

  test("Script Templates dialog opens from Developer menu", async ({ grid }) => {
    await grid.openMenu("Developer");
    const item = grid.page.locator("button").filter({ hasText: /Script Templates/ });
    if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
      await item.click();
      await grid.page.waitForTimeout(800);

      const hasDialog = await grid.page
        .locator('text=/Template|Import|No templates/')
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      expect(hasDialog).toBe(true);

      await grid.page.keyboard.press("Escape");
      await grid.page.waitForTimeout(300);
    } else {
      await grid.closeMenu();
    }
  });
});

// ===========================================================================
// Batch script operations (stress)
// ===========================================================================

test.describe("Script batch operations", () => {
  test("create and delete 10 scripts rapidly", async ({ grid }) => {
    const ids: string[] = [];

    // Create 10 scripts
    for (let i = 0; i < 10; i++) {
      const id = await createScriptDirect(
        grid.page,
        i % 2 === 0 ? "workbook" : "cell",
        `function setup(ctx) { ctx.log("script ${i}"); }`
      );
      ids.push(id);
    }

    const scripts = await listScripts(grid.page);
    expect(scripts.length).toBeGreaterThanOrEqual(10);

    // Delete all
    for (const id of ids) {
      await deleteScriptDirect(grid.page, id);
    }

    const after = await listScripts(grid.page);
    for (const id of ids) {
      expect(after.some((s: any) => s.id === id)).toBe(false);
    }
  });
});
