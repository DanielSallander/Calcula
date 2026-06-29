/**
 * C1 — in-app AI chat tool dispatcher (L4 backend), end-to-end.
 *
 * ai_chat_run_tool maps a Claude tool_use call to the same workbook helpers the
 * MCP server exposes, so AI writes from the chat are undoable + gated. This
 * exercises that path directly (no Anthropic API key needed): a write tool
 * applies + is undoable, read tools return data, and unknown tools error.
 *
 * The live chat loop (ai_chat_complete -> Anthropic -> tool loop) and the
 * ChatView UI need a real API key + network and are verified manually.
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

      // has_api_key is callable and returns a boolean (no key needed here).
      const hasKey = await tauri.core.invoke("ai_chat_has_api_key");

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

      // The write went through the undoable pipeline.
      await tauri.core.invoke("undo");
      const cellAfterUndo: any = await tauri.core.invoke("get_cell", { row: 0, col: 0 });
      await tauri.core.invoke("update_cell", { row: 0, col: 0, value: "" });

      return {
        hasKeyType: typeof hasKey,
        writeDisplay: String(cellAfter?.display ?? cellAfter?.value ?? ""),
        summaryLen: typeof summary === "string" ? summary.length : -1,
        rangesType: typeof ranges,
        unknownErr,
        undoDisplay: String(cellAfterUndo?.display ?? cellAfterUndo?.value ?? ""),
      };
    });

    expect(result.hasKeyType).toBe("boolean");
    expect(result.writeDisplay).toContain("99"); // write tool applied
    expect(result.summaryLen).toBeGreaterThan(0); // read tool returned text
    expect(result.rangesType).toBe("string");
    expect(result.unknownErr).toContain("Unknown tool"); // unknown tool errors
    expect(result.undoDisplay).toBe(""); // the AI write is undoable
  });
});
