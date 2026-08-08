//! FILENAME: app/extensions/_shared/lib/monacoLineEndings.ts
// PURPOSE: Force every Monaco model in this app to LF, so a buffer that becomes
//          a STORED artifact is byte-identical on every platform.
// CONTEXT: Monaco does not have one line ending — it has a per-model one, and
//          the default is the OPERATING SYSTEM's. `ModelService` in
//          monaco-editor computes a model's `defaultEOL` from the `files.eol`
//          configuration and falls back to
//
//              (isLinux || isMacintosh) ? LF : CRLF
//
//          so on Windows a model gets CRLF. That default only applies when the
//          text the model is created from contains NO line break at all
//          (PieceTreeTextBufferBuilder auto-detects otherwise) — which sounds
//          harmless and is not, because `@monaco-editor/react` creates the model
//          for a `path` the first time it renders, with whatever `value` the
//          component happens to hold at that moment. For an editor that loads
//          its document asynchronously that value is the EMPTY STRING, so the
//          model is born CRLF; the real document then arrives through
//          `executeEdits`, which NORMALISES the inserted text to the model's
//          EOL and never changes it. The buffer is now a CRLF copy of an LF
//          document, and `model.getValue()` — the thing every editor persists —
//          returns text that differs from the stored text on every line by an
//          invisible `\r`.
//
//          WHAT THAT COST, CONCRETELY. It is the `macro-live-edit` test-6
//          failure that has been on HEAD long enough to be quoted as "56 passed
//          / 1 failed" in four separate verification passes: seed a macro, type
//          one character, take it back, and the live persister sees
//          buffer !== stored (they differ only in EOL), writes the CRLF copy
//          through `save_script`, and an untouched macro reports phantom
//          unsaved work. The visible characters are identical throughout, which
//          is why it reads as a mystery rather than as a diff.
//
//          WHY THE EDITOR OWNS THIS AND NOT THE PERSISTER OR `save_script`:
//
//          * `save_script` must not touch the bytes. The storage contract
//            (app/src/api/scriptTranspile.ts) is that EXACTLY ONE ARTIFACT
//            exists and the stored text IS the text the author is looking at —
//            it is what the worker imports, what `scriptSecurity` hashes for the
//            capability-grant binding, and what a reviewer reads in the
//            transparency panel. A store that silently rewrote line endings
//            would make "the code you were shown" and "the code that ran" two
//            different strings, which is the divergence that contract exists to
//            make impossible.
//          * The persister must not normalise for comparison either. That would
//            fix the phantom-dirty symptom while still STORING CRLF the first
//            time somebody makes a real edit — a platform-dependent artifact in
//            a `.calp`, and a source hash that differs between a Windows-authored
//            and a Linux-authored identical script.
//          * Monaco is where the platform dependency ENTERS. Fixing it here
//            leaves exactly one normal form for stored text and no second
//            normaliser to keep in step.

/**
 * The line ending every stored text artifact uses.
 *
 * Scripts, chart specs, model expressions and design queries are all persisted
 * verbatim from a Monaco buffer; LF is the only ending that makes those bytes a
 * function of the content rather than of the author's operating system.
 */
export const STORED_TEXT_EOL = "\n";

/**
 * The minimum of the Monaco namespace this module needs.
 *
 * Typed structurally rather than as `typeof import("monaco-editor")` so the
 * module stays importable from a unit test with a hand-built double, and so it
 * never drags the 5 MB editor bundle into a test graph.
 */
export interface MonacoEolNamespace {
  editor: {
    EndOfLineSequence: { LF: number };
    getModels(): Array<{ setEOL(eol: number): void }>;
    onDidCreateModel(listener: (model: { setEOL(eol: number): void }) => void): {
      dispose(): void;
    };
  };
}

/**
 * Realms that have already had the hook installed.
 *
 * Keyed by the namespace object, not a module-level boolean: the stand-alone
 * editor windows are separate JavaScript realms with their own `monaco`
 * instance, and each needs its own subscription. A WeakSet also means a torn
 * down realm's entry does not keep it alive.
 */
const hooked = new WeakSet<object>();

/**
 * Make LF the line ending of every model in this Monaco realm — the ones that
 * already exist and every one created afterwards.
 *
 * Idempotent, and safe to call at module scope next to `loader.config({ monaco })`
 * so the guarantee is in place before any editor can mount. `setEOL` on a
 * freshly created model is a no-op when the ending already matches and costs a
 * single buffer rewrite when it does not; on an existing model it is an
 * ordinary undoable edit, which is the correct behaviour for the rare case of a
 * document that genuinely arrived as CRLF (a pasted file, an imported script) —
 * it becomes LF, and that IS the intent.
 */
export function enforceLfLineEndings(monaco: MonacoEolNamespace): void {
  if (hooked.has(monaco)) return;
  hooked.add(monaco);
  const LF = monaco.editor.EndOfLineSequence.LF;
  monaco.editor.onDidCreateModel((model) => {
    model.setEOL(LF);
  });
  // Anything created before this call (module evaluation order across the
  // editors is not guaranteed) is brought into line too.
  for (const model of monaco.editor.getModels()) {
    model.setEOL(LF);
  }
}

/**
 * Normalise text to the stored-artifact ending.
 *
 * NOT part of the save path — {@link enforceLfLineEndings} is what makes the
 * save path correct. This is for the boundaries Monaco does not own: text that
 * arrives from a file read, an XLSX/VBA import, or a paste that bypasses the
 * editor entirely, and that will be handed to a store rather than to a model.
 */
export function toStoredTextEol(text: string): string {
  return text.replace(/\r\n?/g, STORED_TEXT_EOL);
}
