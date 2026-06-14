/**
 * Wave 3 / S8-C7 Phase B — distributed extension worker-realm isolation, e2e.
 *
 * Proves the production path end-to-end through the real ExtensionManager worker
 * route (mountWorkerExtension):
 *   1. A bundle declaring workerSupport:true is imported INSIDE a hardened worker
 *      (never on the main thread) and activates there.
 *   2. Its command registration becomes a host-side proxy command; executing it
 *      RPCs the handler back into the worker (the closure never crosses).
 *   3. The handler's privileged calls go through the SAME tier broker, so the
 *      R19 declared-capability ceiling enforces: the extension declared only
 *      `storage`, so its attempt to use `net.fetch` is denied — visible in the
 *      audit ring as a cap.fetch entry with ok:false / PermissionDenied.
 *
 * The audit ring gives a deterministic observation (no UI/consent timing). The
 * ambient-authority neutering is the SAME shared hardening the object-script
 * worker e2e + the NEUTERED_GLOBALS unit test already cover.
 */
import { test, expect } from "../fixtures";

const FIXTURE_SOURCE = `
export default {
  manifest: {
    id: "e2e.worker.ext",
    name: "E2E Worker Ext",
    version: "1.0.0",
    workerSupport: true,
    capabilities: ["storage"]
  },
  activate(ctx) {
    ctx.commands.register("probe", async () => {
      // net.fetch is NOT in this extension's declared ceiling -> must be denied.
      try {
        await ctx.capabilities.fetch("https://example.com/data");
        return "allowed";
      } catch (e) {
        return "denied:" + (e && e.code);
      }
    });
  }
};
`;

test.describe("Worker-isolated extension (Phase B)", () => {
  test("workerSupport extension runs sandboxed; command proxy works; ceiling denies undeclared caps", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(async (source) => {
      const host = await (window as any).__calcImport(
        new URL("/src/api/scriptHost/index.ts", document.baseURI).href,
      );
      const commandsMod = await (window as any).__calcImport(
        new URL("/src/api/commands.ts", document.baseURI).href,
      );
      const {
        mountWorkerExtension,
        unmountWorkerExtension,
        listWorkerExtensions,
        clearAudit,
        getAuditTail,
      } = host;
      const { CommandRegistry } = commandsMod;

      clearAudit();
      const mount = await mountWorkerExtension(source, "E2E Worker Ext");
      const listed = listWorkerExtensions().find((x: any) => x.extId === "e2e.worker.ext");

      // Execute the proxy command -> RPC into the worker handler (which attempts
      // the undeclared net.fetch and gets denied by the broker).
      try {
        await CommandRegistry.execute("ext:e2e.worker.ext:probe");
      } catch {
        /* command handler swallows the denial; nothing should throw here */
      }
      await new Promise((r) => setTimeout(r, 150));

      const audit = getAuditTail() as Array<{ scriptId: string; method: string; ok: boolean; error?: string }>;
      const fetchEntry = audit.find(
        (a) => a.scriptId === "extension:e2e.worker.ext" && a.method === "cap.fetch",
      );

      await unmountWorkerExtension("e2e.worker.ext");
      const afterUnmount = listWorkerExtensions().find((x: any) => x.extId === "e2e.worker.ext");

      return {
        mountOk: mount.ok === true,
        mountError: mount.error ?? "",
        declaredCaps: listed?.declaredCapabilities ?? [],
        fetchAudited: !!fetchEntry,
        fetchDenied: fetchEntry ? fetchEntry.ok === false : null,
        fetchError: fetchEntry?.error ?? null,
        unmounted: afterUnmount === undefined,
      };
    }, FIXTURE_SOURCE);

    // The bundle mounted in a worker (workerSupport accepted).
    expect(result.mountError).toBe("");
    expect(result.mountOk).toBe(true);
    // Its authoritative ceiling is exactly what it declared.
    expect(result.declaredCaps).toEqual(["storage"]);
    // The command proxy reached the worker handler, whose net.fetch went through
    // the broker and was denied by the R19 ceiling (net.fetch not declared).
    expect(result.fetchAudited).toBe(true);
    expect(result.fetchDenied).toBe(true);
    expect(result.fetchError).toBe("PermissionDenied");
    // Clean teardown.
    expect(result.unmounted).toBe(true);
  });
});
