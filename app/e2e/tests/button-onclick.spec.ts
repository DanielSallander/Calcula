/**
 * Customization depth — ButtonContext.onClick (the #1 VBA entry point), e2e.
 *
 * Proves the production path: a script mounted on a button (objectType "button")
 * registers `button.onClick(...)`; when the button is clicked (the host receives
 * the `button:clicked` app event the Controls extension emits in run mode), the
 * host forwarder relays it into the worker, the handler runs, and — as an
 * unlocked script — writes the grid. Mirrors worker-realm-blit.spec.ts.
 */
import { test, expect } from "../fixtures";

test.describe("Button onClick (scriptable, worker realm)", () => {
  test("a button script's onClick fires on click and can write the grid", async ({
    appPage: page,
  }) => {
    const SHEET = 0;
    const ROW = 40;
    const COL = 8;
    const instanceId = `control-${SHEET}-${ROW}-${COL}`;

    // 1. Backing button control so the mount has a snapshot + instance to match.
    await page.evaluate(
      async (a) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("set_control_metadata", {
          sheetIndex: a.SHEET,
          row: a.ROW,
          col: a.COL,
          metadata: {
            controlType: "button",
            properties: { label: { valueType: "static", value: "Run" } },
          },
        });
      },
      { SHEET, ROW, COL },
    );
    await page.waitForTimeout(200);

    const result = await page.evaluate(
      async (a) => {
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        const events = await (window as any).__calcImport(
          new URL("/src/api/events.ts", document.baseURI).href,
        );
        const { ObjectScriptManager } = api;
        const { emitAppEvent } = events;
        const tauri = (window as any).__TAURI__;

        const scriptDef = {
          id: "btn-test-" + a.instanceId,
          name: "Button Test",
          objectType: "button",
          instanceId: a.instanceId,
          // Unlocked so the click handler can write a cell (observable proof).
          source:
            "function setup(button){ button.onClick(function(e){ button.api.setCellValue(0, 0, 'clicked:' + e.x + ',' + e.y); }); }",
          accessLevel: "unlocked",
          description: null,
        };

        try {
          ObjectScriptManager.registerScript(scriptDef);
          await ObjectScriptManager.mountScript(scriptDef.id);
          // Let the worker compile, run setup(), register onClick, and the host
          // wire the button:clicked forwarder.
          await new Promise((r) => setTimeout(r, 700));

          // Simulate the run-mode button click (what Controls/index.ts emits).
          emitAppEvent("button:clicked", { instanceId: a.instanceId, x: 1, y: 2 });

          // onClick -> api.setCellValue -> update_cell.
          await new Promise((r) => setTimeout(r, 700));
          const cell = await tauri.core.invoke("get_cell", { row: 0, col: 0 });
          return { value: String(cell?.display ?? cell?.value ?? "") };
        } finally {
          try {
            ObjectScriptManager.unmountScript(scriptDef.id);
            ObjectScriptManager.removeScript(scriptDef.id);
          } catch {
            /* best-effort cleanup */
          }
          await tauri.core.invoke("update_cell", { row: 0, col: 0, value: "" }).catch(() => {});
        }
      },
      { instanceId },
    );

    // Remove the backing control.
    await page.evaluate(
      async (a) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core
          .invoke("remove_control_metadata", { sheetIndex: a.SHEET, row: a.ROW, col: a.COL })
          .catch(() => {});
      },
      { SHEET, ROW, COL },
    );

    // The click ran the script's onClick, which wrote the grid with the payload.
    expect(result.value).toContain("clicked:1,2");
  });
});
