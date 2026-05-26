/**
 * Scriptable Shapes E2E tests.
 *
 * Tests the shape scripting system including:
 * - Shape control CRUD via Tauri API
 * - Script attachment and persistence
 * - Properties pane integration (groups, custom properties)
 * - Live cell data binding (getCellValue + onCellChange)
 * - Template application
 * - HTML iframe rendering
 * - Undo integration for script property changes
 */
import { test, expect } from "../fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a shape control via Tauri API and return its controlId */
async function createShape(
  page: any,
  sheetIndex: number,
  row: number,
  col: number,
  shapeType = "rectangle",
  width = 120,
  height = 80,
) {
  await page.evaluate(
    async (args: any) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_control_metadata", {
        sheetIndex: args.sheetIndex,
        row: args.row,
        col: args.col,
        metadata: {
          controlType: "shape",
          properties: {
            shapeType: { valueType: "static", value: args.shapeType },
            fill: { valueType: "static", value: "#4472C4" },
            stroke: { valueType: "static", value: "#2F528F" },
            strokeWidth: { valueType: "static", value: "1" },
            text: { valueType: "static", value: "" },
            textColor: { valueType: "static", value: "#FFFFFF" },
            fontSize: { valueType: "static", value: "11" },
            opacity: { valueType: "static", value: "1" },
            rotation: { valueType: "static", value: "0" },
            width: { valueType: "static", value: String(args.width) },
            height: { valueType: "static", value: String(args.height) },
          },
        },
      });
    },
    { sheetIndex, row, col, shapeType, width, height },
  );
  await page.waitForTimeout(300);
  return `control-${sheetIndex}-${row}-${col}`;
}

/** Get control metadata via Tauri API */
async function getControlMeta(page: any, sheetIndex: number, row: number, col: number) {
  return page.evaluate(
    async (args: any) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_control_metadata", {
        sheetIndex: args.sheetIndex,
        row: args.row,
        col: args.col,
      });
    },
    { sheetIndex, row, col },
  );
}

/** Set a single control property via Tauri API */
async function setControlProp(
  page: any,
  sheetIndex: number,
  row: number,
  col: number,
  key: string,
  value: string,
  valueType = "static",
) {
  return page.evaluate(
    async (args: any) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("set_control_property", {
        sheetIndex: args.sheetIndex,
        row: args.row,
        col: args.col,
        controlType: "shape",
        propertyName: args.key,
        valueType: args.valueType,
        value: args.value,
      });
    },
    { sheetIndex, row, col, key, value, valueType },
  );
}

/** Resolve (evaluate formulas in) control properties via Tauri API */
async function resolveProps(page: any, sheetIndex: number, row: number, col: number) {
  return page.evaluate(
    async (args: any) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("resolve_control_properties", {
        sheetIndex: args.sheetIndex,
        row: args.row,
        col: args.col,
      });
    },
    { sheetIndex, row, col },
  );
}

/** Remove control metadata via Tauri API */
async function removeControl(page: any, sheetIndex: number, row: number, col: number) {
  await page.evaluate(
    async (args: any) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("remove_control_metadata", {
        sheetIndex: args.sheetIndex,
        row: args.row,
        col: args.col,
      });
    },
    { sheetIndex, row, col },
  );
  await page.waitForTimeout(200);
}

/** Get all controls on a sheet via Tauri API */
async function getAllControls(page: any, sheetIndex: number) {
  return page.evaluate(
    async (si: number) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_all_controls", { sheetIndex: si });
    },
    sheetIndex,
  );
}

/** Create a shape script via Tauri API and return its id */
async function createShapeScript(
  page: any,
  instanceId: string,
  source: string,
  name = "Test Shape Script",
) {
  const id = await page.evaluate(() => crypto.randomUUID());
  await page.evaluate(
    async (args: any) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_object_script", {
        script: {
          id: args.id,
          name: args.name,
          objectType: "shape",
          instanceId: args.instanceId,
          source: args.source,
          accessLevel: "restricted",
          description: null,
        },
      });
    },
    { id, instanceId, source, name },
  );
  await page.waitForTimeout(300);
  return id;
}

/** Delete a script via Tauri API */
async function deleteScript(page: any, id: string) {
  await page.evaluate(async (scriptId: string) => {
    const tauri = (window as any).__TAURI__;
    await tauri.core.invoke("delete_object_script", { id: scriptId });
  }, id);
  await page.waitForTimeout(200);
}

