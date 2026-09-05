/**
 * M6a — DOES THE `ui.html` SRCDOC BRIDGE ACTUALLY EXECUTE?
 *
 * THE QUESTION. The shared frame builder (`buildScriptFrameDocument`) and its
 * duplicate in `ControlsPane/components/CustomControlHost.tsx` inject an INLINE
 * `<script>` into an `allow-scripts`-only `srcdoc` iframe, and the shipped shape
 * templates drive that bridge from INLINE `onclick=` attributes. The app ships
 * `script-src 'self' blob:` — no `'unsafe-inline'`, no nonce, no hash
 * (`app/src-tauri/tauri.conf.json`, pinned by
 * `extensions/Controls/__tests__/srcdocBridgeCsp.test.ts`). A `srcdoc` document
 * has no origin of its own and inherits its embedder's policy container, so on
 * paper both halves of the bridge are refused. Nothing in the repo has ever
 * measured it. This spec measures it.
 *
 * WHY THE MEASUREMENT NEEDS ITS OWN GUARD — AND THIS IS THE WHOLE POINT.
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

/** The probe frame's id, and the instance id the bridge is built with. */
const FRAME_ID = "calcula-csp-probe-frame";
const PROBE_INSTANCE = "csp-probe-instance";

/**
 * The product's own injected `<script>` block, with its named placeholders
 * resolved the way `buildScriptFrameDocument` resolves them, PLUS the protocol
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
function productBridge(): { script: string; tag: string } {
  const src = fs.readFileSync(FRAME_DOCUMENT, "utf8");
  const start = src.indexOf("export function buildScriptFrameDocument(");
  if (start < 0) {
    throw new Error("frameDocument.ts no longer declares buildScriptFrameDocument");
  }
  const block = /<script[^>]*>[\s\S]*?<\/script>/.exec(src.slice(start));
  if (!block) throw new Error("buildScriptFrameDocument injects no <script> block");
  const tagMatch = /export const SCRIPT_FRAME_MESSAGE_TAG = "([^"]+)";/.exec(src);
  if (!tagMatch) {
    throw new Error("frameDocument.ts no longer declares SCRIPT_FRAME_MESSAGE_TAG");
  }
  const idLiteral = JSON.stringify(PROBE_INSTANCE).replace(/</g, "\\u003c");
  // The template literal's named interpolations, resolved. Anything ELSE that
  // looks like an interpolation would mean the bridge grew one this spec does
  // not know about and is no longer building what the product builds.
  const resolved = block[0]
    .replace("${idLiteral}", idLiteral)
    .replace(/\$\{tagLiteral\}/g, JSON.stringify(tagMatch[1]));
  if (resolved.includes("${")) {
    throw new Error(
      `the bridge grew an interpolation this spec does not resolve: ${resolved}`,
    );
  }
  return { script: resolved, tag: tagMatch[1] };
}

/** Everything one run measures. Every field is a fact, not a verdict. */
interface ProbeResult {
  /** Did an inline <script> appended to the MAIN document run? */
  mainInlineRan: boolean;
  /** Did the bridge's own inline <script> run inside the srcdoc child? */
  frameBootRan: boolean;
  /** Did the frame's inline onclick= handler reach `calcula.sendMessage`? */
  gestureArrived: boolean;
  /** Did the gesture's message pass the host's `e.source` identity check? */
  gesturePassedIdentityCheck: boolean;
  /** Raw message types the host saw, in order. */
  received: string[];
  /**
   * CSP violations reported in the PARENT document while the probe ran. The
   * child's own refusals fire `securitypolicyviolation` on the CHILD document,
   * which an opaque-origin frame will not let the parent read — so an empty
   * list here is not evidence that the child was allowed to run. Only
   * `frameBootRan` answers that.
   */
  violations: string[];
  /** The document URL — `http://localhost:5173/...` in dev, `http://tauri.localhost/...` bundled. */
  documentUrl: string;
}

