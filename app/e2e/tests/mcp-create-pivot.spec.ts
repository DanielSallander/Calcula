/**
 * C1 — MCP create_pivot write tool + pivot field-detail, end-to-end through the
 * live bearer-token MCP server.
 *
 * create_pivot routes through create_pivot_inner (the same create path the UI
 * uses) with row + value fields configured UP FRONT, so it is a SINGLE undoable
 * step; it ANNOUNCES the mutation so the Pivot extension refreshes live.
 * list_pivots then shows the field detail (rows=[..] values=[..]), exercising
 * the field-detail enrichment too.
 *
 * Asserts: (1) create succeeds, (2) list_pivots shows the pivot WITH its
 * rows/values fields, (3) the announcement reached the UI, (4) a single undo
 * removes it.
 *
 * (3) USED TO NAME THE TAURI EVENT `"pivots:refresh"`, which §3cd (BUG-0026)
 * deleted along with the other four bespoke per-kind announcements, replacing
 * them with one `mutation:refresh` that the Shell fans out through
 * `MUTATION_DOMAIN_EVENTS`. The product is fine; the test was naming a dead
 * transport, and the first live functional run after that change is what said
 * so. It now asserts the backend's announcement AND the feature event the Pivot
 * extension actually listens to — see mcp-create-table.spec.ts for why both.
 */
import { test, expect } from "../fixtures";

function parseMcp(contentType: string, body: string): any {
  if (contentType.includes("text/event-stream")) {
    const dataLines = body
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const last = dataLines[dataLines.length - 1];
    return last ? JSON.parse(last) : null;
  }
  return body ? JSON.parse(body) : null;
}

test.describe("MCP create_pivot write tool + field-detail (C1)", () => {
  test("an AI-created pivot persists, lists with its fields, fires a refresh, and is undoable", async ({
    appPage: page,
  }) => {
    const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const pivotName = `E2ePivot${uniq}`;

    const setup = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_script_security_level", { level: "enabled" });
      // Seed a small Region/Revenue table (A1:B4) as the pivot source.
      const seed: Array<[number, number, string]> = [
        [0, 0, "Region"], [0, 1, "Revenue"],
        [1, 0, "North"], [1, 1, "100"],
        [2, 0, "South"], [2, 1, "200"],
        [3, 0, "North"], [3, 1, "50"],
      ];
      for (const [row, col, value] of seed) {
        await tauri.core.invoke("update_cell", { row, col, value });
      }
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      (window as any).__PIVOT_ANNOUNCED_DOMAINS__ = null;
      (window as any).__PIVOT_UI_HEARD__ = false;
      await api.listenTauriEvent("mutation:refresh", (payload: any) => {
        const domains: string[] = payload?.domains ?? [];
        const seen: string[] = (window as any).__PIVOT_ANNOUNCED_DOMAINS__ ?? [];
        (window as any).__PIVOT_ANNOUNCED_DOMAINS__ = [...seen, ...domains];
      });
      window.addEventListener("pivot:refresh", () => {
        (window as any).__PIVOT_UI_HEARD__ = true;
      });
      await tauri.core.invoke("mcp_start", {});
      const status: any = await tauri.core.invoke("mcp_status", {});
      return { port: status.port as number, token: status.token as string | null };
    });
    expect(setup.token).toBeTruthy();

    const url = `http://127.0.0.1:${setup.port}/mcp`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${setup.token}`,
    };
    const rpc = async (id: number | null, method: string, params?: unknown) => {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
      });
      const text = await res.text();
      return { ok: res.ok, json: parseMcp(res.headers.get("content-type") ?? "", text), text };
    };

    try {
      const init = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "calcula-e2e", version: "1.0" } },
        }),
      });
      const sessionId = init.headers.get("mcp-session-id");
      await init.text();
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      expect(init.ok).toBe(true);
      await rpc(null, "notifications/initialized");

      // 1. create_pivot: group by Region, sum Revenue (snake_case args).
      const create = await rpc(2, "tools/call", {
        name: "create_pivot",
        arguments: {
          source_range: "A1:B4",
          destination_cell: "F1",
          value_fields: [{ field: "Revenue", aggregation: "sum" }],
          row_fields: ["Region"],
          has_headers: true,
          name: pivotName,
        },
      });
      expect(create.ok, `create failed: ${create.text.slice(0, 300)}`).toBe(true);
      expect(create.json?.error ?? null).toBeNull();
      expect(create.json?.result?.isError ?? false, "create_pivot reported a tool error").toBe(false);

      // 2. list_pivots shows the pivot AND its field detail (field-detail slice).
      const list = await rpc(3, "tools/call", { name: "list_pivots", arguments: {} });
      const listText: string = list.json?.result?.content?.[0]?.text ?? "";
      expect(listText).toContain(pivotName);
      expect(listText).toContain("rows=[Region]");
      expect(listText).toContain("values=[Sum of Revenue]");

      // 3. The mutation was announced, and the announcement reached the UI.
      const announced = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 300));
        return {
          domains: (window as any).__PIVOT_ANNOUNCED_DOMAINS__ as string[] | null,
          uiHeard: (window as any).__PIVOT_UI_HEARD__ === true,
        };
      });
      expect(
        announced.domains,
        "create_pivot must announce the mutation (object_deps::announce_cascade " +
          "-> the mutation:refresh Tauri event). Nothing arrived at all.",
      ).not.toBeNull();
      expect(
        announced.domains,
        "the announcement must name the `pivot` domain — that is what " +
          "ObjectKind::Pivot maps to in object_deps::ui_domain",
      ).toContain("pivot");
      expect(
        announced.uiHeard,
        "the Shell must fan `pivot` out to the pivot:refresh window event — " +
          "without it an AI-created pivot is invisible until something else " +
          "redraws",
      ).toBe(true);

      // 4. Undoable: a single undo removes the AI-created pivot (one create =
      //    one undo entry; the clean-cache snapshot deserializes so the
      //    delete-on-undo runs).
      const namesAfterUndo = await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("undo");
        const pivots: any[] = await tauri.core.invoke("get_all_pivot_tables");
        return pivots.map((p) => p.name);
      });
      expect(namesAfterUndo).not.toContain(pivotName);
    } finally {
      // THE PIVOT IS REMOVED HERE, NOT ONLY BY STEP 4'S UNDO — a cleanup that
      // runs only when the assertions passed is not a cleanup. See the note in
      // mcp-create-table.spec.ts: the same shape there left an AI-created table
      // in the shared workbook and turned three root failures into nine.
      // Removed BY NAME so this cannot delete a pivot another spec owns.
      await page.evaluate(async (name: string) => {
        const tauri = (window as any).__TAURI__;
        try {
          await tauri.core.invoke("mcp_stop", {});
        } catch {
          /* already stopped */
        }
        try {
          const pivots: any[] = await tauri.core.invoke("get_all_pivot_tables");
          for (const p of pivots ?? []) {
            if (p?.name === name) {
              await tauri.core.invoke("delete_pivot_table", { pivotId: p.pivotId ?? p.id });
            }
          }
        } catch {
          /* nothing to remove */
        }
        // Clear seeded cells + any pivot output.
        for (let row = 0; row <= 3; row++) {
          for (let col = 0; col <= 1; col++) {
            await tauri.core.invoke("update_cell", { row, col, value: "" });
          }
        }
      }, pivotName);
    }
  });
});