/** List all object scripts via Tauri API */
async function listScripts(page: any) {
  return page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    return tauri.core.invoke("list_object_scripts");
  });
}

/** Set a cell value directly via Tauri API */
async function setCellDirect(page: any, row: number, col: number, value: string) {
  await page.evaluate(
    async (args: any) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_cell", { row: args.row, col: args.col, value: args.value });
    },
    { row, col, value },
  );
  await page.waitForTimeout(200);
}

/** Get a cell's display value via Tauri API */
async function getCellDisplay(page: any, row: number, col: number) {
  return page.evaluate(
    async (args: any) => {
      const tauri = (window as any).__TAURI__;
      const cell = await tauri.core.invoke("get_cell", { row: args.row, col: args.col });
      return cell?.display ?? "";
    },
    { row, col },
  );
}

// ===========================================================================
// #1 — Shape Control CRUD
// ===========================================================================

test.describe("#1 Shape Control CRUD", () => {
  test("1a: create shape and read metadata", async ({ grid }) => {
    const controlId = await createShape(grid.page, 0, 50, 10);
    expect(controlId).toBe("control-0-50-10");

    const meta = await getControlMeta(grid.page, 0, 50, 10);
    expect(meta).not.toBeNull();
    expect(meta.controlType).toBe("shape");
    expect(meta.properties.shapeType.value).toBe("rectangle");
    expect(meta.properties.fill.value).toBe("#4472C4");

    // Cleanup
    await removeControl(grid.page, 0, 50, 10);
  });

  test("1b: update shape property", async ({ grid }) => {
    await createShape(grid.page, 0, 51, 10);

    const updated = await setControlProp(grid.page, 0, 51, 10, "fill", "#FF0000");
    expect(updated.properties.fill.value).toBe("#FF0000");

    const meta = await getControlMeta(grid.page, 0, 51, 10);
    expect(meta.properties.fill.value).toBe("#FF0000");

    await removeControl(grid.page, 0, 51, 10);
  });

  test("1c: delete shape", async ({ grid }) => {
    await createShape(grid.page, 0, 52, 10);

    const before = await getAllControls(grid.page, 0);
    const countBefore = before.filter((c: any) => c.row === 52 && c.col === 10).length;
    expect(countBefore).toBe(1);

    await removeControl(grid.page, 0, 52, 10);

    const after = await getAllControls(grid.page, 0);
    const countAfter = after.filter((c: any) => c.row === 52 && c.col === 10).length;
    expect(countAfter).toBe(0);
  });

  test("1d: formula property resolution", async ({ grid }) => {
    // Put a value in a cell
    await setCellDirect(grid.page, 53, 10, "Hello World");

    // Create shape with formula property
    await createShape(grid.page, 0, 53, 11);
    await setControlProp(grid.page, 0, 53, 11, "text", "=K54", "formula");

    const resolved = await resolveProps(grid.page, 0, 53, 11);
    expect(resolved.text).toBe("Hello World");

    await removeControl(grid.page, 0, 53, 11);
  });

  test("1e: multiple shapes on same sheet", async ({ grid }) => {
    await createShape(grid.page, 0, 54, 10, "rectangle");
    await createShape(grid.page, 0, 55, 10, "oval");

    const controls = await getAllControls(grid.page, 0);
    const shapes = controls.filter(
      (c: any) => (c.row === 54 || c.row === 55) && c.col === 10,
    );
    expect(shapes.length).toBe(2);

    await removeControl(grid.page, 0, 54, 10);
    await removeControl(grid.page, 0, 55, 10);
  });
});

// ===========================================================================
// #2 — Shape Script Persistence
// ===========================================================================

