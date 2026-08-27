//! FILENAME: app/src/api/scriptHost/scriptPreview/unexercisedHooks.ts
// PURPOSE: The ONE wording for "the script registered this handler and the
//          preview never fired it", plus the transcript line that says it per
//          hook.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.1.
//
//          WHY IT IS ITS OWN LEAF. Every surface that renders a dry-run
//          caveat reaches this sentence — some through `dryRunCaveat` beside
//          it, the rest by calling `unexercisedHookNote` directly; the census
//          is `rg unexercisedHookNote app`, not this comment. (One caller,
//          `report.summarize`, has no production caller of its own and is
//          filed for deletion.) A sentence spelled separately at each surface
//          is that many different sentences the day one of them is edited,
//          and this particular sentence exists to stop a MISREADING: "it changed
//          no cells" is a fact about the preview when the handler holding the
//          work was never fired, and both a model and a reviewer read the bare
//          sentence as a finding about the script.
//
//          THE RUST TWIN. `app/src-tauri/src/ai/dryrun.rs` says the same words
//          for the interpreter realm, where the list is always empty; the two
//          are pinned fragment by fragment by
//          `app/src/api/__tests__/dryRunReportDrift.test.ts`.
//
//          IT TOLERATES `undefined`. The field is REQUIRED on `DryRunReport`,
//          but test doubles and third-party assistant providers hand-build that
//          shape, and test files are excluded from `tsconfig.check.json` — so a
//          missing array has to produce "no caveat" rather than a TypeError
//          inside a render.
//
//          HOW OFTEN IT FIRES, measured rather than assumed.
//          `SYNTHESIZABLE_HOOK_PAYLOADS` (runShape.ts) holds `onClick` and
//          `onDoubleClick` and nothing else, and ButtonContext declares only
//          `onClick` — so the list is ALWAYS empty for the commonest draft
//          target, and non-empty for essentially every other context's handlers.
//
//          NO IMPORTS, deliberately: the chat extension, the editor window and
//          the preview rung all reach it, and a leaf with no dependencies is one
//          nobody has to lazy-load.

/**
 * "a", "a and b", "a, b and c" — a SENTENCE, never a JSON array.
 *
 * `["onSelectionChange","onCellChange"]` rendered into user-facing prose is how
 * a note stops reading like a note.
 */
function englishList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The caveat for a run whose script registered handlers the preview could not
 * fire, or "" when there were none.
 *
 * Written to stand as its OWN sentence after whatever the caller already said,
 * so every surface can append it without re-deciding the wording.
 */
export function unexercisedHookNote(hooks: readonly string[] | undefined): string {
  if (!hooks || hooks.length === 0) return "";
  const names = englishList(hooks);
  return hooks.length === 1
    ? `The script registered ${names}, but the preview ` +
        `never fired it, so nothing that handler does was measured.`
    : `The script registered ${names}, but the preview ` +
        `never fired any of them, so nothing those handlers do was measured.`;
}

/**
 * The `output` line the preview writes for one handler it did not fire.
 *
 * TWO REASONS, and they are not interchangeable. A hook the run OFFERED and
 * skipped genuinely has an unsynthesizable payload. A hook that was never
 * offered — anything registered under a sub-object, like a shape's
 * `render.onMessage` or a chart mark's `render.markRenderer` — has no payload
 * problem at all; the preview simply has no channel to dispatch it. Saying the
 * first about the second sends an author looking for a payload bug that does
 * not exist.
 *
 * The `offered` arm is byte-identical to the line the preview emitted inline
 * before this leaf existed, because `app/e2e/journeys/script-preview.spec.ts`
 * matches a SUBSTRING of it — the only tier with a real Worker realm. Neither
 * the `[preview] ` prefix nor the tail after the em dash is covered there, so
 * this wording is pinned by the unit tests, not by that spec.
 */
export function previewSkipLine(hook: string, offered = true): string {
  return offered
    ? `[preview] the ${hook} handler was registered but not exercised — the preview cannot ` +
        `synthesize the payload it receives`
    : `[preview] the ${hook} handler was registered but not exercised — the preview has no ` +
        `way to fire it`;
}
