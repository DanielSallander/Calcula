/**
 * Wave 2 Phase 3 Day-1 platform spike (sandbox design §13 risk 1).
 *
 * Verifies the two WebView2 behaviors the worker realm depends on, under the
 * real CSP:
 *  1. Blob-ESM compilation INSIDE a module worker: Blob -> createObjectURL ->
 *     dynamic import() — the no-unsafe-eval compilation path (R2).
 *  2. OffscreenCanvas in a worker: 2D context with real text metrics, and
 *     transferToImageBitmap() transferred to the host, drawable there (R4).
 *
 * If either fails here, the pre-designed fallbacks apply (new Function in
 * worker / display-list record-replay) — see the design doc before changing
 * the realm architecture.
 */
import { test, expect } from "../fixtures";

interface SpikeResult {
  ok: boolean;
  error?: string;
  blobImportValue?: number;
  contextValue?: string;
  textWidth?: number;
  bitmapWidth?: number;
  bitmapHeight?: number;
  hostDrawnPixel?: number[];
}

test.describe("Worker realm platform spike", () => {
  test("diagnostics: which worker mechanisms does the platform allow", async ({ appPage: page }) => {
    const matrix = await page.evaluate(async () => {
      const cspViolations: string[] = [];
      window.addEventListener("securitypolicyviolation", (e) => {
        cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
      });

      function probeWorker(source: string, options?: WorkerOptions): Promise<string> {
        return new Promise((resolve) => {
          try {
            const blob = new Blob([source], { type: "text/javascript" });
            const url = URL.createObjectURL(blob);
            const w = new Worker(url, options);
            const t = setTimeout(() => {
              w.terminate();
              resolve("timeout");
            }, 3000);
            w.onmessage = () => {
              clearTimeout(t);
              w.terminate();
              resolve("ok");
            };
            w.onerror = (e) => {
              clearTimeout(t);
              w.terminate();
              resolve(`onerror: ${e.message || "(no message)"}`);
            };
          } catch (err) {
            resolve(`throw: ${String(err)}`);
          }
        });
      }

      const classicBlob = await probeWorker(`postMessage("hi");`);
      const moduleBlob = await probeWorker(`postMessage("hi");`, { type: "module" });
      const moduleBlobWithImport = await probeWorker(
        `const b = new Blob(["export default 42;"], {type:"text/javascript"});
         const u = URL.createObjectURL(b);
         import(u).then((m) => postMessage(m.default)).catch((e) => { throw e; });`,
        { type: "module" },
      );
      const offscreenMain = typeof OffscreenCanvas !== "undefined" ? "present" : "absent";

      // Give violation events a tick to land.
      await new Promise((r) => setTimeout(r, 100));

      return { classicBlob, moduleBlob, moduleBlobWithImport, offscreenMain, cspViolations };
    });

    console.log("[spike diagnostics]", JSON.stringify(matrix, null, 2));
    expect(matrix.offscreenMain).toBe("present");
  });

  test("the production bootstrap worker spawns and compiles via blob-ESM import", async ({ appPage: page }) => {
    // Exercises the REAL Phase 3 path: hostValidateScript spawns the actual
    // bootstrap worker (Vite-served URL module worker — NOT a blob worker,
    // which the diagnostics show this platform rejects) and compiles the
    // source via blob-ESM import() INSIDE that worker.
    const env = await page.evaluate(() => ({
      href: String(window.location.href),
      origin: String(window.location.origin),
      baseURI: String(document.baseURI),
      title: String(document.title),
    }));
    console.log("[spike env]", JSON.stringify(env));

    const result = await page.evaluate(async () => {
      try {
        // page.evaluate runs as a base-URL-less classic script — dynamic
        // import needs an absolute URL to resolve against the dev server.
        // (location.origin is "null" under the harness; baseURI is real.)
        const moduleUrl = new URL("/src/api/scriptHost/host.ts", document.baseURI).href;
        const importer = new Function("u", "return import(u);") as (u: string) => Promise<unknown>;
        const host = (await importer(moduleUrl)) as {
          hostValidateScript: (source: string) => Promise<{ valid: boolean; error?: string }>;
        };
        const good = await host.hostValidateScript("function setup(ctx) { return 42; }");
        const bad = await host.hostValidateScript("function setup(ctx) { return 42; "); // syntax error
        return { ok: true, good, bad };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    expect(result.error ?? "").toBe("");
    expect(result.ok).toBe(true);
    // Valid source compiles inside the worker (URL module worker + blob import work).
    expect(result.good).toEqual({ valid: true, error: undefined });
    // Broken source surfaces a syntax error — proving import() actually parsed it
    // (a worker that failed to spawn would time out instead).
    expect(result.bad?.valid).toBe(false);
    expect(result.bad?.error ?? "").not.toBe("");
  });

  test("OffscreenCanvas bitmaps render in a worker and blit on the host", async ({ appPage: page }) => {
    // Canvas mechanics don't depend on module-ness — probe them in a classic
    // blob worker (which the platform allows; the production path runs the
    // same code inside the URL-loaded bootstrap worker).
    const result: SpikeResult = await page.evaluate(async () => {
      const workerSource = `
        self.onmessage = function() {
          try {
            var dpr = 2;
            var oc = new OffscreenCanvas(64 * dpr, 32 * dpr);
            var ctx = oc.getContext("2d");
            if (!ctx) throw new Error("no 2d context on OffscreenCanvas");
            ctx.scale(dpr, dpr);
            ctx.fillStyle = "#ff0000";
            ctx.fillRect(0, 0, 64, 32);
            ctx.font = "12px sans-serif";
            var metrics = ctx.measureText("hello metrics");
            var bitmap = oc.transferToImageBitmap();
            self.postMessage({ ok: true, textWidth: metrics.width, bitmap: bitmap }, [bitmap]);
          } catch (err) {
            self.postMessage({ ok: false, error: String(err) });
          }
        };
      `;
      const workerBlob = new Blob([workerSource], { type: "text/javascript" });
      const worker = new Worker(URL.createObjectURL(workerBlob));

      return await new Promise<SpikeResult>((resolve) => {
        const timeout = setTimeout(() => {
          worker.terminate();
          resolve({ ok: false, error: "timeout waiting for worker (5s)" });
        }, 5000);
        worker.onerror = (e) => {
          clearTimeout(timeout);
          worker.terminate();
          resolve({ ok: false, error: "worker onerror: " + (e.message || "unknown") });
        };
        worker.onmessage = (e) => {
          clearTimeout(timeout);
          const data = e.data as { ok: boolean; error?: string; textWidth?: number; bitmap?: ImageBitmap };
          try {
            if (!data.ok || !data.bitmap) {
              resolve({ ok: false, error: data.error || "no bitmap returned" });
              return;
            }
            const canvas = document.createElement("canvas");
            canvas.width = data.bitmap.width;
            canvas.height = data.bitmap.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              resolve({ ok: false, error: "no host 2d context" });
              return;
            }
            ctx.drawImage(data.bitmap, 0, 0);
            const pixel = ctx.getImageData(10, 10, 1, 1).data;
            resolve({
              ok: true,
              textWidth: data.textWidth,
              bitmapWidth: data.bitmap.width,
              bitmapHeight: data.bitmap.height,
              hostDrawnPixel: [pixel[0], pixel[1], pixel[2], pixel[3]],
            });
          } finally {
            worker.terminate();
          }
        };
        worker.postMessage("go");
      });
    });

    expect(result.error ?? "").toBe("");
    expect(result.ok).toBe(true);
    // Real text metrics (not a stub).
    expect(result.textWidth).toBeGreaterThan(10);
    // dpr-scaled bitmap dimensions survived the transfer.
    expect(result.bitmapWidth).toBe(128);
    expect(result.bitmapHeight).toBe(64);
    // The host drew the worker's red fill — the blit path is real.
    expect(result.hostDrawnPixel).toEqual([255, 0, 0, 255]);
  });
});