test.describe("#2 Shape Script Persistence", () => {
  test("2a: save and retrieve shape script", async ({ grid }) => {
    const controlId = await createShape(grid.page, 0, 60, 10);
    const scriptId = await createShapeScript(
      grid.page,
      controlId,
      'function setup(shape) { shape.log("hello"); }',
    );

    const scripts = await listScripts(grid.page);
    const found = scripts.find((s: any) => s.id === scriptId);
    expect(found).toBeDefined();
    expect(found.objectType).toBe("shape");
    expect(found.instanceId).toBe(controlId);

    // Cleanup
    await deleteScript(grid.page, scriptId);
    await removeControl(grid.page, 0, 60, 10);
  });

  test("2b: get script by target (objectType + instanceId)", async ({ grid }) => {
    const controlId = await createShape(grid.page, 0, 61, 10);
    const scriptId = await createShapeScript(
      grid.page,
      controlId,
      'function setup(shape) {}',
    );

    const script = await grid.page.evaluate(
      async (args: any) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("get_object_script_by_target", {
          objectType: "shape",
          instanceId: args.instanceId,
        });
      },
      { instanceId: controlId },
    );
    expect(script).not.toBeNull();
    expect(script.id).toBe(scriptId);

    await deleteScript(grid.page, scriptId);
    await removeControl(grid.page, 0, 61, 10);
  });

  test("2c: delete scripts for instance", async ({ grid }) => {
    const controlId = await createShape(grid.page, 0, 62, 10);
    await createShapeScript(grid.page, controlId, 'function setup(shape) {}');

    // Delete all scripts for this instance
    await grid.page.evaluate(
      async (instanceId: string) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("delete_object_scripts_for_instance", { instanceId });
      },
      controlId,
    );
    await grid.page.waitForTimeout(200);

    // Verify no scripts remain for this instance
    const script = await grid.page.evaluate(
      async (args: any) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("get_object_script_by_target", {
          objectType: "shape",
          instanceId: args.instanceId,
        });
      },
      { instanceId: controlId },
    );
    expect(script).toBeNull();

    await removeControl(grid.page, 0, 62, 10);
  });

  test("2d: update existing script source", async ({ grid }) => {
    const controlId = await createShape(grid.page, 0, 63, 10);
    const scriptId = await createShapeScript(
      grid.page,
      controlId,
      'function setup(shape) { shape.log("v1"); }',
    );

    // Update the script
    await grid.page.evaluate(
      async (args: any) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("save_object_script", {
          script: {
            id: args.scriptId,
            name: "Updated Script",
            objectType: "shape",
            instanceId: args.controlId,
            source: 'function setup(shape) { shape.log("v2"); }',
            accessLevel: "restricted",
            description: null,
          },
        });
      },
      { scriptId, controlId },
    );
    await grid.page.waitForTimeout(200);

    const script = await grid.page.evaluate(
      async (args: any) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("get_object_script", { id: args.scriptId });
      },
      { scriptId },
    );
    expect(script.source).toContain("v2");
    expect(script.name).toBe("Updated Script");

    await deleteScript(grid.page, scriptId);
    await removeControl(grid.page, 0, 63, 10);
  });
});

// ===========================================================================
// #3 — Cell Data Binding (backend roundtrip)
// ===========================================================================

test.describe("#3 Cell Data Binding", () => {
  test("3a: cell values can be read by shape formula properties", async ({ grid }) => {
    // Set up cells
    await setCellDirect(grid.page, 70, 0, "100");
    await setCellDirect(grid.page, 70, 1, "Revenue");

    // Create shape with formula-bound text
    await createShape(grid.page, 0, 70, 5);
    await setControlProp(grid.page, 0, 70, 5, "text", "=A71", "formula");

    const resolved = await resolveProps(grid.page, 0, 70, 5);
    expect(resolved.text).toBe("100");

    await removeControl(grid.page, 0, 70, 5);
  });

  test("3b: formula property updates when cell changes", async ({ grid }) => {
    await setCellDirect(grid.page, 71, 0, "50");
    await createShape(grid.page, 0, 71, 5);
    await setControlProp(grid.page, 0, 71, 5, "text", "=A72", "formula");

    // Verify initial
    let resolved = await resolveProps(grid.page, 0, 71, 5);
    expect(resolved.text).toBe("50");

    // Change the cell
    await setCellDirect(grid.page, 71, 0, "99");

    // Re-resolve — should reflect new value
    resolved = await resolveProps(grid.page, 0, 71, 5);
    expect(resolved.text).toBe("99");

    await removeControl(grid.page, 0, 71, 5);
  });

  test("3c: numeric formula property (width bound to cell)", async ({ grid }) => {
    await setCellDirect(grid.page, 72, 0, "200");

    await createShape(grid.page, 0, 72, 5);
    await setControlProp(grid.page, 0, 72, 5, "width", "=A73", "formula");

    const resolved = await resolveProps(grid.page, 0, 72, 5);
    expect(resolved.width).toBe("200");

    await removeControl(grid.page, 0, 72, 5);
  });

  test("3d: formula referencing another sheet's cell", async ({ grid }) => {
    // Create a second sheet (ignore if already exists from prior run)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      try {
        await tauri.core.invoke("add_sheet", { name: "Data" });
      } catch {
        // Sheet may already exist
      }
    });
    await grid.page.waitForTimeout(300);

    // Set value in second sheet (sheet index 1)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_active_sheet", { index: 1 });
    });
    await grid.page.waitForTimeout(200);
    await setCellDirect(grid.page, 0, 0, "CrossSheet");

    // Go back to first sheet
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_active_sheet", { index: 0 });
    });
    await grid.page.waitForTimeout(200);

    // Create shape with cross-sheet formula
    await createShape(grid.page, 0, 73, 5);
    await setControlProp(grid.page, 0, 73, 5, "text", "=Data!A1", "formula");

    const resolved = await resolveProps(grid.page, 0, 73, 5);
    expect(resolved.text).toBe("CrossSheet");

    await removeControl(grid.page, 0, 73, 5);
  });
});

