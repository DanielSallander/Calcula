/**
 * M6c — DOES THE `ui.html` LOADER BRIDGE ACTUALLY EXECUTE? (BUG-0113)
 *
 * THE ANSWER, MEASURED 2026-09-13 against a real `tauri build --no-bundle`
 * serving from `http://tauri.localhost/`: **yes**. `ready: true`,
 * `identityOk: true`, zero CSP violations, and a real mouse click on an INLINE
 * `onclick=` reached the host.
 *
 * WHAT THIS REPLACED. Until 2026-09-13 this file measured the SRCDOC bridge and
 * was expected to fail — that was the M6a finding, and the measurement is
 * recorded rather than re-run: `mainInlineRan: false` (a CSP is enforced),
 * `frameBootRan: false`, `violations: ["script-src-elem blocked inline"]`. A
 * `srcdoc` child gets a CLONE of its embedder's policy container, so the app's
 * `script-src 'self' blob:` — no `'unsafe-inline'`, no nonce, no hash — landed
 * inside the frame and refused the bridge. The frame still painted, so
 * display-only templates looked perfect and only the ones that talk back were
 * dead.
 *
 * That half is GONE from this file on purpose. It could only ever fail, and a
 * permanently-red test is how a suite acquires a known-failures list — after
 * which the day someone adds `'unsafe-inline'` to `script-src` and it turns
 * green for the wrong reason goes unnoticed. `srcdocBridgeCsp.test.ts` still
 * pins the app's policy against exactly that.
 *
 * WHAT IS MEASURED NOW. The bridge is served from Rust over the
 * `calcula-frame` URI scheme (`app/src-tauri/src/script_frame.rs`) with its OWN
 * `Content-Security-Policy` response header, so the frame document gets its own
 * policy container instead of a clone of the app's. The loader IS the bridge;
 * the script's HTML arrives afterwards as a `calcula.setContent` message and is
 * installed as a BODY SWAP. The app's own `script-src` is untouched.
 *
 * WHY THE MEASUREMENT NEEDS ITS OWN GUARD — AND THIS IS STILL THE WHOLE POINT.
 * **`tauri dev` on Windows desktop enforces no CSP at all.** In tauri 2.9.5 the
 * only code that attaches a `Content-Security-Policy` header is the `tauri://`
 * asset protocol (`src/protocol/tauri.rs:213-214`), and that protocol serves the
 * main document only when the webview is pointed at it. In dev the webview is
 * pointed straight at `devUrl` (`AppManager::base_path` under `#[cfg(dev)]`
 * returns `build.devUrl`) because the dev-server proxy is compiled out on
 * desktop: `PROXY_DEV_SERVER = cfg!(all(dev, mobile))`
 * (`src/manager/webview.rs:40`). Vite sends no CSP header and `app/index.html`
 * carries no CSP `<meta>`. So `devCsp` is dead text on this platform, and this
 * suite — which launches `cargo tauri dev` — runs with inline script ALLOWED.
 *
 * A GREEN HERE THEREFORE PROVES NOTHING UNLESS A CSP WAS ACTUALLY ENFORCED, so
 * enforcement is measured first and asserted alongside the bridge result. Run
 * this against a BUNDLED build (`npm run e2e:platform:manual` against an
 * installed/`tauri build` binary already running) to get the answer that
 * governs what users run.
 *
 * WHERE THIS SPEC RUNS, and why it is not in the functional suite. It lives in
 * the `platform` project (playwright.config.ts) and is `testIgnore`d out of
 * `functional`, the project `npm run e2e` and the nightly workflow drive. Both
 * halves of that placement are load-bearing:
 *
 *   - The functional suite launches `cargo tauri dev`, where — by the paragraph
 *     above — no CSP is delivered at all. Collected there, this spec would be
 *     RED on every nightly run for a cause nobody can act on until the
 *     custom-URI-scheme route lands. A permanent red is how a suite acquires a
 *     known-failures list, and once it has one, the day somebody adds
 *     `'unsafe-inline'` to `script-src` and this spec turns green for the wrong
 *     reason goes unnoticed. That is the failure this placement prevents.
 *   - Being invoked deliberately is still not enough, because `--project=
 *     platform` without `E2E_MANUAL=1` launches `tauri dev` too. So the test
 *     ALSO reads the document URL it is actually running against
 *     (`e2e/helpers/buildFlavor.ts`) and SKIPS, with the reason, rather than
 *     reporting a verdict about an unprotected build. The gate keys on WHERE
 *     the document is served from, never on whether a CSP was observed — a gate
 *     that skipped when no policy was seen would silence precisely the
 *     regression the first assertion exists to catch.
 *
 * Expect the second and third assertions to FAIL against a bundled build today.
 * That failure IS the M6a finding, and it is the reason this spec is invoked by
 * hand rather than swept up by a suite.
 *
 * WHAT IS DRIVEN. The frame is built from the PRODUCT's own bridge text, read
 * out of the ONE shared builder (extensions/_shared/scriptFrame/frameDocument.ts)
 * at spec time rather than paraphrased here, so this
 * cannot drift into testing a bridge the app does not ship. The gesture is a
 * real `page.mouse.click` on real pixels of a real frame, and the host observes
 * it exactly as the shared router does — a `window` `message` listener filtered
 * on the protocol's `source` tag, READ out of that same builder rather than
 * spelled here, with an `e.source` identity check.
 *
 * WHAT IS NOT DRIVEN, and why. This does not create a shape control, mount a
 * shape script, declare hit regions and click a shim. That path is M6's own
 * ledger item ("e2e coverage of a user gesture reaching the bridge") and needs
 * the whole rig in `journeys/on-grid-forms.spec.ts`. It would answer the same
 * platform question through four extra layers, any one of which could fail for
 * an unrelated reason and be mistaken for a CSP verdict. The mechanism is
 * isolated here on purpose.
 */
