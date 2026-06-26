/**
 * .calp consent gate for sandboxed CHART libraries (transforms / marks), end-to-end
 * through the REAL shared consent store + capability grant:
 *
 *   evaluateLibraryConsent(distributed library) -> "needs-consent"  (NOT mounted)
 *     -> user Allows -> grantLibraryConsent: applyConsentedCapabilities + install
 *        + recordConsent(namespacedKey, [{id, syntheticSource}], grants) into the
 *        workbook .cala virtual filesystem
 *       -> a fresh evaluateLibraryConsent now returns "installed" (consent current)
 *         -> a library EDIT (synthetic-source change) makes it "needs-consent" again
 *
 * This live-wires the gate (extensions/Charts/lib/distributedLibraryGate) against
 * the REAL @api/distributedConsent store + capability grant set — proving a
 * distributed transform library does NOT auto-mount, that consent unlocks + grants
 * its declared capability, and that an upstream change re-prompts. The dialog event
 * contract + the gate decision matrix are covered by the unit tests; this is the
 * live-wired smoke. Mirrors the page-evaluate + dynamic-@api-import style of
 * consent-flow.spec.ts and sandbox-mark-blit.spec.ts.
 */
import { test, expect } from "../fixtures";

test.describe("Chart library .calp consent gate", () => {
  test("a distributed transform library is gated until consent, then its capability works and an edit re-prompts", async ({
    appPage: page,
  }) => {
    const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const sourcePackage = `e2e-chart-pkg-${uniq}`;

    const result = await page.evaluate(async (a) => {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      const gate = await (window as any).__calcImport(
        new URL("/extensions/Charts/lib/distributedLibraryGate.ts", document.baseURI).href,
      );
      const { CHART_TRANSFORMS_SCRIPT_ID, transformLibraryConsentSource, getScriptGrants, emitAppEvent } = api;
      const { isLibraryConsentCurrent, mountConsentedLibrary, grantLibraryConsent } = gate;
      if (!isLibraryConsentCurrent || !mountConsentedLibrary || !grantLibraryConsent || !transformLibraryConsentSource) {
        return { error: "missing gate / @api exports" };
      }

      // A distributed transform library declaring bi.query.
      const lib = { transforms: [{ type: "sandbox:demo", label: "Demo", body: "return data;" }], capabilities: ["bi.query"] };
      let installed = 0;
      const makeDescriptor = (l: any) => ({
        scriptId: CHART_TRANSFORMS_SCRIPT_ID,
        consentKey: `chart-transforms:${a.sourcePackage}`,
        displayPackage: a.sourcePackage,
        artifactLabel: "chart transform",
        itemNames: l.transforms.map((t: any) => t.label),
        capabilities: l.capabilities,
        syntheticSource: transformLibraryConsentSource(l),
        install: async () => { installed++; },
      });

      // 1. No consent yet -> gated (NOT current, nothing installed).
      const currentBefore = await isLibraryConsentCurrent(makeDescriptor(lib));
      const installedAfterCheck = installed;
      const grantsBefore = (getScriptGrants(CHART_TRANSFORMS_SCRIPT_ID).caps as string[]).includes("bi.query");

      // 2. User Allows -> grant + install + persist consent. (The Charts dialog emits
      //    "charts:library-consent-granted"; here we call the grant path directly,
      //    which is exactly what the granted handler invokes.)
      await grantLibraryConsent(makeDescriptor(lib));
      const installedAfterGrant = installed;
      const grantsAfter = (getScriptGrants(CHART_TRANSFORMS_SCRIPT_ID).caps as string[]).includes("bi.query");

      // 3. Fresh check now finds a current consent -> the gate would mount (no prompt).
      const currentAfter = await isLibraryConsentCurrent(makeDescriptor(lib));
      await mountConsentedLibrary(makeDescriptor(lib));
      const installedAfterRemount = installed;

      // 4. Editing the library (a new transform) changes the synthetic source ->
      //    consent no longer current -> would re-prompt.
      const editedLib = { transforms: [...lib.transforms, { type: "sandbox:demo2", label: "Demo2", body: "return data;" }], capabilities: ["bi.query"] };
      const currentAfterEdit = await isLibraryConsentCurrent(makeDescriptor(editedLib));

      // Keep emitAppEvent referenced (the real granted handler uses this channel).
      void emitAppEvent;
      return { currentBefore, installedAfterCheck, grantsBefore, installedAfterGrant, grantsAfter, currentAfter, installedAfterRemount, currentAfterEdit };
    }, { sourcePackage });

    expect(result.error).toBeUndefined();
    // 1. Gated: not current, nothing installed, no grant — a PURE check has no side effects.
    expect(result.currentBefore).toBe(false);
    expect(result.installedAfterCheck).toBe(0);
    expect(result.grantsBefore).toBe(false);
    // 2. Consent grants the capability + installs.
    expect(result.installedAfterGrant).toBe(1);
    expect(result.grantsAfter).toBe(true);
    // 3. Remembered: a later check is current and mounting installs again.
    expect(result.currentAfter).toBe(true);
    expect(result.installedAfterRemount).toBe(2);
    // 4. An upstream edit re-prompts (consent keyed by source hash).
    expect(result.currentAfterEdit).toBe(false);
  });
});
