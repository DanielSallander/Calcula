/**
 * B3 TOFU extension consent + B2 main-thread refusal — end-to-end through the
 * REAL ExtensionManager, no disk file needed.
 *
 * A disk-scanned DISTRIBUTED extension must NOT auto-activate on first sight:
 * loadExtension's consent gate LISTS it (needsConsent) WITHOUT importing its
 * code, until the user grants first-use consent. We drive the real singleton
 * with a synthetic scan entry (page.evaluate has no TS access control, the same
 * white-box seam consent-flow.spec.ts uses for ObjectScriptManager):
 *
 *   1. loadExtension(synthetic entry) -> the extension is LISTED inactive +
 *      needsConsent + isAwaitingConsent, and its code NEVER ran (no window
 *      marker) — the gate held it back without importing the bundle.
 *   2. grantConsentAndActivate(id) -> consent recorded, pending cleared; because
 *      the bundle declares workerSupport:false, the main thread REFUSES it (B2),
 *      so it is blocked (status:error) and STILL never imported.
 *
 * The exhaustive store/hash matrix lives in extensionConsentStore.test.ts; this
 * is the live-wired smoke of the gate in the running app. Mirrors the
 * page-evaluate + dynamic-@api-import style of consent-flow.spec.ts.
 */
import { test, expect } from "../fixtures";

const CONSENT_STORAGE_KEY = "calcula.extensions.consent";

test.describe("Distributed extension consent gate (B3) + main-thread refusal (B2)", () => {
  test("an un-consented disk extension is listed-but-not-mounted; granting clears the prompt and the bundle never runs unsandboxed", async ({
    appPage: page,
  }) => {
    // Unique ids so reruns / parallel specs never collide on grants or the list.
    const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const extId = `e2e-consent-ext-${uniq}`;
    const fileName = `${extId}.js`;
    const markerKey = `__E2E_EXT_RAN_${uniq}__`;

    const before = await page.evaluate(
      async (a) => {
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        if (!api.getExtensionManager) return { error: "missing @api export getExtensionManager" };
        const ExtensionManager = api.getExtensionManager();

        // A sidecar-manifest DISTRIBUTED bundle declaring workerSupport:false.
        // The content sets a window marker IF it is ever imported — it must not be.
        const entry = {
          fileName: a.fileName,
          path: `/virtual/${a.fileName}`,
          content:
            `window['${a.markerKey}'] = true; ` +
            `export default { manifest: { id: '${a.extId}', name: 'E2E Consent Ext', version: '0.0.0' }, activate() {} };`,
          manifestJson: JSON.stringify({
            id: a.extId,
            name: "E2E Consent Ext",
            version: "0.0.0",
            capabilities: [],
            workerSupport: false,
          }),
          trustStatus: "unsigned",
        };

        // Drive the real (private) loader with the synthetic scan entry.
        await (ExtensionManager as any).loadExtension(entry);

        const ext = ExtensionManager.getExtensions().find((e: any) => e.id === a.extId);
        return {
          error: "",
          listed: !!ext,
          needsConsent: ext?.needsConsent === true,
          status: ext?.status,
          awaiting: ExtensionManager.isAwaitingConsent(a.extId),
          ran: (window as any)[a.markerKey] === true,
        };
      },
      { extId, fileName, markerKey },
    );

    expect(before.error ?? "").toBe("");
    // Held back by the consent gate: listed, inactive, awaiting — never imported.
    expect(before.listed).toBe(true);
    expect(before.needsConsent).toBe(true);
    expect(before.status).toBe("inactive");
    expect(before.awaiting).toBe(true);
    expect(before.ran).toBe(false);

    try {
      const after = await page.evaluate(
        async (a) => {
          const api = await (window as any).__calcImport(
            new URL("/src/api/index.ts", document.baseURI).href,
          );
          const ExtensionManager = api.getExtensionManager();

          // Grant first-use consent (what the manager's "Allow" button does).
          await ExtensionManager.grantConsentAndActivate(a.extId);

          const all = ExtensionManager.getExtensions();
          // After grant the pending (id-keyed) entry is replaced; a refused
          // workerSupport:false distributed bundle is re-listed by the B2 path,
          // which keys the BLOCKED entry by fileName (recordBlockedExtension uses
          // `fileName ?? name`). Find it either way so the test tracks the real
          // behavior rather than a specific keying.
          const blocked = all.find((e: any) => e.id === a.fileName || e.fileName === a.fileName);
          return {
            awaiting: ExtensionManager.isAwaitingConsent(a.extId),
            blockedStatus: blocked?.status,
            blockedTrust: blocked?.trust,
            ran: (window as any)[a.markerKey] === true,
          };
        },
        { extId, fileName, markerKey },
      );

      // Consent recorded -> no longer pending.
      expect(after.awaiting).toBe(false);
      // workerSupport:false distributed code is REFUSED on the main thread (B2):
      // re-listed as blocked (status:error), and STILL never imported.
      expect(after.blockedStatus).toBe("error");
      expect(after.blockedTrust).toBe("distributed");
      expect(after.ran).toBe(false);
    } finally {
      // Best-effort teardown: drop the synthetic listed entry + its consent record
      // so it does not leak into other specs sharing this app instance.
      await page.evaluate(
        async (a) => {
          try {
            const api = await (window as any).__calcImport(
              new URL("/src/api/index.ts", document.baseURI).href,
            );
            const ExtensionManager = api.getExtensionManager();
            // The entry may be keyed by id (pending) or fileName (blocked) — drop both.
            (ExtensionManager as any).extensions?.delete(a.extId);
            (ExtensionManager as any).extensions?.delete(a.fileName);
            (ExtensionManager as any).updateCachedArray?.();
            (ExtensionManager as any).notifyChange?.();
            const raw = localStorage.getItem(a.key);
            if (raw) {
              const obj = JSON.parse(raw);
              delete obj[a.extId];
              localStorage.setItem(a.key, JSON.stringify(obj));
            }
          } catch {
            /* best-effort cleanup */
          }
        },
        { extId, fileName, key: CONSENT_STORAGE_KEY },
      );
    }
  });
});
