/**
 * Wave 3 follow-ups, e2e (one app launch):
 *  - Item 2 (menus): a worker extension registers a menu item; it appears in the
 *    real menu registry, clicking it relays through the host to the worker
 *    command handler, and it is torn down on unmount.
 *  - Item 1 (authoritative manifest): a verified sidecar manifest OVERRIDES the
 *    worker-reported one — its declared ceiling is what the broker enforces — and
 *    a bundle whose id disagrees with the signed manifest is rejected.
 *  - Item 3 (bi.sql): the higher-trust raw-SQL capability is wired end-to-end
 *    (declared + granted -> broker admits -> host executor reaches script_bi_sql).
 */
import { test, expect } from "../fixtures";

test.describe("Worker extension follow-ups (Wave 3)", () => {
  test("item 2 — a worker extension menu item registers, relays on click, and tears down", async ({
    appPage: page,
  }) => {
    const source = `
      export default {
        manifest: { id:"e2e.menu.ext", name:"Menu Ext", version:"1.0.0", workerSupport:true, capabilities:[] },
        activate(ctx){
          ctx.commands.register("act", async () => { ctx.ui.notifications.showToast("clicked", { type: "info" }); });
          ctx.ui.menus.registerMenuItem("data", { id:"myitem", label:"My Item", command:"act" });
        }
      };`;
    const result = await page.evaluate(async (src: string) => {
      const host = await (window as any).__calcImport(new URL("/src/api/scriptHost/index.ts", document.baseURI).href);
      const ui = await (window as any).__calcImport(new URL("/src/api/ui.ts", document.baseURI).href);
      const { mountWorkerExtension, unmountWorkerExtension, clearAudit, getAuditTail } = host;
      const { getMenus } = ui;

      clearAudit();
      const mount = await mountWorkerExtension(src, "Menu Ext");

      const findItem = () => {
        for (const m of getMenus() as Array<{ id: string; items: Array<{ id: string; action?: () => void }> }>) {
          if (m.id === "data") return m.items.find((it) => it.id === "ext:e2e.menu.ext:myitem");
        }
        return undefined;
      };
      const item = findItem();
      const registered = !!item;
      // Simulate a click -> runs the namespaced command -> worker handler -> ext.notify.
      item?.action?.();
      await new Promise((r) => setTimeout(r, 200));
      const notified = (getAuditTail() as Array<{ scriptId: string; method: string; ok: boolean }>).some(
        (a) => a.scriptId === "extension:e2e.menu.ext" && a.method === "ext.notify" && a.ok === true,
      );

      await unmountWorkerExtension("e2e.menu.ext");
      const removed = !findItem();
      return { mountOk: mount.ok === true, registered, notified, removed };
    }, source);

    expect(result.mountOk).toBe(true);
    expect(result.registered).toBe(true); // item appeared in the data menu
    expect(result.notified).toBe(true); // click relayed to the worker handler
    expect(result.removed).toBe(true); // torn down on unmount
  });

  test("item 1 — a verified sidecar manifest overrides the bundle ceiling, and id mismatch is rejected", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(async () => {
      const host = await (window as any).__calcImport(new URL("/src/api/scriptHost/index.ts", document.baseURI).href);
      const caps = await (window as any).__calcImport(new URL("/src/api/scriptHost/capabilities.ts", document.baseURI).href);
      const commandsMod = await (window as any).__calcImport(new URL("/src/api/commands.ts", document.baseURI).href);
      const { mountWorkerExtension, unmountWorkerExtension, clearAudit, getAuditTail } = host;
      const { recordCapabilityGrant } = caps;
      const { CommandRegistry } = commandsMod;

      // The BUNDLE declares NO capabilities; the AUTHORITATIVE (signed) manifest
      // declares bi.query. The broker must enforce the authoritative ceiling.
      const bundle = `
        export default {
          manifest: { id:"e2e.auth.ext", name:"Auth Ext", version:"1.0.0", workerSupport:true, capabilities:[] },
          activate(ctx){ ctx.commands.register("list", async () => { await ctx.capabilities.listBiConnections(); }); }
        };`;

      clearAudit();
      const mount = await mountWorkerExtension(bundle, "Auth Ext", {
        id: "e2e.auth.ext",
        name: "Auth Ext",
        version: "1.0.0",
        capabilities: ["bi.query"],
        workerSupport: true,
      });
      recordCapabilityGrant("extension:e2e.auth.ext", "bi.query");
      try { await CommandRegistry.execute("ext:e2e.auth.ext:list"); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 150));
      const listEntry = (getAuditTail() as Array<{ scriptId: string; method: string; ok: boolean }>).find(
        (a) => a.scriptId === "extension:e2e.auth.ext" && a.method === "cap.biListConnections",
      );
      await unmountWorkerExtension("e2e.auth.ext");

      // id cross-check: bundle id != signed manifest id -> rejected.
      const mismatchBundle = `
        export default { manifest: { id:"actually.different", name:"X", version:"1.0.0", workerSupport:true }, activate(){} };`;
      const mismatch = await mountWorkerExtension(mismatchBundle, "X", {
        id: "claimed.signed.id",
        name: "X",
        version: "1.0.0",
        capabilities: [],
        workerSupport: true,
      });

      return {
        mountOk: mount.ok === true,
        authoritativeCeilingApplied: listEntry ? listEntry.ok === true : false,
        mismatchRejected: mismatch.ok === false,
      };
    });

    expect(result.mountOk).toBe(true);
    // bi.query was NOT in the bundle but WAS in the signed manifest -> admitted.
    expect(result.authoritativeCeilingApplied).toBe(true);
    expect(result.mismatchRejected).toBe(true);
  });

  test("follow-up — a worker command's return value is surfaced to execute() callers", async ({
    appPage: page,
  }) => {
    const source = `
      export default {
        manifest: { id:"e2e.ret.ext", name:"Ret Ext", version:"1.0.0", workerSupport:true, capabilities:[] },
        activate(ctx){
          ctx.commands.register("echo", (args) => ({ got: args, doubled: (args && args.n ? args.n * 2 : 0) }));
        }
      };`;
    const result = await page.evaluate(async (src: string) => {
      const host = await (window as any).__calcImport(new URL("/src/api/scriptHost/index.ts", document.baseURI).href);
      const commandsMod = await (window as any).__calcImport(new URL("/src/api/commands.ts", document.baseURI).href);
      const { mountWorkerExtension, unmountWorkerExtension } = host;
      const { CommandRegistry } = commandsMod;

      const mount = await mountWorkerExtension(src, "Ret Ext");
      // execute() -> host proxy -> RPC into the worker handler -> result comes back.
      const value = await CommandRegistry.execute("ext:e2e.ret.ext:echo", { n: 21 });
      await unmountWorkerExtension("e2e.ret.ext");
      return { mountOk: mount.ok === true, value };
    }, source);

    expect(result.mountOk).toBe(true);
    expect(result.value).toEqual({ got: { n: 21 }, doubled: 42 });
  });

  test("item 3 — bi.sql (raw SQL) is wired: declared + granted reaches the host executor", async ({
    appPage: page,
  }) => {
    const source = `
      export default {
        manifest: { id:"e2e.bisql.ext", name:"SQL Ext", version:"1.0.0", workerSupport:true, capabilities:["bi.sql"] },
        activate(ctx){
          ctx.commands.register("run", async () => {
            try { await ctx.capabilities.biSql("no-such-conn", "SELECT 1"); return "ok"; }
            catch (e) { return "err:" + (e && e.code); }
          });
        }
      };`;
    const result = await page.evaluate(async (src: string) => {
      const host = await (window as any).__calcImport(new URL("/src/api/scriptHost/index.ts", document.baseURI).href);
      const caps = await (window as any).__calcImport(new URL("/src/api/scriptHost/capabilities.ts", document.baseURI).href);
      const commandsMod = await (window as any).__calcImport(new URL("/src/api/commands.ts", document.baseURI).href);
      const { mountWorkerExtension, unmountWorkerExtension, clearAudit, getAuditTail } = host;
      const { recordCapabilityGrant } = caps;
      const { CommandRegistry } = commandsMod;

      clearAudit();
      const mount = await mountWorkerExtension(src, "SQL Ext");
      recordCapabilityGrant("extension:e2e.bisql.ext", "bi.sql");
      try { await CommandRegistry.execute("ext:e2e.bisql.ext:run"); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 200));
      const entry = (getAuditTail() as Array<{ scriptId: string; method: string; ok: boolean; error?: string }>).find(
        (a) => a.scriptId === "extension:e2e.bisql.ext" && a.method === "cap.biSql",
      );
      await unmountWorkerExtension("e2e.bisql.ext");
      return {
        mountOk: mount.ok === true,
        audited: !!entry,
        // The broker ADMITTED it (declared+granted) and the executor RAN; it then
        // failed at the backend because the connection doesn't exist — i.e. the
        // failure is NOT a broker denial (PermissionDenied / CapabilityRequired).
        notDenied: entry ? entry.error !== "PermissionDenied" && entry.error !== "CapabilityRequired" : false,
      };
    }, source);

    expect(result.mountOk).toBe(true);
    expect(result.audited).toBe(true);
    expect(result.notDenied).toBe(true);
  });
});
