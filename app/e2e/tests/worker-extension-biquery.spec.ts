/**
 * Wave 3 — bi.query (structured, model-scoped) reached through the worker-realm
 * extension path end-to-end. Proves the executor is wired: a worker extension
 * declaring bi.query, once GRANTED, can call ctx.capabilities.listBiConnections,
 * and the broker admits it (declared + granted) and the host executor runs
 * (bi_get_connections returns successfully) — visible in the audit ring as a
 * cap.biListConnections entry with ok:true.
 *
 * bi.query is pre-granted in the test to skip the JIT consent prompt (no UI in
 * e2e). The deny-path (undeclared capability -> ceiling) is already covered by
 * worker-extension.spec.ts; the bi.query-specific logic (validator, credential
 * whitelist, ceiling) is unit-tested in biQuery.test.ts.
 */
import { test, expect } from "../fixtures";

const FIXTURE_SOURCE = `
export default {
  manifest: {
    id: "e2e.biq.ext",
    name: "BI Query Ext",
    version: "1.0.0",
    workerSupport: true,
    capabilities: ["bi.query"]
  },
  activate(ctx) {
    ctx.commands.register("list", async () => {
      const conns = await ctx.capabilities.listBiConnections();
      return Array.isArray(conns) ? conns.length : -1;
    });
  }
};
`;

test.describe("Worker extension bi.query (Wave 3)", () => {
  test("declared + granted bi.query reaches the model-scoped executor", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(async (source) => {
      const host = await (window as any).__calcImport(
        new URL("/src/api/scriptHost/index.ts", document.baseURI).href,
      );
      const caps = await (window as any).__calcImport(
        new URL("/src/api/scriptHost/capabilities.ts", document.baseURI).href,
      );
      const commandsMod = await (window as any).__calcImport(
        new URL("/src/api/commands.ts", document.baseURI).href,
      );
      const { mountWorkerExtension, unmountWorkerExtension, clearAudit, getAuditTail } = host;
      const { recordCapabilityGrant } = caps;
      const { CommandRegistry } = commandsMod;

      clearAudit();
      const mount = await mountWorkerExtension(source, "BI Query Ext");
      // Pre-grant bi.query to skip the JIT consent prompt (no UI in e2e).
      recordCapabilityGrant("extension:e2e.biq.ext", "bi.query");

      try {
        await CommandRegistry.execute("ext:e2e.biq.ext:list");
      } catch {
        /* command swallows errors */
      }
      await new Promise((r) => setTimeout(r, 150));

      const audit = getAuditTail() as Array<{ scriptId: string; method: string; ok: boolean; error?: string }>;
      const entry = audit.find(
        (a) => a.scriptId === "extension:e2e.biq.ext" && a.method === "cap.biListConnections",
      );

      await unmountWorkerExtension("e2e.biq.ext");
      return {
        mountOk: mount.ok === true,
        mountError: mount.error ?? "",
        audited: !!entry,
        executorOk: entry ? entry.ok === true : null,
        executorError: entry?.error ?? null,
      };
    }, FIXTURE_SOURCE);

    expect(result.mountError).toBe("");
    expect(result.mountOk).toBe(true);
    // The broker admitted the declared+granted call and the host executor ran
    // (bi_get_connections returned — no connections configured, so an empty list).
    expect(result.audited).toBe(true);
    expect(result.executorOk).toBe(true);
  });
});
