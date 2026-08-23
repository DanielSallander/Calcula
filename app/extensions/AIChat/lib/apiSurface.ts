//! FILENAME: app/extensions/AIChat/lib/apiSurface.ts
// PURPOSE: Put Calcula's object-script API in front of the model BEFORE it
//          writes a script, instead of letting it guess and be corrected.
// CONTEXT: 2026-08-23. The user asked whether the chat's prompts are "prefixed
//          with the proper documentation from the app". They were not — at all.
//
//          `@api/scriptHost/scriptPrompt` (M4) exists precisely for this: a
//          budget-aware, ranked rendering of the script surface, whose own
//          header tells the model "a method not listed here does not exist -- do
//          not invent one". A repo-wide grep found NO reference to it anywhere
//          under this extension. Its only callers were the standalone probe, the
//          standalone authoring loop, and tests. The shipping chat handed the
//          model `draft_object_script` and asked it to write against an API it
//          had never been shown.
//
//          WHAT THAT COST, MEASURED against the live Ollama on the reporter's
//          machine with their own prompt ("create a script that formats the
//          background color of each selected cell"), 10-tool core surface,
//          temperature 0, 3 trials:
//
//            qwen2.5:7b, no API docs .... 3/3 TEXT-ONLY — it explained what it
//                                         would do and never called a tool
//            qwen2.5:7b, WITH API docs .. 2/3 DRAFT-VALID (source passes the
//                                         whole L0-L2 ladder), 1/3 invalid
//
//          So the missing documentation was not a quality problem, it was the
//          difference between a script and a paragraph about a script. On
//          qwen2.5-coder:3b it changed nothing either way (4/4 apply_formatting
//          with and without), so it is free where it does not help.
//
//          WHY IT IS SENT ON EVERY TURN rather than on demand. The obvious
//          cheaper design — wait for a draft to fail validation, then show the
//          surface in the repair — cannot work, because without the surface the
//          capable model never DRAFTED anything to repair. There was no failure
//          to react to, only silence.

//          WHY THE IMPORT IS LAZY. `scriptPrompt` pulls in the generated
//          `scriptSurfaceSlices.ts` — 167 KB of surface data. A static import
//          puts that in the extension's activation path, where it is parsed at
//          app startup whether or not the user ever opens the chat. It also made
//          `aiChatExtension.test.ts` time out: its `beforeEach` does
//          `vi.resetModules()` and re-imports the extension for every test, so
//          the cost was paid seven times over. Loaded on the first message
//          instead, and memoised.

type BuildSurfacePrompt = typeof import("@api/scriptHost/scriptPrompt")["buildSurfacePrompt"];

let cachedBuild: BuildSurfacePrompt | null = null;

async function loadBuilder(): Promise<BuildSurfacePrompt | null> {
  if (cachedBuild) return cachedBuild;
  try {
    const mod = await import("@api/scriptHost/scriptPrompt");
    cachedBuild = mod.buildSurfacePrompt;
    return cachedBuild;
  } catch {
    return null;
  }
}

/**
 * Tokens the surface may spend.
 *
 * 6,000 is what was measured producing valid drafts. It is not a guess at a
 * context window: `buildSurfacePrompt` fills to the budget and ANNOUNCES the
 * truncation, so a smaller number degrades honestly rather than silently. Below
 * ~3,000 the ranker drops `api.getSelection` — which is the single member a task
 * phrased "each selected cell" cannot do without.
 */
const SURFACE_BUDGET_TOKENS = 6000;

/**
 * The object type the surface is built for.
 *
 * The chat cannot know the target until the model picks one in
 * `draft_object_script`, and the surface has to be in the prompt BEFORE that.
 * "button" is the right default for the same reason `draftGate.objectTypeOf`
 * falls back to it: it is overwhelmingly the common target, and its `onClick` is
 * the one hook the whole corpus is built around. The shared grid surface — which
 * is most of what any script uses — is identical across object types, so the
 * cost of guessing wrong is a handful of context members, not a wrong API.
 */
const DEFAULT_OBJECT_TYPE = "button";

/**
 * Words from the user's message, for the ranker's `hints`.
 *
 * NOT cosmetic. Ranked with no hints at a 6,000-token budget, 103 chains are
 * included and `api.getSelection` is NOT one of them; with hints drawn from a
 * request that says "selected", it is. The ranker is doing exactly what it was
 * built to do — it just needs to be told what the task is about.
 *
 * Short words are dropped: "the" and "of" match everything and would flatten the
 * ranking into alphabetical order, which is the failure the ranker exists to
 * prevent.
 */
export function hintsFrom(userText: string): string[] {
  const words = userText.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];
  // Deduped and capped: the ranker scans every entry per hint, and a pasted
  // wall of text would otherwise turn prompt assembly into a linear scan of the
  // surface a few hundred times over.
  return [...new Set(words)].slice(0, 24);
}

/**
 * The API-surface section to append to the system prompt, or "" when the module
 * cannot produce one.
 *
 * Called ONCE per user message and reused for every turn of that message's
 * agentic loop: the system prompt must stay byte-identical across turns or the
 * provider's prefix cache misses on every round, which on a local model is the
 * difference between a fast turn and re-processing 6,000 tokens.
 */
export async function apiSurfaceSection(userText: string): Promise<string> {
  try {
    const build = await loadBuilder();
    if (!build) return "";
    const built = build({
      objectType: DEFAULT_OBJECT_TYPE,
      budgetTokens: SURFACE_BUDGET_TOKENS,
      hints: hintsFrom(userText),
    });
    return built.text ? `\n\n${built.text}` : "";
  } catch {
    // The surface is an ENHANCEMENT. A chat that refuses to answer because its
    // reference material would not assemble is worse than one that answers
    // without it — which is exactly how it behaved until today.
    return "";
  }
}