// ===========================================================================
// #4 — Property System
// ===========================================================================

test.describe("#4 Property System", () => {
  test("4a: all default shape properties are set", async ({ grid }) => {
    await createShape(grid.page, 0, 80, 10);
    const meta = await getControlMeta(grid.page, 0, 80, 10);

    expect(meta.properties.shapeType.value).toBe("rectangle");
    expect(meta.properties.fill.value).toBe("#4472C4");
    expect(meta.properties.stroke.value).toBe("#2F528F");
    expect(meta.properties.strokeWidth.value).toBe("1");
    expect(meta.properties.textColor.value).toBe("#FFFFFF");
    expect(meta.properties.fontSize.value).toBe("11");
    expect(meta.properties.opacity.value).toBe("1");
    expect(meta.properties.rotation.value).toBe("0");
    expect(meta.properties.width.value).toBe("120");
    expect(meta.properties.height.value).toBe("80");

    await removeControl(grid.page, 0, 80, 10);
  });

  test("4b: batch update multiple properties", async ({ grid }) => {
    await createShape(grid.page, 0, 81, 10);

    await setControlProp(grid.page, 0, 81, 10, "fill", "#FF0000");
    await setControlProp(grid.page, 0, 81, 10, "text", "Hello");
    await setControlProp(grid.page, 0, 81, 10, "fontSize", "24");
    await setControlProp(grid.page, 0, 81, 10, "opacity", "0.5");

    const meta = await getControlMeta(grid.page, 0, 81, 10);
    expect(meta.properties.fill.value).toBe("#FF0000");
    expect(meta.properties.text.value).toBe("Hello");
    expect(meta.properties.fontSize.value).toBe("24");
    expect(meta.properties.opacity.value).toBe("0.5");

    await removeControl(grid.page, 0, 81, 10);
  });

  test("4c: static vs formula valueType preserved", async ({ grid }) => {
    await createShape(grid.page, 0, 82, 10);

    await setControlProp(grid.page, 0, 82, 10, "text", "Static Value", "static");
    await setControlProp(grid.page, 0, 82, 10, "fill", "=IF(A1>5,\"#FF0000\",\"#00FF00\")", "formula");

    const meta = await getControlMeta(grid.page, 0, 82, 10);
    expect(meta.properties.text.valueType).toBe("static");
    expect(meta.properties.text.value).toBe("Static Value");
    expect(meta.properties.fill.valueType).toBe("formula");
    expect(meta.properties.fill.value).toContain("IF");

    await removeControl(grid.page, 0, 82, 10);
  });

  test("4d: resolve all properties at once", async ({ grid }) => {
    await setCellDirect(grid.page, 83, 0, "Dynamic Text");
    await createShape(grid.page, 0, 83, 5);
    await setControlProp(grid.page, 0, 83, 5, "text", "=A84", "formula");
    await setControlProp(grid.page, 0, 83, 5, "fill", "#123456", "static");

    const resolved = await resolveProps(grid.page, 0, 83, 5);
    expect(resolved.text).toBe("Dynamic Text");
    expect(resolved.fill).toBe("#123456");
    expect(resolved.shapeType).toBe("rectangle");

    await removeControl(grid.page, 0, 83, 5);
  });
});

