/**
 * B8.D — Sandboxed custom chart MARK blit path, end-to-end.
 *
 * Proves the full authored-mark pipeline through the PRODUCTION code:
 *
 *   installChartMarkLibrary({marks:[{markId:"sandbox:e2e", body}]}, registerSandboxMark)
 *     -> generates `setup(context){ context.render.markRenderer((ctx,paint,b)=>{ body }); }`
 *       -> hostMountScript(objectType:"chartMark") spawns a real worker-realm script
 *         -> bootstrap compiles it; setup() registers the markRenderer hook
 *           -> registerSandboxMark wires the host-side blit shim into the chart-mark registry
 *             -> getChartMarkBitmap requests a draw from THAT worker -> OffscreenCanvas
 *                -> ImageBitmap transferred back to the host + cached
 *
 * The body fills solid red, so we pixel-assert with NO committed baseline image
 * (immune to font/AA/DPI drift). hasChartMarkBitmapRenderer returning true
 * requires a real MountedWorker (so this asserts the worker realm, not a stub),
 * and isChartMarkRegistered proves the registry integration a chart's
 * spec.mark==="sandbox:e2e" dispatch relies on.
 */
import { test, expect } from "../fixtures";

test.describe("Sandboxed chart-mark blit path (B8.D)", () => {
  test("an authored sandboxed mark renders through worker -> ImageBitmap -> host", async ({
    appPage: page,
  }) => {
    const MARK_ID = "sandbox:e2e";
    const W = 120;
    const H = 80;

    const result = await page.evaluate(
      async (a) => {
        const base = document.baseURI;
        const api = await (window as any).__calcImport(new URL("/src/api/index.ts", base).href);
        // registerSandboxMark lives in the Charts extension (it builds the
        // Charts-internal blit shim); the install lifecycle takes it as a registrar.
        const charts = await (window as any).__calcImport(
          new URL("/extensions/Charts/rendering/sandboxMarkShim.ts", base).href,
        );
        const {
          installChartMarkLibrary,
          uninstallChartMarks,
          getChartMarkBitmap,
          hasChartMarkBitmapRenderer,
          isChartMarkRegistered,
          markScriptId,
        } = api;
        const missing = [
          !installChartMarkLibrary && "installChartMarkLibrary",
          !getChartMarkBitmap && "getChartMarkBitmap",
          !hasChartMarkBitmapRenderer && "hasChartMarkBitmapRenderer",
          !isChartMarkRegistered && "isChartMarkRegistered",
          !markScriptId && "markScriptId",
          !charts?.registerSandboxMark && "registerSandboxMark",
        ].filter(Boolean);
        if (missing.length) return { error: `missing exports: ${missing.join(", ")}` };

        const waitFor = async (pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            if (await pred()) return true;
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        };

        const lib = {
          marks: [{
            markId: a.MARK_ID,
            label: "E2E Mark",
            layoutFamily: "cartesian" as const,
            body: "ctx.fillStyle='#ff0000'; ctx.fillRect(0,0,b.width,b.height);",
          }],
        };
        const scriptId = markScriptId(a.MARK_ID);

        try {
          await installChartMarkLibrary(lib, charts.registerSandboxMark);

          const hookOk = await waitFor(() => hasChartMarkBitmapRenderer(scriptId) === true, 8000);
          const registered = isChartMarkRegistered(a.MARK_ID);

          // First getChartMarkBitmap returns null + kicks off the worker draw;
          // poll until the host has cached the transferred bitmap.
          const item = { spec: {}, data: { categories: [], series: [] }, layout: { plotArea: { x: 0, y: 0, width: a.W, height: a.H } }, theme: {} };
          let bmp: ImageBitmap | null = null;
          const bitmapOk = await waitFor(() => {
            bmp = getChartMarkBitmap(scriptId, "e2e-key", item, a.W, a.H, 1);
            return !!bmp;
          }, 8000);

          let pixel: number[] | null = null;
          let bw = 0;
          let bh = 0;
          const drawn = bmp as ImageBitmap | null;
          if (drawn) {
            bw = drawn.width;
            bh = drawn.height;
            const c = document.createElement("canvas");
            c.width = bw;
            c.height = bh;
            const cx = c.getContext("2d")!;
            cx.drawImage(drawn, 0, 0);
            const p = cx.getImageData(Math.floor(bw / 2), Math.floor(bh / 2), 1, 1).data;
            pixel = [p[0], p[1], p[2], p[3]];
          }

          return { hookOk, registered, bitmapOk, bw, bh, pixel };
        } finally {
          try { uninstallChartMarks(); } catch { /* best-effort cleanup */ }
        }
      },
      { MARK_ID, W, H },
    );

    expect(result.error ?? "").toBe("");
    // The mark mounted as a real worker-realm script + declared its renderer hook.
    expect(result.hookOk).toBe(true);
    // The shim was registered so charts can dispatch spec.mark==="sandbox:e2e".
    expect(result.registered).toBe(true);
    // The host received an ImageBitmap transferred from the worker.
    expect(result.bitmapOk).toBe(true);
    expect(result.bw).toBeGreaterThan(0);
    expect(result.bh).toBeGreaterThan(0);
    // The mark's red fill survived worker -> OffscreenCanvas -> ImageBitmap -> host.
    expect(result.pixel).toEqual([255, 0, 0, 255]);
  });
});