test.describe("ui.html srcdoc bridge under the app CSP", () => {
  test("a user gesture inside a sandboxed srcdoc frame reaches the host through the product's bridge, under an ENFORCED CSP", async ({
    appPage: page,
  }) => {
    // ---- WHICH BUILD IS THIS? Asked before anything is installed in the page,
    // because the answer decides whether a verdict taken here is about the
    // shipped security surface or about a dev server that ships none. The skip
    // reason carries the whole explanation into the report, so a skipped run
    // still tells the reader what to run instead.
    const flavor = classifyDocumentSource(
      await page.evaluate(() => document.URL),
      readConfiguredDevUrl(),
    );
    test.info().annotations.push({
      type: "csp-srcdoc-bridge:build",
      description: JSON.stringify(flavor),
    });
    test.skip(!flavor.cspVerdictMeaningful, flavor.reason);

    const { script: bridge, tag: messageTag } = productBridge();

    // ---- Install the host side and the frame. The frame FILLS itself with the
    // button, so the gesture is a click on the frame's centre and this spec
    // never has to reach inside an opaque-origin document to find a target.
    await page.evaluate(
      ({ bridgeScript, frameId, instanceId, sourceTag }) => {
        /* eslint-disable @typescript-eslint/naming-convention */
        const w = window as unknown as Window & {
          __cspProbe?: {
            mainInlineRan: boolean;
            received: string[];
            identityOk: boolean;
            violations: string[];
            frame: HTMLIFrameElement | null;
          };
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        const state = {
          mainInlineRan: false,
          received: [] as string[],
          identityOk: false,
          violations: [] as string[],
          frame: null as HTMLIFrameElement | null,
        };
        w.__cspProbe = state;

        document.addEventListener("securitypolicyviolation", (e) => {
          state.violations.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"}`);
        });

        // (1) IS A CSP ENFORCED AT ALL? An inline <script> in the MAIN document
        // is the same permission the srcdoc child needs, measured where there is
        // no inheritance question to argue about.
        const probeTag = document.createElement("script");
        probeTag.textContent =
          "(window).__cspProbe && ((window).__cspProbe.mainInlineRan = true);";
        document.head.appendChild(probeTag);
        probeTag.remove();

        // (2) THE HOST LISTENER, the same filter the shared router applies.
        window.addEventListener("message", (e) => {
          const d = e.data as { source?: string; instanceId?: string; type?: string } | undefined;
          if (!d || d.source !== sourceTag || d.instanceId !== instanceId) return;
          state.received.push(String(d.type));
          if (state.frame && e.source === state.frame.contentWindow) state.identityOk = true;
        });

        // (3) THE FRAME. `allow-scripts` only — the product's sandbox, which
        // gives the document an opaque origin and leaves it inheriting the
        // embedder's policy container.
        const frame = document.createElement("iframe");
        frame.id = frameId;
        frame.sandbox.add("allow-scripts");
        frame.style.position = "fixed";
        frame.style.left = "40px";
        frame.style.top = "220px";
        frame.style.width = "240px";
        frame.style.height = "120px";
        frame.style.border = "0";
        frame.style.zIndex = "2147483647";
        frame.style.background = "#ffffff";
        frame.srcdoc =
          "<!DOCTYPE html>\n<html><head>\n<meta charset=\"utf-8\">\n" +
          bridgeScript +
          "\n<script>window.calcula && calcula.sendMessage('boot');</script>\n" +
          "</head><body style=\"margin:0\">" +
          "<button id=\"probe\" style=\"width:100%;height:100%;border:0;font-size:16px\" " +
          "onclick=\"calcula.sendMessage('gesture')\">probe</button>" +
          "</body></html>";
        state.frame = frame;
        document.body.appendChild(frame);
      },
      {
        bridgeScript: bridge,
        frameId: FRAME_ID,
        instanceId: PROBE_INSTANCE,
        sourceTag: messageTag,
      },
    );

    try {
      // The srcdoc document loads and (if permitted) boots on its own tick.
      await page.waitForTimeout(1_000);

      const box = await page.locator(`#${FRAME_ID}`).boundingBox();
      expect(box, "the probe frame reports no box — it never laid out").not.toBeNull();

      // THE GESTURE. Real pixels, real mouse, on a button that fills the frame.
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForTimeout(800);

      const result = await page.evaluate((): ProbeResult => {
        /* eslint-disable @typescript-eslint/naming-convention */
        const w = window as unknown as Window & {
          __cspProbe: {
            mainInlineRan: boolean;
            received: string[];
            identityOk: boolean;
            violations: string[];
          };
        };
        /* eslint-enable @typescript-eslint/naming-convention */
        const s = w.__cspProbe;
        return {
          mainInlineRan: s.mainInlineRan,
          frameBootRan: s.received.includes("boot"),
          gestureArrived: s.received.includes("gesture"),
          gesturePassedIdentityCheck: s.identityOk,
          received: s.received,
          violations: s.violations,
          documentUrl: document.URL,
        };
      });

      // The whole matrix, always printed, whether the test passes or fails —
      // the measurement is the deliverable here, not the pass/fail bit.
      console.log("[csp-srcdoc-bridge]", JSON.stringify(result, null, 2));
      test.info().annotations.push({
        type: "csp-srcdoc-bridge",
        description: JSON.stringify(result),
      });

      // SOFT, all three, so ONE run reports every verdict instead of stopping
      // at the first. A soft failure still fails the test.
      expect
        .soft(
          result.mainInlineRan,
          "NO CSP IS BEING ENFORCED IN THIS BUILD, so this run cannot answer the M6a question. " +
            "An inline <script> appended to the main document executed, which means script-src " +
            "is not in force here. On Windows desktop `tauri dev` loads the document straight " +
            "from devUrl and never touches the tauri:// asset protocol — the only place tauri " +
            "2.9.5 sets the Content-Security-Policy header (src/protocol/tauri.rs:213) — because " +
            "PROXY_DEV_SERVER = cfg!(all(dev, mobile)) (src/manager/webview.rs:40). Re-run this " +
            "spec against a BUNDLED build. Document URL: " +
            result.documentUrl,
        )
        .toBe(false);
      expect
        .soft(
          result.frameBootRan,
          "The bridge's inline <script> did not execute inside the srcdoc child. That is the " +
            "M6a finding: `window.calcula` never exists, so `render.setHtmlContent` produces a " +
            "frame that can paint but can never talk back, and every shipped shape template " +
            "that calls calcula.sendMessage is inert. Violations: " +
            JSON.stringify(result.violations),
        )
        .toBe(true);
      expect
        .soft(
          result.gestureArrived && result.gesturePassedIdentityCheck,
          "A real click on the frame did not reach the host through the bridge. Received: " +
            JSON.stringify(result.received) +
            "; identity check passed: " +
            result.gesturePassedIdentityCheck +
            "; violations: " +
            JSON.stringify(result.violations),
        )
        .toBe(true);
    } finally {
      // Unconditional: a fixed-position frame at zIndex 2147483647 left behind
      // is an opaque click-eater over the next spec's grid, and this suite
      // shares one app instance and one accumulating document.
      await page.evaluate((frameId) => {
        document.getElementById(frameId)?.remove();
        /* eslint-disable-next-line @typescript-eslint/naming-convention */
        delete (window as unknown as { __cspProbe?: unknown }).__cspProbe;
      }, FRAME_ID);
    }
  });
});