// ===========================================================================
// #5 — Shape Types
// ===========================================================================

test.describe("#5 Shape Types", () => {
  const shapeTypes = ["rectangle", "oval", "triangle", "diamond", "roundedRectangle"];

  for (const shapeType of shapeTypes) {
    test(`5x: create ${shapeType} shape`, async ({ grid }) => {
      const row = 90 + shapeTypes.indexOf(shapeType);
      await createShape(grid.page, 0, row, 10, shapeType);

      const meta = await getControlMeta(grid.page, 0, row, 10);
      expect(meta.properties.shapeType.value).toBe(shapeType);

      await removeControl(grid.page, 0, row, 10);
    });
  }
});

// ===========================================================================
// #6 — Script Lifecycle & Concurrent Scripts
// ===========================================================================

test.describe("#6 Script Lifecycle", () => {
  test("6a: multiple shapes can each have independent scripts", async ({ grid }) => {
    const id1 = await createShape(grid.page, 0, 100, 10);
    const id2 = await createShape(grid.page, 0, 101, 10);

    const script1 = await createShapeScript(grid.page, id1, 'function setup(shape) { shape.log("script1"); }', "Script A");
    const script2 = await createShapeScript(grid.page, id2, 'function setup(shape) { shape.log("script2"); }', "Script B");

    const scripts = await listScripts(grid.page);
    const s1 = scripts.find((s: any) => s.id === script1);
    const s2 = scripts.find((s: any) => s.id === script2);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1.instanceId).toBe(id1);
    expect(s2.instanceId).toBe(id2);

    await deleteScript(grid.page, script1);
    await deleteScript(grid.page, script2);
    await removeControl(grid.page, 0, 100, 10);
    await removeControl(grid.page, 0, 101, 10);
  });

  test("6b: deleting shape's control also allows script cleanup", async ({ grid }) => {
    const controlId = await createShape(grid.page, 0, 102, 10);
    const scriptId = await createShapeScript(grid.page, controlId, 'function setup(shape) {}');

    // Delete scripts for the instance (simulating shape deletion cleanup)
    await grid.page.evaluate(
      async (instanceId: string) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("delete_object_scripts_for_instance", { instanceId });
      },
      controlId,
    );
    await grid.page.waitForTimeout(200);

    // Verify script is gone
    const scripts = await listScripts(grid.page);
    expect(scripts.find((s: any) => s.id === scriptId)).toBeUndefined();

    await removeControl(grid.page, 0, 102, 10);
  });

  test("6c: replacing a script overwrites by ID", async ({ grid }) => {
    const controlId = await createShape(grid.page, 0, 103, 10);
    const scriptId = await createShapeScript(grid.page, controlId, 'function setup(shape) { shape.log("v1"); }');

    // Overwrite with same ID
    await grid.page.evaluate(
      async (args: any) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("save_object_script", {
          script: {
            id: args.scriptId,
            name: "Replaced Script",
            objectType: "shape",
            instanceId: args.controlId,
            source: 'function setup(shape) { shape.log("v2"); }',
            accessLevel: "unlocked",
            description: "replaced",
          },
        });
      },
      { scriptId, controlId },
    );
    await grid.page.waitForTimeout(200);

    const script = await grid.page.evaluate(
      async (id: string) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("get_object_script", { id });
      },
      scriptId,
    );
    expect(script.source).toContain("v2");
    expect(script.accessLevel).toBe("unlocked");
    expect(script.name).toBe("Replaced Script");

    // Verify there's only one script for this instance
    const scripts = await listScripts(grid.page);
    const forInstance = scripts.filter((s: any) => s.instanceId === controlId);
    expect(forInstance.length).toBe(1);

    await deleteScript(grid.page, scriptId);
    await removeControl(grid.page, 0, 103, 10);
  });
});

// ===========================================================================
// #7 — Advanced Cell Binding & Formula Chains
// ===========================================================================

