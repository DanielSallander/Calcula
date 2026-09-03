/**
 * A GRANT MUST COME FROM A SCREEN THE EXTENSION ISSUED.
 *
 * This spec used to reach a distributed consent prompt by EMITTING
 * "scriptable-objects:consent-needed" itself — a hand-built payload shaped like
 * the one `loadAndMountScripts` builds — because `save_object_script`
 * deliberately refuses to let the renderer mint `provenance: "distributed"`, so
 * there is no other way to get a distributed prompt without a real `.calp` pull.
 * It then clicked the real "Allow Scripts" button and asserted the script
 * mounted with its declared capability working.
 *
 * THAT SHORTCUT IS NOW REFUSED, ON PURPOSE, and this spec pins the refusal.
 *
 * The defect it closes: the prompt listed the workbook once, and the
 * `consent-granted` handler received only `{ packageName }` and RE-DERIVED the
 * artifact set from a second, independent listing. The dialog is non-modal and
 * `AppEvents.PACKAGE_UPDATED` re-runs the whole load, so an update landing while
 * the user read the screen made Allow record a set the screen never showed —
 * the transparency requirement exactly inverted. A grant is now tied to the
 * screen that produced it: `emitPackageConsentPrompt` is the single emitter,
 * it stamps a `promptId` and holds the artifact set that screen enumerated, and
 * a grant that names no standing screen is refused and nothing is recorded.
 *
 * A fabricated event still RENDERS a dialog — the dialog is driven by the event,
 * and in-page code can dispatch one — but pressing Allow on it now grants
 * nothing, mounts nothing, and writes no consent record. That is the property
 * worth having a live test for, and it is what this file asserts.
 *
 * WHERE THE OLD COVERAGE WENT, so nothing is silently dropped:
 *   * grant -> mount -> the capability actually working, over a REAL publish +
 *     subscribe + pull: `e2e/journeys/script-form-distributed.spec.ts`
 *     ("a declined package's form never appears…" and "approving the package
 *     mounts its form…"), which needs ONE click because the extension issued
 *     the screen.
 *   * a SOURCE change re-prompting, and the capability-expansion matrix:
 *     `extensions/ScriptableObjects/__tests__/packageMacroConsent.test.ts` and
 *     `packageConsentLoadPath.test.ts`, both of which run the REAL consent store
 *     over an in-memory filesystem and assert on the byte-level JSON Rust reads.
 *   * the storage capability round-trip: `e2e/tests/capability-storage.spec.ts`.
 *
 * Mirrors the page-evaluate + dynamic-@api-import style of
 * worker-realm-blit.spec.ts and capability-storage.spec.ts.
 */
import { test, expect } from "../fixtures";

