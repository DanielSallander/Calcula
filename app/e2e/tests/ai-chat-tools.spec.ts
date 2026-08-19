/**
 * C1 — in-app AI chat tool dispatcher (L4 backend), end-to-end.
 *
 * ai_chat_run_tool maps a Claude tool_use call to the same workbook helpers the
 * MCP server exposes, so AI writes from the chat are undoable + gated. This
 * exercises that path directly (no Anthropic API key needed): a write tool
 * applies + is undoable, read tools return data, and unknown tools error.
 *
 * The live chat loop (ai_chat_complete_stream -> provider -> tool loop) and the
 * ChatView UI need a real model + network and are verified manually.
 *
 * KEPT CURRENT THE HARD WAY. This spec called `ai_chat_has_api_key` until
 * 2026-08-19, when M3 replaced the single fixed credential slot with one per
 * provider and renamed it `ai_provider_has_key`. The command stopped existing,
 * the `page.evaluate` rejected, and the whole test failed — but the unit tier is
 * green and nobody ran E2E for a whole day of work, so nothing said so. That is
 * the gap this file exists to cover: a renamed Tauri command is invisible to
 * TypeScript, because `invoke` takes a STRING.
 */
import { test, expect } from "../fixtures";

test.describe("AI chat tool dispatcher (C1, L4)", () => {
  test("ai_chat_run_tool dispatches to workbook tools — write is undoable, reads return data", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_script_security_level", { level: "enabled" });
      await tauri.core.invoke("update_cell", { row: 0, col: 0, value: "" });

      // Key presence is per PROVIDER since M3; callable without a key stored.
      const hasKey = await tauri.core.invoke("ai_provider_has_key", { providerId: "anthropic" });
      // The provider registry is reachable and non-empty, so the model picker
      // has something to render.
      const providers: any = await tauri.core.invoke("ai_providers_list");

      // Write tool through the dispatcher.
      await tauri.core.invoke("ai_chat_run_tool", {
        name: "set_cell_value",
        input: { row: 0, col: 0, value: "99" },
      });
      const cellAfter: any = await tauri.core.invoke("get_cell", { row: 0, col: 0 });

      // Read tools through the dispatcher.
      const summary = await tauri.core.invoke("ai_chat_run_tool", { name: "get_sheet_summary", input: {} });
      const ranges = await tauri.core.invoke("ai_chat_run_tool", { name: "list_named_ranges", input: {} });

      // Unknown tool errors.
      let unknownErr = "";
      try {
        await tauri.core.invoke("ai_chat_run_tool", { name: "nope", input: {} });
      } catch (e) {
        unknownErr = String(e);
      }

      // M1: the chat can DRAFT a script for review. Reachable over IPC and inert
      // — it must not mount, must not execute, and must report its declared
      // capability ceiling to the reviewer.
      const draft = await tauri.core.invoke("ai_chat_run_tool", {
        name: "draft_object_script",
        input: {
          name: "E2E Draft",
          object_type: "button",
          source: "// @capability storage\nexport function setup(context) { context.log('x'); }\n",
        },
      });
      const drafts = await tauri.core.invoke("ai_chat_run_tool", {
        name: "list_script_drafts",
        input: {},
      });

      // The write went through the undoable pipeline.
      await tauri.core.invoke("undo");
      const cellAfterUndo: any = await tauri.core.invoke("get_cell", { row: 0, col: 0 });
      await tauri.core.invoke("update_cell", { row: 0, col: 0, value: "" });

      return {
        hasKeyType: typeof hasKey,
        providerCount: Array.isArray(providers) ? providers.length : -1,
        providerIds: Array.isArray(providers) ? providers.map((p: any) => p.id) : [],
        writeDisplay: String(cellAfter?.display ?? cellAfter?.value ?? ""),
        summaryLen: typeof summary === "string" ? summary.length : -1,
        rangesType: typeof ranges,
        unknownErr,
        draft: String(draft ?? ""),
        drafts: String(drafts ?? ""),
        undoDisplay: String(cellAfterUndo?.display ?? cellAfterUndo?.value ?? ""),
      };
    });

    expect(result.hasKeyType).toBe("boolean");
    expect(result.writeDisplay).toContain("99"); // write tool applied
    expect(result.summaryLen).toBeGreaterThan(0); // read tool returned text
    expect(result.rangesType).toBe("string");
    expect(result.unknownErr).toContain("Unknown tool"); // unknown tool errors
    expect(result.undoDisplay).toBe(""); // the AI write is undoable

    // M3: the picker has providers to offer, local ones among them.
    expect(result.providerCount).toBeGreaterThan(4);
    expect(result.providerIds).toContain("ollama");
    expect(result.providerIds).toContain("anthropic");

    // M1: the draft is queued for review and says so. "NOT mounted / not
    // running" is the invariant the whole review flow rests on, so it is
    // asserted on the wire rather than trusted.
    expect(result.draft).toContain("NOT mounted");
    expect(result.draft).toContain("storage"); // declared ceiling surfaced
    expect(result.drafts).toContain("E2E Draft");
    expect(result.drafts).toContain("mounted=false");
  });
});
