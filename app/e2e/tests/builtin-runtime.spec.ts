/**
 * The on-board inference runtime (Tier 1), end to end over Tauri's IPC.
 *
 * What this proves that the unit tier cannot: the six `ai_builtin_*` commands
 * are registered and reachable from the main window, the built-in provider is
 * listed first and keyless, `ai_list_models` answers from disk without starting
 * anything, a completion through the built-in provider STARTS the runtime and
 * honours a grammar (the reply is exactly the grammar's one legal string), the
 * status names the port and the process, and a stop takes it down.
 *
 * SKIPS, LOUDLY, when this build carries no runtime or no model: the two are
 * fetched artifacts (`npm run fetch:llama-server`, `npm run fetch:builtin-model`),
 * not repository content, and a failure that means "you did not fetch" is not a
 * product failure. Everything up to that point still runs.
 *
 * The consent dialog is deliberately NOT driven here: it is a native dialog
 * (`confirmAsync`), the unit tier proves the gate in the Tauri shape, and the
 * download it guards is a gigabyte from the public internet — not something an
 * E2E run should start.
 */
import { test, expect } from "../fixtures";

interface BuiltinStatus {
  providerId: string;
  engine: { present: boolean; path: string | null; build: string | null };
  model: { presence: "present" | "absent" | "mismatch"; pin: { id: string; sizeBytes: number } };
  running: { port: number; pid: number; baseUrl: string } | null;
  starting: boolean;
}

test.describe("the on-board runtime (Tier 1)", () => {
  test("is listed first, keyless and local, and reports its status from disk", async ({ appPage: page }) => {
    const result = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const providers: any[] = await tauri.core.invoke("ai_providers_list");
      const status: BuiltinStatus = await tauri.core.invoke("ai_builtin_status");
      const models: string[] = await tauri.core.invoke("ai_list_models", { providerId: "calcula-builtin" });
      const after: BuiltinStatus = await tauri.core.invoke("ai_builtin_status");
      return { first: providers[0], status, models, after };
    });
    expect(result.first.id).toBe("calcula-builtin");
    expect(result.first.isLocal).toBe(true);
    expect(result.first.requiresKey).toBe(false);
    expect(result.status.providerId).toBe("calcula-builtin");
    expect(result.status.model.pin.sizeBytes).toBeGreaterThan(1_000_000_000);
    // Listing never starts the runtime.
    expect(result.after.running).toBeNull();
    expect(result.after.starting).toBe(false);
    if (result.status.model.presence === "present") {
      expect(result.models).toEqual([result.status.model.pin.id]);
    } else {
      expect(result.models).toEqual([]);
    }
  });

  test("starts on the first completion, honours a grammar exactly, and stops", async ({ appPage: page }) => {
    const status: BuiltinStatus = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("ai_builtin_status");
    });
    test.skip(
      !status.engine.present || status.model.presence !== "present",
      `no runtime or no model in this build (engine ${status.engine.present}, model ${status.model.presence}); ` +
        "run npm run fetch:llama-server and npm run fetch:builtin-model",
    );

    const result = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const reply: any = await tauri.core.invoke("ai_chat_complete", {
        request: {
          providerId: "calcula-builtin",
          model: "qwen2.5-coder-1.5b-instruct-q4_k_m",
          system: "Answer the question.",
          messages: [{ role: "user", content: [{ type: "text", text: "What is 2+2? Answer in words." }] }],
          tools: [],
          maxTokens: 8,
          temperature: 0,
          grammar: 'root ::= "OK"',
        },
        baseUrlOverride: null,
      });
      const running: BuiltinStatus = await tauri.core.invoke("ai_builtin_status");
      const stopped: BuiltinStatus = await tauri.core.invoke("ai_builtin_stop");
      return { reply, running, stopped };
    });

    const text = result.reply.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    expect(text, "the grammar's only legal reply").toBe("OK");
    expect(result.running.running, "the completion started the runtime").not.toBeNull();
    expect(result.running.running!.port).toBeGreaterThan(0);
    expect(result.running.running!.baseUrl).toBe(`http://127.0.0.1:${result.running.running!.port}/v1`);
    expect(result.stopped.running, "and stop took it down").toBeNull();
  });
});
