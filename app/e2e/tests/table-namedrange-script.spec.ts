/**
 * Gap-review C6 — TABLE + NAMED RANGE scriptable object types, e2e.
 *
 * Proves the production path for the two most-automated VBA objects:
 *  - A "table" script reads getHeaders()/getRowCount() and writes a table cell
 *    via setCellValue(); the host resolves the table id -> grid coords and reuses
 *    the existing (recalc + undoable) cell ops. We assert the grid cell changed.
 *  - A "namedRange" script calls setValues() over a small block; the host resolves
 *    the name -> grid coords and writes via updateCellsBatch. We assert the cells
 *    changed.
 *
 * Mirrors button-onclick.spec.ts (ObjectScriptManager mount in the worker realm).
 * sv-SE locale: never put ',' in a formula. We only write plain values here.
 */
import { test, expect } from "../fixtures";

test.describe("Table + NamedRange scripts (scriptable, worker realm)", () => {
  test("a table script reads headers/rowCount and writes a table cell", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(async () => {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      const { ObjectScriptManager } = api;
      const tauri = (window as any).__TAURI__;

      // 1. Seed a 2-column, header + 2 data rows block at A1:B3 on the active sheet.
      //    Header row: A1="Name", B1="Amount". Data rows below.
      await tauri.core.invoke("update_cells_batch", {
        updates: [
          { row: 0, col: 0, value: "Name" },
          { row: 0, col: 1, value: "Amount" },
          { row: 1, col: 0, value: "Alice" },
          { row: 1, col: 1, value: "10" },
          { row: 2, col: 0, value: "Bob" },
          { row: 2, col: 1, value: "20" },
        ],
      });

      // 2. Create a real table over A1:B3 with headers.
      const createRes = await tauri.core.invoke("create_table", {
        params: {
          name: "",
          startRow: 0,
          startCol: 0,
          endRow: 2,
          endCol: 1,
          hasHeaders: true,
        },
      });
      const tableId = String(createRes?.table?.id ?? "");
      if (!tableId) {
        return { error: "table not created", createRes };
      }

      const scriptDef = {
        id: "table-test-" + tableId,
        name: "Table Test",
        objectType: "table",
        instanceId: tableId,
        // restricted is enough: table cell ops go through the dedicated table
        // setState aspect, not the unlocked `api`.
        source:
          "function setup(t){" +
          "  t.expose('run', async function(){" +
          "    var headers = t.getHeaders();" +
          "    var rows = t.getRowCount();" +
          "    await t.setCellValue(0, 1, 'H' + headers.length + 'R' + rows);" +
          "    return { headers: headers, rows: rows };" +
          "  }, { public: true });" +
          "}",
        accessLevel: "restricted",
        description: null,
      };

      try {
        ObjectScriptManager.registerScript(scriptDef);
        await ObjectScriptManager.mountScript(scriptDef.id);
        await new Promise((r) => setTimeout(r, 700));

        // Drive the exposed method from trusted host code.
        const exposed = await api.callExposedMethod("table", tableId, "run");

        await new Promise((r) => setTimeout(r, 500));
        // First data row (logical row 0), second column (index 1) -> grid B2 (row 1, col 1).
        const cell = await tauri.core.invoke("get_cell", { row: 1, col: 1 });
        return {
          exposed,
          value: String(cell?.display ?? cell?.value ?? ""),
        };
      } finally {
        try {
          ObjectScriptManager.unmountScript(scriptDef.id);
          ObjectScriptManager.removeScript(scriptDef.id);
        } catch {
          /* best-effort */
        }
        await tauri.core.invoke("delete_table", { tableId }).catch(() => {});
        await tauri.core
          .invoke("clear_range", { startRow: 0, startCol: 0, endRow: 2, endCol: 1 })
          .catch(() => {});
      }
    });

    expect(result.error, JSON.stringify(result)).toBeUndefined();
    // headers = ["Name","Amount"] (len 2), data rows = 2 -> "H2R2"
    expect(result.value).toBe("H2R2");
    expect(result.exposed).toMatchObject({ headers: ["Name", "Amount"], rows: 2 });
  });

  test("a namedRange script writes a 2x2 block via setValues", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(async () => {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      const { ObjectScriptManager } = api;
      const tauri = (window as any).__TAURI__;

      const NAME = "ScriptBlock";
      // A named range over D1:E2 (rows 0..1, cols 3..4) on the active sheet (Sheet1).
      await tauri.core.invoke("create_named_range", {
        name: NAME,
        sheetIndex: null,
        refersTo: "=Sheet1!$D$1:$E$2",
        comment: null,
        folder: null,
      });

      const scriptDef = {
        id: "nr-test-" + NAME,
        name: "NamedRange Test",
        objectType: "namedRange",
        instanceId: NAME,
        source:
          "function setup(nr){" +
          "  nr.expose('run', async function(){" +
          "    var addr = nr.getAddress();" +
          "    await nr.setValues([['1','2'],['3','4']]);" +
          "    return addr;" +
          "  }, { public: true });" +
          "}",
        accessLevel: "restricted",
        description: null,
      };

      try {
        ObjectScriptManager.registerScript(scriptDef);
        await ObjectScriptManager.mountScript(scriptDef.id);
        await new Promise((r) => setTimeout(r, 700));

        const address = await api.callExposedMethod("namedRange", NAME, "run");
        await new Promise((r) => setTimeout(r, 500));

        const cells = await tauri.core.invoke("get_watch_cells", {
          requests: [
            [0, 0, 3],
            [0, 0, 4],
            [0, 1, 3],
            [0, 1, 4],
          ],
        });
        return {
          address: String(address ?? ""),
          values: (cells as any[]).map((c) => String(c?.display ?? c?.value ?? "")),
        };
      } finally {
        try {
          ObjectScriptManager.unmountScript(scriptDef.id);
          ObjectScriptManager.removeScript(scriptDef.id);
        } catch {
          /* best-effort */
        }
        await tauri.core.invoke("delete_named_range", { name: NAME }).catch(() => {});
        await tauri.core
          .invoke("clear_range", { startRow: 0, startCol: 3, endRow: 1, endCol: 4 })
          .catch(() => {});
      }
    });

    expect(result.address).toContain("D1:E2");
    expect(result.values).toEqual(["1", "2", "3", "4"]);
  });
});
