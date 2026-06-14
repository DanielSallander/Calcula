/**
 * Wave 2 Phase 3 — worker-realm BLIT PATH integration coverage (gate C).
 *
 * The spike (worker-realm-spike.spec.ts) proved the platform MECHANISM
 * (OffscreenCanvas -> transferToImageBitmap -> host drawImage) in an isolated,
 * hand-rolled worker. This test proves the *production* path end-to-end:
 *
 *   ObjectScriptManager.mountScript()  (real worker-realm mount)
 *     -> bootstrap worker compiles the script (blob-ESM import)
 *       -> setup(shape) registers shape.render.canvasRenderer((ctx, bounds) => ...)
 *         -> host getShapeBitmap() requests a draw from THAT worker
 *           -> worker handleRenderDraw paints the OffscreenCanvas, transfers an
 *              ImageBitmap back to the host, which caches it
 *
 * The script fills a solid color, so we can pixel-assert the result with NO
 * committed baseline image — immune to font/AA/DPI drift (the reason the
 * screenshot-baseline visual suite is noisy). A red center pixel proves the
 * script's drawing crossed the worker boundary intact. hasShapeBitmapRenderer
 * returning true inherently requires a real MountedWorker, so this also asserts
 * the worker realm (not the legacy main-thread path) actually served the render.
 *
 * This is the gate-C coverage for the bitmap-blit renderers; before Phase 3 had
 * no test exercised script -> worker -> blit.
 */
import { test, expect } from "../fixtures";