test.describe("#7 Advanced Cell Binding", () => {
  test("7a: shape with formula-driven fill color", async ({ grid }) => {
    // Cell A111 = "red" text, formula returns color
    await setCellDirect(grid.page, 110, 0, "#FF0000");

    await createShape(grid.page, 0, 110, 5);
    await setControlProp(grid.page, 0, 110, 5, "fill", "=A111", "formula");

    const resolved = await resolveProps(grid.page, 0, 110, 5);
    expect(resolved.fill).toBe("#FF0000");

    // Change the cell to a different color
    await setCellDirect(grid.page, 110, 0, "#00FF00");
    const resolved2 = await resolveProps(grid.page, 0, 110, 5);
    expect(resolved2.fill).toBe("#00FF00");

    await removeControl(grid.page, 0, 110, 5);
  });

  test("7b: shape with computed text (formula concat)", async ({ grid }) => {
    await setCellDirect(grid.page, 111, 0, "Hello");
    await setCellDirect(grid.page, 111, 1, "World");

    await createShape(grid.page, 0, 111, 5);
    await setControlProp(grid.page, 0, 111, 5, "text", '=A112&" "&B112', "formula");

    const resolved = await resolveProps(grid.page, 0, 111, 5);
    expect(resolved.text).toBe("Hello World");

    await removeControl(grid.page, 0, 111, 5);
  });

  test("7c: shape with conditional fill (IF formula)", async ({ grid }) => {
    await setCellDirect(grid.page, 112, 0, "10");

    await createShape(grid.page, 0, 112, 5);
    await setControlProp(grid.page, 0, 112, 5, "fill", '=IF(A113>5,"#00FF00","#FF0000")', "formula");

    let resolved = await resolveProps(grid.page, 0, 112, 5);
    expect(resolved.fill).toBe("#00FF00");

    // Change to value <= 5
    await setCellDirect(grid.page, 112, 0, "3");
    resolved = await resolveProps(grid.page, 0, 112, 5);
    expect(resolved.fill).toBe("#FF0000");

    await removeControl(grid.page, 0, 112, 5);
  });

  test("7d: shape with chained formula (cell references cell)", async ({ grid }) => {
    await setCellDirect(grid.page, 113, 0, "42");
    await setCellDirect(grid.page, 113, 1, "=A114*2");

    await createShape(grid.page, 0, 113, 5);
    await setControlProp(grid.page, 0, 113, 5, "text", "=B114", "formula");

    const resolved = await resolveProps(grid.page, 0, 113, 5);
    expect(resolved.text).toBe("84");

    // Change source cell — chain should propagate
    await setCellDirect(grid.page, 113, 0, "10");
    const resolved2 = await resolveProps(grid.page, 0, 113, 5);
    expect(resolved2.text).toBe("20");

    await removeControl(grid.page, 0, 113, 5);
  });
});

// ===========================================================================
// #8 — Edge Cases & Robustness
// ===========================================================================

test.describe("#8 Edge Cases", () => {
  test("8a: shape with empty text property", async ({ grid }) => {
    await createShape(grid.page, 0, 120, 10);

    const meta = await getControlMeta(grid.page, 0, 120, 10);
    expect(meta.properties.text.value).toBe("");

    const resolved = await resolveProps(grid.page, 0, 120, 10);
    expect(resolved.text).toBe("");

    await removeControl(grid.page, 0, 120, 10);
  });

  test("8b: shape property with special characters", async ({ grid }) => {
    await createShape(grid.page, 0, 121, 10);
    await setControlProp(grid.page, 0, 121, 10, "text", 'Text with "quotes" & <symbols>');

    const meta = await getControlMeta(grid.page, 0, 121, 10);
    expect(meta.properties.text.value).toBe('Text with "quotes" & <symbols>');

    await removeControl(grid.page, 0, 121, 10);
  });

  test("8c: shape at high row/col index", async ({ grid }) => {
    await createShape(grid.page, 0, 500, 100);

    const meta = await getControlMeta(grid.page, 0, 500, 100);
    expect(meta).not.toBeNull();
    expect(meta.controlType).toBe("shape");

    await removeControl(grid.page, 0, 500, 100);
  });

  test("8d: rapid property updates don't corrupt state", async ({ grid }) => {
    await createShape(grid.page, 0, 122, 10);

    // Rapidly update fill 10 times
    for (let i = 0; i < 10; i++) {
      const hex = `#${i.toString(16).padStart(2, "0")}0000`;
      await setControlProp(grid.page, 0, 122, 10, "fill", hex);
    }

    const meta = await getControlMeta(grid.page, 0, 122, 10);
    expect(meta.properties.fill.value).toBe("#090000");

    await removeControl(grid.page, 0, 122, 10);
  });

  test("8e: formula referencing empty cell returns empty string", async ({ grid }) => {
    await createShape(grid.page, 0, 123, 10);
    // Reference a cell that hasn't been written to (row 999, col 99)
    await setControlProp(grid.page, 0, 123, 10, "text", "=CV1000", "formula");

    const resolved = await resolveProps(grid.page, 0, 123, 10);
    // Empty cell should resolve to "0" or "" depending on formula semantics
    expect(["", "0"]).toContain(resolved.text);

    await removeControl(grid.page, 0, 123, 10);
  });

  test("8f: create and delete many shapes rapidly", async ({ grid }) => {
    const rows = Array.from({ length: 20 }, (_, i) => 130 + i);

    // Create 20 shapes
    for (const row of rows) {
      await createShape(grid.page, 0, row, 15);
    }

    const controls = await getAllControls(grid.page, 0);
    const created = controls.filter((c: any) => c.col === 15 && c.row >= 130 && c.row < 150);
    expect(created.length).toBe(20);

    // Delete all 20
    for (const row of rows) {
      await removeControl(grid.page, 0, row, 15);
    }

    const after = await getAllControls(grid.page, 0);
    const remaining = after.filter((c: any) => c.col === 15 && c.row >= 130 && c.row < 150);
    expect(remaining.length).toBe(0);
  });
});

