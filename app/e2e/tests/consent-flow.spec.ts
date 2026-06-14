/**
 * Phase 4.4 CONSENT-FLOW gate — distributed-script package consent, end-to-end
 * through the REAL UI path:
 *
 *   loadAndMountScripts() emits "scriptable-objects:consent-needed"
 *     -> the ScriptableObjects extension queues + SHOWS ScriptConsentDialog
 *       -> the dialog renders the package, its scripts, and the REQUESTED caps
 *         -> user clicks "Allow Scripts"
 *           -> dialog emits "scriptable-objects:consent-granted"
 *             -> index.ts granted-handler GRANTS the declared caps
 *                (applyConsentedCapabilities) + MOUNTS each distributed script
 *                + recordConsent(...)
 *
 * The test emits the consent-needed event directly (exactly the payload
 * loadAndMountScripts builds), which avoids needing a real .calp pull, then
 * drives the REAL dialog: it asserts the package name + the requested
 * capability's human description are visible (by TEXT — styled-components/inline
 * styles, so never by class), clicks the real "Allow Scripts" button, and proves
 * the grant took effect:
 *
 *   1. ObjectScriptManager.isScriptMounted(scriptId) === true
 *   2. getScriptGrants(scriptId).caps includes "storage"
 *   3. callExposedMethod(...,"rt",...) returns "consented" — a storage set->get
 *      round-trip through the granted+declared capability (the cap actually
 *      works via the consented grant, not a side-channel).
 *
 * Re-prompt coverage: after granting, the test asserts IN-PAGE (via the same
 * isConsentCurrent the loader uses) that a SOURCE change makes the package no
 * longer "current" — i.e. it would re-prompt. (The exhaustive pragma-tamper /
 * cap-expansion matrix lives in the consentStore unit tests; this is the
 * live-wired smoke of the same guard.)
 *
 * Mirrors the page-evaluate + dynamic-@api-import style of
 * worker-realm-blit.spec.ts and capability-storage.spec.ts.
 */
import { test, expect } from "../fixtures";