test.describe("Distributed script consent flow", () => {
  test("a consent-granted event that names no standing screen grants nothing and mounts nothing", async ({
    appPage: page,
  }) => {
    // Unique ids so reruns / parallel specs never collide on grants or the
    // on-disk consent/store files.
    const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const instanceId = `consent-shape-${uniq}`;
    const scriptId = `consent-test-${uniq}`;
    const packageName = "e2e-consent-pkg";
    const capDescription = "store data on this device"; // CAP_DESCRIPTION.storage
    const scriptName = "Consent Round-trip Test";

    // Declares ONLY `storage`. If the refused grant leaked a capability anyway,
    // the round-trip below would succeed and this test would fail.
    const source =
      "// @capability storage\n" +
      "function setup(shape){ shape.expose('rt', async function(){ await shape.caps.storage.set('ck','consented'); return await shape.caps.storage.get('ck'); }); }";

    const setup = await page.evaluate(
      async (a) => {
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        const { ObjectScriptManager, getScriptGrants, emitAppEvent } = api;
        if (!ObjectScriptManager || !getScriptGrants || !emitAppEvent) {
          return {
            error: `missing @api exports: ${[
              !ObjectScriptManager && "ObjectScriptManager",
              !getScriptGrants && "getScriptGrants",
              !emitAppEvent && "emitAppEvent",
            ]
              .filter(Boolean)
              .join(", ")}`,
          };
        }

        ObjectScriptManager.registerScript({
          id: a.scriptId,
          name: a.scriptName,
          objectType: "shape",
          instanceId: a.instanceId,
          source: a.source,
          accessLevel: "restricted",
          provenance: "distributed",
          packageName: a.packageName,
          declaredCapabilities: ["storage"],
          description: null,
        });

        const mountedBefore = ObjectScriptManager.isScriptMounted(a.scriptId);
        const grantsBefore = getScriptGrants(a.scriptId).caps as string[];

        // The payload `loadAndMountScripts` builds — but emitted by us, so no
        // `promptId` and no pending grant behind it.
        emitAppEvent("scriptable-objects:consent-needed", {
          packageName: a.packageName,
          scriptCount: 1,
          scriptNames: [a.scriptName],
          scriptIds: [a.scriptId],
          requestedCapabilities: [
            { capability: "storage", description: a.capDescription, origins: [] },
          ],
        });

        return { mountedBefore, grantsBefore };
      },
      { scriptId, scriptName, instanceId, source, packageName, capDescription },
    );

    expect(setup.error ?? "").toBe("");
    expect(setup.mountedBefore).toBe(false);
    expect(setup.grantsBefore).not.toContain("storage");

    try {
      // The dialog IS rendered — it is driven by the event, and that is not the
      // boundary. Located by visible TEXT: styled-components hash their class
      // names, so never locate by class (the project's e2e dialog gotcha).
      await expect(page.getByText(`"${packageName}"`, { exact: false })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText(capDescription, { exact: false })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText(scriptName, { exact: false })).toBeVisible({
        timeout: 10_000,
      });

      // Press the REAL Allow button on the fabricated screen.
      const allow = page.getByRole("button", { name: "Allow Scripts" });
      await expect(allow).toBeVisible({ timeout: 10_000 });
      await allow.click();
      await expect(allow).toBeHidden({ timeout: 10_000 });

      // The handler refuses, and `repromptPackage` finds nothing to ask about:
      // it reads the STORE (`loadAllObjectScripts`), and this script was only
      // ever registered in the session's ObjectScriptManager. So no second
      // screen appears — and, crucially, nothing was granted.
      const result = await page.evaluate(
        async (a) => {
          const api = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          const { ObjectScriptManager, getScriptGrants, callExposedMethod } = api;

          // Give any async grant/mount path a real chance to land before
          // asserting it did NOT: asserting a negative immediately would pass
          // against an implementation that simply takes one more microtask.
          const t0 = Date.now();
          while (Date.now() - t0 < 3000) {
            if (ObjectScriptManager.isScriptMounted(a.scriptId)) break;
            await new Promise((r) => setTimeout(r, 100));
          }

          let rt: unknown = null;
          let rtError: string | null = null;
          try {
            rt = await callExposedMethod(a.scriptId, "rt", []);
          } catch (e) {
            rtError = e instanceof Error ? e.message : String(e);
          }

          return {
            mounted: ObjectScriptManager.isScriptMounted(a.scriptId) as boolean,
            grants: getScriptGrants(a.scriptId).caps as string[],
            rt,
            rtError,
          };
        },
        { scriptId },
      );

      expect(
        result.mounted,
        "a grant tied to no screen the extension issued must not mount the script",
      ).toBe(false);
      expect(
        result.grants,
        "...and must not grant the capability the fabricated screen asked for",
      ).not.toContain("storage");
      // The capability genuinely does not work: nothing mounted, so there is no
      // realm to answer. (A leaked grant would have returned "consented".)
      expect(result.rt).not.toBe("consented");
    } finally {
      // Never leave a registered script or an open modal behind for the next
      // spec — a stranded modal holds the app-wide slot and the wedge guard
      // would blame whichever spec runs next.
      await page.evaluate(
        async (a) => {
          const api = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          try {
            await api.ObjectScriptManager.unmountScript(a.scriptId);
          } catch {
            /* not mounted, which is the expected state */
          }
          try {
            api.ObjectScriptManager.removeScript(a.scriptId);
          } catch {
            /* best effort */
          }
        },
        { scriptId },
      );
    }
  });
});