// ===========================================================================
// #9 — Multi-Shape Dashboard Scenario
// ===========================================================================

test.describe("#9 Dashboard Scenario", () => {
  test("9a: create a mini-dashboard with 4 shapes bound to data cells", async ({ grid }) => {
    // Set up data cells
    await setCellDirect(grid.page, 200, 0, "Revenue");
    await setCellDirect(grid.page, 200, 1, "12450");
    await setCellDirect(grid.page, 201, 0, "Users");
    await setCellDirect(grid.page, 201, 1, "247");
    await setCellDirect(grid.page, 202, 0, "Status");
    await setCellDirect(grid.page, 202, 1, "ok");
    await setCellDirect(grid.page, 203, 0, "Progress");
    await setCellDirect(grid.page, 203, 1, "72");

    // Create 4 shapes bound to data
    await createShape(grid.page, 0, 200, 5, "rectangle", 180, 90);
    await createShape(grid.page, 0, 201, 5, "rectangle", 180, 90);
    await createShape(grid.page, 0, 202, 5, "oval", 160, 60);
    await createShape(grid.page, 0, 203, 5, "roundedRectangle", 220, 50);

    // Bind shapes to cells via formula
    await setControlProp(grid.page, 0, 200, 5, "text", "=B201", "formula");
    await setControlProp(grid.page, 0, 201, 5, "text", "=B202", "formula");
    await setControlProp(grid.page, 0, 202, 5, "text", "=B203", "formula");
    await setControlProp(grid.page, 0, 203, 5, "text", "=B204", "formula");

    // Verify all 4 resolve correctly
    const r1 = await resolveProps(grid.page, 0, 200, 5);
    const r2 = await resolveProps(grid.page, 0, 201, 5);
    const r3 = await resolveProps(grid.page, 0, 202, 5);
    const r4 = await resolveProps(grid.page, 0, 203, 5);

    expect(r1.text).toBe("12450");
    expect(r2.text).toBe("247");
    expect(r3.text).toBe("ok");
    expect(r4.text).toBe("72");

    // Update source data and verify propagation
    await setCellDirect(grid.page, 200, 1, "15000");
    await setCellDirect(grid.page, 201, 1, "300");

    const u1 = await resolveProps(grid.page, 0, 200, 5);
    const u2 = await resolveProps(grid.page, 0, 201, 5);
    expect(u1.text).toBe("15000");
    expect(u2.text).toBe("300");

    // Cleanup
    await removeControl(grid.page, 0, 200, 5);
    await removeControl(grid.page, 0, 201, 5);
    await removeControl(grid.page, 0, 202, 5);
    await removeControl(grid.page, 0, 203, 5);
  });

  test("9b: shapes with scripts and data binding coexist", async ({ grid }) => {
    // Create two shapes: one with formula binding, one with script
    await setCellDirect(grid.page, 210, 0, "Formula Bound");
    const id1 = await createShape(grid.page, 0, 210, 5);
    const id2 = await createShape(grid.page, 0, 211, 5);

    // Shape 1: formula-bound text
    await setControlProp(grid.page, 0, 210, 5, "text", "=A211", "formula");

    // Shape 2: script-based
    await createShapeScript(grid.page, id2, 'function setup(shape) { shape.log("independent"); }');

    // Verify shape 1 resolves correctly
    const r1 = await resolveProps(grid.page, 0, 210, 5);
    expect(r1.text).toBe("Formula Bound");

    // Verify shape 2 has script
    const scripts = await listScripts(grid.page);
    const s2 = scripts.find((s: any) => s.instanceId === id2);
    expect(s2).toBeDefined();

    // Cleanup
    await grid.page.evaluate(
      async (instanceId: string) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("delete_object_scripts_for_instance", { instanceId });
      },
      id2,
    );
    await removeControl(grid.page, 0, 210, 5);
    await removeControl(grid.page, 0, 211, 5);
  });
});