test.describe("Distributed script consent flow (Phase 4.4)", () => {
  test("granting consent for a distributed package mounts its script with the declared capability working, and a source change re-prompts", async ({
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

    // The script declares ONLY `storage` and exposes "rt": a storage set->get
    // round-trip that only succeeds if the consented grant admits cap.storage*.
    const source =
      "// @capability storage\n" +
      "function setup(shape){ shape.expose('rt', async function(){ await shape.caps.storage.set('ck','consented'); return await shape.caps.storage.get('ck'); }); }";

    // 1. Register the DISTRIBUTED script (NOT mounted, NOT yet granted), then
    //    emit the consent-needed event exactly as loadAndMountScripts would.
    const setup = await page.evaluate(
      async (a) => {
        const importer = new Function("u", "return import(u);") as (
          u: string,
        ) => Promise<any>;
        const api = await importer(
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

        const scriptDef = {
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
        };

        ObjectScriptManager.registerScript(scriptDef);

        // Pre-conditions: fresh scriptId -> not mounted, no grants yet.
        const mountedBefore = ObjectScriptManager.isScriptMounted(scriptDef.id);
        const grantsBefore = getScriptGrants(scriptDef.id).caps as string[];

        // Emit the consent prompt — the exact payload loadAndMountScripts emits.
        emitAppEvent("scriptable-objects:consent-needed", {
          packageName: a.packageName,
          scriptCount: 1,
          scriptNames: [a.scriptName],
          scriptIds: [scriptDef.id],
          requestedCapabilities: [
            {
              capability: "storage",
              description: a.capDescription,
              origins: [],
            },
          ],
        });

        return {
          mountedBefore,
          grantsBefore,
        };
      },
      {
        scriptId,
        scriptName,
        instanceId,
        source,
        packageName,
        capDescription,
      },
    );

    expect(setup.error ?? "").toBe("");
    // Fresh script: not mounted and no granted caps before consent.
    expect(setup.mountedBefore).toBe(false);
    expect(setup.grantsBefore).not.toContain("storage");

    try {
      // 3. Wait for the REAL ScriptConsentDialog and assert by visible TEXT
      //    (inline styles / hashed class names — locate by content, per the
      //    project's e2e dialog-selector gotcha).
      // Package name appears inside a <strong>"e2e-consent-pkg"</strong>.
      await expect(page.getByText(`"${packageName}"`, { exact: false }))
        .toBeVisible({ timeout: 10_000 });
      // The requested capability is shown by its human description.
      await expect(page.getByText(capDescription, { exact: false }))
        .toBeVisible({ timeout: 10_000 });
      // The script name is listed.
      await expect(page.getByText(scriptName, { exact: false }))
        .toBeVisible({ timeout: 10_000 });

      // 4. Click the REAL "Allow Scripts" button (locate by its text). This
      //    fires consent-granted; the index.ts handler grants + mounts.
      await page.getByRole("button", { name: "Allow Scripts" }).click();

      // 5. + 6. Back in the page: poll until mounted + granted, then prove the
      //    capability actually works through the consented grant.
      const result = await page.evaluate(
        async (a) => {
          const importer = new Function("u", "return import(u);") as (
            u: string,
          ) => Promise<any>;
          const api = await importer(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          const {
            ObjectScriptManager,
            getScriptGrants,
            callExposedMethod,
            listExposedMethods,
          } = api;

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

          // The granted-handler mounts asynchronously — poll until mounted.
          const mountedOk = await waitFor(
            () => ObjectScriptManager.isScriptMounted(a.scriptId) === true,
            10_000,
          );

          const grants = getScriptGrants(a.scriptId).caps as string[];
          const hasStorageGrant = grants.includes("storage");

          // setup() ran shape.expose("rt") in the worker realm — poll until the
          // exposed method is registered before calling it.
          const exposedOk = await waitFor(() => {
            try {
              const list = listExposedMethods() as Array<{
                objectType: string;
                instanceId: string | null;
                methodName: string;
              }>;
              return list.some(
                (m) =>
                  m.objectType === "shape" &&
                  m.instanceId === a.instanceId &&
                  m.methodName === "rt",
              );
            } catch {
              return false;
            }
          }, 10_000);

          // The cap actually works through the consented grant: storage set->get.
          let roundtripped: unknown = null;
          let roundtripError = "";
          try {
            roundtripped = await callExposedMethod(
              "shape",
              a.instanceId,
              "rt",
            );
          } catch (e: any) {
            roundtripError = e instanceof Error ? e.message : String(e);
          }

          return {
            mountedOk,
            grants,
            hasStorageGrant,
            exposedOk,
            roundtripped,
            roundtripError,
          };
        },
        { scriptId, instanceId },
      );

      // 5. The script mounted via the real consent-granted handler.
      expect(result.mountedOk).toBe(true);
      // ...and the declared cap was GRANTED through the consent path.
      expect(result.hasStorageGrant).toBe(true);
      expect(result.grants).toContain("storage");
      expect(result.exposedOk).toBe(true);
      // 6. The capability works end-to-end through the consented grant.
      expect(result.roundtripError).toBe("");
      expect(result.roundtripped).toBe("consented");

      // Re-prompt smoke (Task 3): the same guard the loader uses
      // (isConsentCurrent) must report the package as NO LONGER current once a
      // script's SOURCE changes — i.e. it would re-prompt. The exhaustive
      // pragma-tamper / cap-expansion matrix is covered by the consentStore
      // unit tests; this is the live-wired smoke of that guard.
      const reprompt = await page.evaluate(
        async (a) => {
          const importer = new Function("u", "return import(u);") as (
            u: string,
          ) => Promise<any>;
          // The consentStore module lives under the extension tree; import it
          // by absolute Vite URL the same way we import @api.
          const cs = await importer(
            new URL(
              "/extensions/ScriptableObjects/lib/consentStore.ts",
              document.baseURI,
            ).href,
          );
          const { isConsentCurrent } = cs;
          if (!isConsentCurrent) {
            return { error: "missing consentStore.isConsentCurrent export" };
          }

          // Build a record that matches the ORIGINAL source + the storage grant.
          const record = {
            packageName: a.packageName,
            scripts: [{ id: a.scriptId, sourceHash: await cs.sha256Hex(a.source) }],
            grantedCapabilities: [{ capability: "storage" }],
            grantedAt: new Date().toISOString(),
          };

          // Same source -> current (no re-prompt).
          const currentUnchanged = await isConsentCurrent(
            [record],
            a.packageName,
            [{ id: a.scriptId, source: a.source }],
          );

          // Changed source -> NOT current (would re-prompt).
          const tampered =
            a.source + "\n// tampered after consent\nvoid 0;";
          const currentAfterChange = await isConsentCurrent(
            [record],
            a.packageName,
            [{ id: a.scriptId, source: tampered }],
          );

          return { currentUnchanged, currentAfterChange };
        },
        { scriptId, packageName, source },
      );

      expect(reprompt.error ?? "").toBe("");
      // Unchanged source stays consented; a source change re-prompts.
      expect(reprompt.currentUnchanged).toBe(true);
      expect(reprompt.currentAfterChange).toBe(false);
    } finally {
      // Cleanup: unmount + remove the script and close any lingering dialog.
      await page.evaluate(
        async (a) => {
          try {
            const importer = new Function("u", "return import(u);") as (
              u: string,
            ) => Promise<any>;
            const api = await importer(
              new URL("/src/api/index.ts", document.baseURI).href,
            );
            const { ObjectScriptManager } = api;
            ObjectScriptManager.unmountScript(a.scriptId);
            ObjectScriptManager.removeScript(a.scriptId);
          } catch {
            /* best-effort cleanup */
          }
        },
        { scriptId },
      );
      // Dismiss any dialog that may still be open (e.g. on assertion failure).
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(50);
      }
    }
  });
});