test.describe("Worker realm blit path (Phase 3)", () => {
  test("a scripted shape canvasRenderer renders through worker -> ImageBitmap -> host", async ({
    appPage: page,
  }) => {
    const SHEET = 0;
    const ROW = 40;
    const COL = 8;
    const W = 120;
    const H = 80;
    const instanceId = `control-${SHEET}-${ROW}-${COL}`;

    // 1. Create the backing shape (Tauri) so the mount can build its snapshot
    //    and findWorkerForInstance can match objectType+instanceId.
    await page.evaluate(
      async (a) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("set_control_metadata", {
          sheetIndex: a.SHEET,
          row: a.ROW,
          col: a.COL,
          metadata: {
            controlType: "shape",
            properties: {
              shapeType: { valueType: "static", value: "rectangle" },
              fill: { valueType: "static", value: "#4472C4" },
              width: { valueType: "static", value: String(a.W) },
              height: { valueType: "static", value: String(a.H) },
            },
          },
        });
      },
      { SHEET, ROW, COL, W, H },
    );
    await page.waitForTimeout(300);

    // 2. Mount a deterministic solid-red canvas renderer through the REAL
    //    production path and pull the rendered bitmap back via the host blit API.
    const result = await page.evaluate(
      async (a) => {
        // page.evaluate is a classic script — dynamic import via the dev-only
        // __calcImport helper (no `new Function`, so no 'unsafe-eval'), with an
        // absolute Vite URL (same trick as the spike).
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        const { ObjectScriptManager, getShapeBitmap, hasShapeBitmapRenderer } = api;
        if (!ObjectScriptManager || !getShapeBitmap || !hasShapeBitmapRenderer) {
          return {
            error: `missing @api exports: ${[
              !ObjectScriptManager && "ObjectScriptManager",
              !getShapeBitmap && "getShapeBitmap",
              !hasShapeBitmapRenderer && "hasShapeBitmapRenderer",
            ]
              .filter(Boolean)
              .join(", ")}`,
          };
        }

        const scriptDef = {
          id: "blit-test-" + a.instanceId,
          name: "Blit Test Renderer",
          objectType: "shape",
          instanceId: a.instanceId,
          source:
            "function setup(shape){ shape.render.canvasRenderer(function(ctx,b){ ctx.fillStyle='#ff0000'; ctx.fillRect(0,0,b.width,b.height); }); }",
          accessLevel: "restricted",
          description: null,
        };

        const waitFor = async (
          pred: () => boolean | Promise<boolean>,
          ms: number,
        ): Promise<boolean> => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            if (await pred()) return true;
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        };

        try {
          ObjectScriptManager.registerScript(scriptDef);
          await ObjectScriptManager.mountScript(scriptDef.id);

          // Worker compiled the script + setup() registered the canvas renderer.
          const hookOk = await waitFor(
            () => hasShapeBitmapRenderer(a.instanceId) === true,
            8000,
          );

          // First getShapeBitmap returns null and kicks off an async worker
          // draw; poll until the host has cached the transferred bitmap.
          let bmp: ImageBitmap | null = null;
          const bitmapOk = await waitFor(() => {
            bmp = getShapeBitmap(a.instanceId, a.W, a.H, 1);
            return !!bmp;
          }, 8000);

          let pixel: number[] | null = null;
          let bw = 0;
          let bh = 0;
          if (bmp) {
            bw = bmp.width;
            bh = bmp.height;
            const c = document.createElement("canvas");
            c.width = bw;
            c.height = bh;
            const cx = c.getContext("2d")!;
            cx.drawImage(bmp, 0, 0);
            const p = cx.getImageData(
              Math.floor(bw / 2),
              Math.floor(bh / 2),
              1,
              1,
            ).data;
            pixel = [p[0], p[1], p[2], p[3]];
          }

          return { hookOk, bitmapOk, bw, bh, pixel };
        } finally {
          try {
            ObjectScriptManager.unmountScript(scriptDef.id);
            ObjectScriptManager.removeScript(scriptDef.id);
          } catch {
            /* best-effort cleanup */
          }
        }
      },
      { instanceId, W, H },
    );

    // Remove the backing shape.
    await page.evaluate(
      async (a) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("remove_control_metadata", {
          sheetIndex: a.SHEET,
          row: a.ROW,
          col: a.COL,
        });
      },
      { SHEET, ROW, COL },
    );

    expect(result.error ?? "").toBe("");
    // The worker mounted and registered the canvas renderer (requires a real
    // MountedWorker — i.e. the worker realm, not the legacy path).
    expect(result.hookOk).toBe(true);
    // The host received an ImageBitmap transferred from the worker.
    expect(result.bitmapOk).toBe(true);
    expect(result.bw).toBeGreaterThan(0);
    expect(result.bh).toBeGreaterThan(0);
    // The script's red fill survived worker -> OffscreenCanvas -> ImageBitmap
    // -> host. This is the byte-stable proof the blit path renders correctly.
    expect(result.pixel).toEqual([255, 0, 0, 255]);
  });

  test("a scripted slicer itemRenderer renders through worker -> ImageBitmap -> host", async ({
    appPage: page,
  }) => {
    // No backend slicer needed: buildSnapshot's slicer branch tolerates an
    // unknown id, and the render path matches by handle instanceId. This keeps
    // the test light while still exercising the slicer-specific code: the
    // self-invalidating item key and the (item, ctx, bounds) arg order (which
    // the design notes was fixed to match the legacy renderer — a wrong order
    // would land ctx.fillStyle on the item object and paint nothing).
    const slicerId = "blit-slicer-test";
    const W = 100;
    const H = 28;

    const result = await page.evaluate(
      async (a) => {
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        const { ObjectScriptManager, getSlicerItemBitmap, hasSlicerItemBitmapRenderer } = api;
        if (!ObjectScriptManager || !getSlicerItemBitmap || !hasSlicerItemBitmapRenderer) {
          return {
            error: `missing @api exports: ${[
              !ObjectScriptManager && "ObjectScriptManager",
              !getSlicerItemBitmap && "getSlicerItemBitmap",
              !hasSlicerItemBitmapRenderer && "hasSlicerItemBitmapRenderer",
            ]
              .filter(Boolean)
              .join(", ")}`,
          };
        }

        const scriptDef = {
          id: "blit-test-" + a.slicerId,
          name: "Blit Test Slicer Renderer",
          objectType: "slicer",
          instanceId: a.slicerId,
          source:
            "function setup(slicer){ slicer.style.itemRenderer(function(item,ctx,b){ ctx.fillStyle='#00ff00'; ctx.fillRect(0,0,b.width,b.height); }); }",
          accessLevel: "restricted",
          description: null,
        };

        const waitFor = async (
          pred: () => boolean | Promise<boolean>,
          ms: number,
        ): Promise<boolean> => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            if (await pred()) return true;
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        };

        const item = { text: "Region A", selected: false, hasData: true };

        try {
          ObjectScriptManager.registerScript(scriptDef);
          await ObjectScriptManager.mountScript(scriptDef.id);

          const hookOk = await waitFor(
            () => hasSlicerItemBitmapRenderer(a.slicerId) === true,
            8000,
          );

          let bmp: ImageBitmap | null = null;
          const bitmapOk = await waitFor(() => {
            bmp = getSlicerItemBitmap(a.slicerId, item, a.W, a.H, 1);
            return !!bmp;
          }, 8000);

          let pixel: number[] | null = null;
          let bw = 0;
          let bh = 0;
          if (bmp) {
            bw = bmp.width;
            bh = bmp.height;
            const c = document.createElement("canvas");
            c.width = bw;
            c.height = bh;
            const cx = c.getContext("2d")!;
            cx.drawImage(bmp, 0, 0);
            const p = cx.getImageData(
              Math.floor(bw / 2),
              Math.floor(bh / 2),
              1,
              1,
            ).data;
            pixel = [p[0], p[1], p[2], p[3]];
          }

          return { hookOk, bitmapOk, bw, bh, pixel };
        } finally {
          try {
            ObjectScriptManager.unmountScript(scriptDef.id);
            ObjectScriptManager.removeScript(scriptDef.id);
          } catch {
            /* best-effort cleanup */
          }
        }
      },
      { slicerId, W, H },
    );

    expect(result.error ?? "").toBe("");
    expect(result.hookOk).toBe(true);
    expect(result.bitmapOk).toBe(true);
    expect(result.bw).toBeGreaterThan(0);
    expect(result.bh).toBeGreaterThan(0);
    // The item renderer's green fill survived worker -> ImageBitmap -> host,
    // proving the slicer arg order and item-keyed bitmap cache are correct.
    expect(result.pixel).toEqual([0, 255, 0, 255]);
  });
});