import { test, expect } from "../fixtures";
import { classifyDocumentSource, readConfiguredDevUrl } from "../helpers/buildFlavor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// M6b extracted the bridge out of shapeRenderer.ts and CustomControlHost.tsx
// into ONE module; this spec follows it there, because reading a copy is how a
// probe starts testing a bridge the app no longer ships.
const FRAME_DOCUMENT = path.resolve(
  HERE,
  "../../extensions/_shared/scriptFrame/frameDocument.ts",
);

/**
 * The loader route's two literals, read from the product rather than spelled
 * here, PLUS the protocol
 * tag the host half filters on. Read from the source file because the function
 * is not exported, and because a paraphrase would let the shipped bridge change
 * under a still-green spec.
 *
 * The tag is read rather than typed out for the same reason. It used to be a
 * literal in the host listener below, which made this probe agree with itself
 * while the product forked: the bridge now interpolates
 * `SCRIPT_FRAME_MESSAGE_TAG` instead of spelling it, so a rename moves both ends
 * of what this spec measures and neither end is written down here.
 */
/** The loader route's two literals, read from the product rather than spelled here.
 *
 *  runs a census that the protocol tag is written in
 * ONE directory and nowhere else, and it caught this spec hardcoding it. That
 * census is right: a poster and a listener that stop agreeing fail silently —
 * the message is simply never delivered, with no error at either end. */
function loaderContract(): { tag: string; origin: string } {
  const src = fs.readFileSync(FRAME_DOCUMENT, "utf8");
  const tag = /export const SCRIPT_FRAME_MESSAGE_TAG = "([^"]+)";/.exec(src);
  const origin = /export const SCRIPT_FRAME_LOADER_ORIGIN = "([^"]+)";/.exec(src);
  if (!tag) throw new Error("frameDocument.ts no longer declares SCRIPT_FRAME_MESSAGE_TAG");
  if (!origin) throw new Error("frameDocument.ts no longer declares SCRIPT_FRAME_LOADER_ORIGIN");
  return { tag: tag[1], origin: origin[1] };
}


