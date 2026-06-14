/**
 * Phase 4.3 (storage half) — the `storage` capability round-trip through the
 * REAL production path: worker shim -> tier broker -> host executor -> .cala
 * virtual filesystem -> back.
 *
 *   shape.caps.storage.set(k, v)   (worker shim)
 *     -> call "cap.storageSet"      (broker: storage declared (R19) + granted)
 *       -> host executor writes .calcula/script-data/<scriptId>.json
 *   shape.caps.storage.get(k)
 *     -> call "cap.storageGet"
 *       -> host executor reads the same file back
 *
 * Mirrors worker-realm-blit.spec.ts: mounts a synthetic SHAPE script via the
 * real ObjectScriptManager + worker realm (no backend object needed — the
 * shape snapshot tolerates an unknown id), grants `storage` programmatically
 * (no consent dialog in e2e), and calls an exposed roundtrip method via @api.
 *
 * Assertions:
 *   1. roundtrip("hello","world123") returns "world123" (set -> disk -> get).
 *   2. A value over the 256 KB quota is REJECTED before any write.
 */
import { test, expect } from "../fixtures";

test.describe("Capability: storage (Phase 4.3)", () => {
  test("storage set/get round-trips through the worker shim, broker, and host executor", async ({
    appPage: page,
  }) => {
    // Unique ids so reruns / parallel specs never collide on the on-disk store.
    const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const instanceId = `storage-shape-${uniq}`;
    const scriptId = `storage-test-${uniq}`;

    const result = await page.evaluate(
      async (a) => {
        // page.evaluate is a classic script — dynamic import via the dev-only
        // __calcImport helper (no `new Function`, so no 'unsafe-eval'), with an
        // absolute Vite URL (same trick as worker-realm-blit).
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        const { ObjectScriptManager, callExposedMethod, listExposedMethods, recordCapabilityGrant } = api;
        if (!ObjectScriptManager || !callExposedMethod || !listExposedMethods || !recordCapabilityGrant) {
          return {
            error: `missing @api exports: ${[
              !ObjectScriptManager && "ObjectScriptManager",
              !callExposedMethod && "callExposedMethod",
              !listExposedMethods && "listExposedMethods",
              !recordCapabilityGrant && "recordCapabilityGrant",
            ]
              .filter(Boolean)
              .join(", ")}`,
          };
        }

        const scriptDef = {
          id: a.scriptId,
          name: "Storage Round-trip Test",
          objectType: "shape",
          instanceId: a.instanceId,
          source:
            "// @capability storage\n" +
            "function setup(shape){ shape.expose('roundtrip', async function(k,v){ await shape.caps.storage.set(k,v); return await shape.caps.storage.get(k); }); }",
          accessLevel: "restricted",
          // R19 ceiling: registered directly (not via save_object_script), so we
          // must set the declared-capability ceiling ourselves or the broker
          // denies `storage` before the grant check.
          declaredCapabilities: ["storage"],
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
          const mountedOk = ObjectScriptManager.isScriptMounted(scriptDef.id);

          // Grant `storage` programmatically — no consent dialog in e2e. The
          // broker now admits cap.storageGet / cap.storageSet for this script.
          recordCapabilityGrant(scriptDef.id, "storage");

          // The worker compiled the script and setup() ran base.expose
          // (a fire-and-forget RPC) — poll until "roundtrip" is registered.
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
                  m.methodName === "roundtrip",
              );
            } catch {
              return false;
            }
          }, 8000);

          // 1. set -> disk -> get round-trip. (callExposedMethod returns the
          //    relay promise; await it.)
          const roundtripped = await callExposedMethod(
            "shape",
            a.instanceId,
            "roundtrip",
            "hello",
            "world123",
          );

          // 2. Over-quota set must REJECT (no write happens; the prior store on
          //    disk is preserved). The call rejects.
          let quotaRejected = false;
          let quotaError = "";
          try {
            await callExposedMethod(
              "shape",
              a.instanceId,
              "roundtrip",
              "big",
              "x".repeat(300000),
            );
          } catch (e: any) {
            quotaRejected = true;
            quotaError = e instanceof Error ? e.message : String(e);
          }

          return { mountedOk, exposedOk, roundtripped, quotaRejected, quotaError };
        } finally {
          try {
            ObjectScriptManager.unmountScript(scriptDef.id);
            ObjectScriptManager.removeScript(scriptDef.id);
          } catch {
            /* best-effort cleanup */
          }
        }
      },
      { scriptId, instanceId },
    );

    expect(result.error ?? "").toBe("");
    // The script mounted in the real worker realm and setup() exposed the method.
    expect(result.mountedOk).toBe(true);
    expect(result.exposedOk).toBe(true);
    // set -> host executor -> .cala file -> get returned the stored value: the
    // full path (worker shim + broker gate + host executor + virtual FS) works.
    expect(result.roundtripped).toBe("world123");
    // A value beyond the 256 KB per-script quota is rejected (nothing written).
    expect(result.quotaRejected).toBe(true);
  });
});