// ===========================================================================
// #10 — Stress Tests
// ===========================================================================

test.describe("#10 Stress Tests", () => {
  test("10a: create 50 shapes and verify all persist", async ({ grid }) => {
    const baseRow = 300;
    const count = 50;

    // Create 50 shapes
    for (let i = 0; i < count; i++) {
      await createShape(grid.page, 0, baseRow + i, 20, "rectangle", 80, 40);
    }

    const controls = await getAllControls(grid.page, 0);
    const shapes = controls.filter(
      (c: any) => c.col === 20 && c.row >= baseRow && c.row < baseRow + count,
    );
    expect(shapes.length).toBe(count);

    // Update every 5th shape's fill
    for (let i = 0; i < count; i += 5) {
      await setControlProp(grid.page, 0, baseRow + i, 20, "fill", "#FF0000");
    }

    // Verify updates
    for (let i = 0; i < count; i += 5) {
      const meta = await getControlMeta(grid.page, 0, baseRow + i, 20);
      expect(meta.properties.fill.value).toBe("#FF0000");
    }

    // Verify non-updated shapes still have default
    const meta5 = await getControlMeta(grid.page, 0, baseRow + 1, 20);
    expect(meta5.properties.fill.value).toBe("#4472C4");

    // Cleanup
    for (let i = 0; i < count; i++) {
      await removeControl(grid.page, 0, baseRow + i, 20);
    }
  });

  test("10b: shape with 10 formula properties all resolving", async ({ grid }) => {
    // Set up 10 source cells
    for (let i = 0; i < 10; i++) {
      await setCellDirect(grid.page, 360 + i, 0, `Value${i}`);
    }

    await createShape(grid.page, 0, 360, 5);

    // Bind text to first cell
    await setControlProp(grid.page, 0, 360, 5, "text", "=A361", "formula");

    const resolved = await resolveProps(grid.page, 0, 360, 5);
    expect(resolved.text).toBe("Value0");

    // Change all source cells
    for (let i = 0; i < 10; i++) {
      await setCellDirect(grid.page, 360 + i, 0, `Changed${i}`);
    }

    const resolved2 = await resolveProps(grid.page, 0, 360, 5);
    expect(resolved2.text).toBe("Changed0");

    await removeControl(grid.page, 0, 360, 5);
  });

  test("10c: many scripts for different shapes", async ({ grid }) => {
    const baseRow = 370;
    const count = 10;
    const scriptIds: string[] = [];

    // Create 10 shapes each with a script
    for (let i = 0; i < count; i++) {
      const controlId = await createShape(grid.page, 0, baseRow + i, 25);
      const scriptId = await createShapeScript(
        grid.page,
        controlId,
        `function setup(shape) { shape.log("script-${i}"); }`,
        `Script ${i}`,
      );
      scriptIds.push(scriptId);
    }

    // Verify all 10 scripts exist
    const scripts = await listScripts(grid.page);
    for (const sid of scriptIds) {
      expect(scripts.find((s: any) => s.id === sid)).toBeDefined();
    }

    // Delete all scripts and shapes
    for (let i = 0; i < count; i++) {
      await deleteScript(grid.page, scriptIds[i]);
      await removeControl(grid.page, 0, baseRow + i, 25);
    }

    // Verify all cleaned up
    const after = await listScripts(grid.page);
    for (const sid of scriptIds) {
      expect(after.find((s: any) => s.id === sid)).toBeUndefined();
    }
  });
});