test.describe("ui.html loader bridge under the app CSP", () => {
  test("the LOADER route's bridge runs and an inline onclick reaches the host, under an ENFORCED CSP", async ({
    appPage: page,
  }) => {
    const flavor = classifyDocumentSource(
      await page.evaluate(() => document.URL),
      readConfiguredDevUrl(),
    );
    test.info().annotations.push({
      type: "csp-loader-bridge:build",
      description: JSON.stringify(flavor),
    });
    test.skip(!flavor.cspVerdictMeaningful, flavor.reason);

    const LOADER_FRAME_ID = "calcula-csp-loader-probe";
    const LOADER_INSTANCE = "csp-loader-probe-instance";

    await page.evaluate(
      ({ frameId, instanceId, sourceTag, loaderOrigin }) => {
        /* eslint-disable @typescript-eslint/naming-convention */
        const w = window as unknown as Window & {
          __loaderProbe?: {
            received: string[];
            identityOk: boolean;
            violations: string[];
            frame: HTMLIFrameElement | null;
            ready: boolean;
            sizes: string[];
            refusals: string[];
            pushAttempts: number;
            pushError: string;
          };
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        const state = {
          received: [] as string[],
          identityOk: false,
          violations: [] as string[],
          frame: null as HTMLIFrameElement | null,
          ready: false,
          sizes: [] as string[],
          refusals: [] as string[],
          pushAttempts: 0,
          pushError: "",
        };
        w.__loaderProbe = state;

        document.addEventListener("securitypolicyviolation", (e) => {
          state.violations.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
        });

        // The host half, filtering exactly as the shared router does.
        window.addEventListener("message", (e) => {
          const d = e.data as { source?: string; instanceId?: string; type?: string } | undefined;
          if (!d || d.source !== sourceTag || d.instanceId !== instanceId) return;
          if (state.frame && e.source === state.frame.contentWindow) state.identityOk = true;
          if (d.type === "calcula.frameReady") {
            state.ready = true;
            // Push content the moment the loader says it is listening — the
            // product's own ready gate. The button FILLS the frame so the
            // gesture below is a click on the frame's centre.
            state.pushAttempts += 1;
            try {
              if (!state.frame?.contentWindow) state.pushError = "no contentWindow";
            } catch (err) {
              state.pushError = String(err);
            }
            state.frame?.contentWindow?.postMessage(
              {
                target: sourceTag,
                instanceId,
                type: "calcula.setContent",
                data: {
                  html:
                    '<button id="probe" style="position:fixed;inset:0;width:100%;height:100%;border:0;font-size:16px" ' +
                    "onclick=\"calcula.sendMessage('gesture')\">probe</button>" +
                    '<img src="x" onerror="calcula.sendMessage(&#39;autofire&#39;)">',
                  themeCss: ":root {\n  }",
                },
              },
              "*",
            );
            return;
          }
          state.received.push(String(d.type));
          if (d.type === "calcula.frameRefused") {
            state.refusals.push(JSON.stringify((e.data as { data?: unknown }).data));
          }
          if (d.type === "calcula.size") {
            const sz = (e.data as { data?: { width?: number; height?: number } }).data;
            state.sizes.push(`${sz?.width}x${sz?.height}`);
          }
        });

        const frame = document.createElement("iframe");
        frame.id = frameId;
        // The SAME sandbox the product uses. The opaque origin — and therefore
        // the isolation — comes from here, not from the scheme.
        frame.sandbox.add("allow-scripts");
        frame.style.position = "fixed";
        frame.style.left = "40px";
        frame.style.top = "380px";
        frame.style.width = "240px";
        frame.style.height = "120px";
        frame.style.border = "0";
        frame.style.zIndex = "2147483647";
        frame.style.background = "#ffffff";
        state.frame = frame;
        // The id rides in the URL, which is how the loader can name itself in
        // its ready announcement and pass the host's `e.source` check.
        frame.src = `${loaderOrigin}/?id=${encodeURIComponent(instanceId)}`;
        document.body.appendChild(frame);
      },
      {
        frameId: LOADER_FRAME_ID,
        instanceId: LOADER_INSTANCE,
        sourceTag: loaderContract().tag,
        loaderOrigin: loaderContract().origin,
      },
    );

    try {
      // Fetch + parse + boot + ready + the content push, all on their own ticks.
      await page.waitForTimeout(2_000);

      const beforeClick = await page.evaluate(() => {
        /* eslint-disable @typescript-eslint/naming-convention */
        const w = window as unknown as Window & {
          __loaderProbe: { ready: boolean; violations: string[] };
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        return { ready: w.__loaderProbe.ready, violations: [...w.__loaderProbe.violations] };
      });
      test.info().annotations.push({
        type: "csp-loader-bridge:ready",
        description: JSON.stringify(beforeClick),
      });

      // THE FIRST VERDICT, and the one that separates "the fix works" from
      // "the frame never loaded at all".
      expect(
        beforeClick.ready,
        "the loader never announced itself. Either the custom scheme did not " +
          "serve the frame (the wry ICoreWebView2_22 floor — see this test's " +
          "header), or the app's frame-src refused the origin before the " +
          "frame's own policy was ever consulted.",
      ).toBe(true);

      // A SECOND push, from OUTSIDE the ready handler. If the first was lost to
      // a race (posted while the frame was still settling) this one lands and
      // the difference says so; if neither lands the channel itself is the
      // problem, not the timing.
      await page.evaluate(({ instanceId, sourceTag }) => {
        /* eslint-disable @typescript-eslint/naming-convention */
        const w = window as unknown as Window & {
          __loaderProbe: { frame: HTMLIFrameElement | null; pushAttempts: number };
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        w.__loaderProbe.pushAttempts += 1;
        w.__loaderProbe.frame?.contentWindow?.postMessage(
          {
            target: sourceTag,
            instanceId,
            type: "calcula.setContent",
            data: {
              html:
                '<button id="probe" style="position:fixed;inset:0;width:100%;height:100%;border:0;font-size:16px" ' +
                "onclick=\"calcula.sendMessage('gesture')\">probe</button>" +
                    '<img src="x" onerror="calcula.sendMessage(&#39;autofire&#39;)">',
              themeCss: ":root {}",
            },
          },
          "*",
        );
      }, { instanceId: LOADER_INSTANCE, sourceTag: loaderContract().tag });
      await page.waitForTimeout(800);
      const box = await page.locator(`#${LOADER_FRAME_ID}`).boundingBox();
      expect(box, "the loader frame reports no box — it never laid out").not.toBeNull();

      // THE GESTURE. Real pixels, real mouse, on an INLINE onclick — the shape
      // no nonce can rescue and the reason the whole route exists.
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForTimeout(800);

      const result = await page.evaluate(() => {
        /* eslint-disable @typescript-eslint/naming-convention */
        const w = window as unknown as Window & {
          __loaderProbe: {
            received: string[];
            identityOk: boolean;
            violations: string[];
            ready: boolean;
            sizes: string[];
            refusals: string[];
            pushAttempts: number;
            pushError: string;
          };
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        const p = w.__loaderProbe;
        return {
          received: [...p.received],
          identityOk: p.identityOk,
          violations: [...p.violations],
          ready: p.ready,
          sizes: [...p.sizes],
          refusals: [...p.refusals],
          pushAttempts: p.pushAttempts,
          pushError: p.pushError,
        };
      });
      console.log("[csp-loader-bridge]", JSON.stringify(result, null, 2));
      test.info().annotations.push({
        type: "csp-loader-bridge",
        description: JSON.stringify(result),
      });

      expect(
        result.received,
        "the loader booted but the inline onclick never reached the host. The " +
          "bridge is installed (ready fired), so this is the content push or " +
          "the inline-handler permission — i.e. the frame's own CSP, not the " +
          "app's.",
      ).toContain("gesture");
      expect(
        result.identityOk,
        "the message arrived from a window that is not this frame's — the " +
          "host's e.source check would reject it in the product",
      ).toBe(true);
    } finally {
      await page.evaluate((frameId) => {
        document.getElementById(frameId)?.remove();
        delete (window as unknown as Record<string, unknown>).__loaderProbe;
      }, LOADER_FRAME_ID);
    }
  });
});
