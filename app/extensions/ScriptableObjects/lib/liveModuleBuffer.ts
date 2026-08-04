//! FILENAME: app/extensions/ScriptableObjects/lib/liveModuleBuffer.ts
// PURPOSE: Make an edited module script LIVE — the VBE model, where there is no
//          per-module save step: the module IS the code, and the buffer reaches
//          the store on its own.
// CONTEXT: In the VBE a module has no Save button. You type, the module is
//          changed, F5 runs what you are looking at, and Ctrl+S saves the
//          WORKBOOK. Calcula already maps onto that: writing to the module store
//          (`save_script` via @api/workbookScripts.saveWorkbookScript) is "live
//          in memory", and the .cala save is the separate step that persists to
//          disk — which is why saveWorkbookScript calls markFileModified().
//
//          This module is the machinery that closes the gap: an idle debounce
//          that writes the buffer through, plus a synchronous flush every
//          explicit gesture (Run, Debug, Ctrl+S, switching documents, closing
//          the window) goes through, so what runs is always what is on screen.
//
//          IT IS DELIBERATELY NOT A REACT HOOK. The rules below — coalescing,
//          "never write unchanged text", "un-compilable text must not destroy
//          the last good version" — are the whole substance of the feature and
//          have to be testable without mounting an editor.
//
// ---------------------------------------------------------------------------
// THE FOUR RULES
// ---------------------------------------------------------------------------
//
// 1. NEVER TWO WRITES AT ONCE. A second write is never *queued* while one is in
//    flight; the caller waits for the one that is running and then re-evaluates
//    against the buffer as it is by then. Typing during a slow write therefore
//    costs one extra write at the end, not one per keystroke.
//
// 2. NEVER WRITE UNCHANGED TEXT. Every pass compares the buffer with the bytes
//    this doc last stored. Re-writing identical bytes would be pure churn — and
//    on a script that carries a persisted capability grant, an identical-bytes
//    write is exactly what the source-hash binding is built to ignore, so a
//    redundant write is at best noise and at worst a re-hash for nothing.
//
// 3. UN-COMPILABLE TEXT IS NOT STORED, AND DESTROYS NOTHING. Mid-typing, source
//    is transiently invalid. The gate (see authoringLanguage.gateObjectScriptSave)
//    compiles first and refuses to store text that does not parse, so the LAST
//    GOOD stored version survives untouched; the buffer simply stays unsaved and
//    the caller shows the compiler error. Note what does NOT block a write:
//    `ts.transpileModule` is a syntactic transform with no type checker, so type
//    errors never make a script unsaveable — only genuinely unparseable source
//    does. That is what makes an idle auto-persist safe at all.
//
// 4. THE DEBOUNCE NEVER REWRITES THE AUTHOR'S TEXT. A TypeScript buffer compiles
//    to different bytes than the ones on screen, and the storage contract is that
//    the STORED text is the text the author sees (scriptTranspile.ts: exactly one
//    artifact). Silently swapping the buffer under a moving cursor is not an
//    option, and storing bytes the author is not looking at breaks the contract —
//    so an idle pass that would have to transform DEFERS instead, and the next
//    explicit gesture (which may rewrite the buffer, because the author asked for
//    something) does the compile. Plain JavaScript — every recorded macro — is
//    passed through byte for byte and is therefore always live.

import type { ObjectScriptSaveGate } from "./authoringLanguage";

/**
 * The idle window before a buffer is written through.
 *
 * 400 ms, chosen for three reasons and not as a round number:
 *
 *   - It is longer than the gap between keystrokes in continuous typing
 *     (~150-250 ms), so a sentence of code coalesces into ONE write rather than
 *     one per character.
 *   - It is shorter than the time it takes to move a hand from the keyboard to
 *     the Run button or to the main window, so by the time any gesture can
 *     happen the buffer is already live. (Every gesture flushes anyway — this
 *     only decides whether the flush has anything left to do.)
 *   - It matches the debounce this codebase already uses for the other
 *     type-while-it-persists surface, the breakpoint store (debugger.ts), so the
 *     app has one settle interval rather than two.
 *
 * It is also the interval that keeps the capability model honest: a persisted
 * grant lapses when a script's source hash changes, and it must lapse on a
 * SETTLED edit — never once per keystroke. Nothing here re-mounts a script (a
 * store write is not a mount), and the mounts that DO re-hash only happen on an
 * explicit Run/Debug, i.e. after this window has closed.
 */
export const LIVE_PERSIST_DEBOUNCE_MS = 400;

/** What one persist pass did. Every state is nameable in the UI. */
export type LivePersistOutcome =
  /** Buffer and store already agreed; nothing was written. */
  | { status: "unchanged" }
  /** Written, and the stored bytes ARE the buffer bytes. */
  | { status: "saved"; stored: string }
  /** Written after a TypeScript -> JavaScript compile: the stored bytes are NOT
   *  the buffer bytes, so the caller must show the author what was stored. */
  | { status: "compiled"; stored: string }
  /** A compile would have been needed and this pass is not allowed to rewrite
   *  the author's text (rule 4). Nothing was written; the buffer stays unsaved. */
  | { status: "deferred"; message: string }
  /** The source does not compile. Nothing was written; the last good stored
   *  version is intact. `detail` is the positioned compiler output. */
  | { status: "invalid"; detail: string; message: string }
  /** The store itself refused the write (backend error). Nothing was stored. */
  | { status: "failed"; message: string };

/** The outcomes that actually wrote — and therefore carry the stored bytes. */
export type LivePersistWrite = Extract<LivePersistOutcome, { status: "saved" | "compiled" }>;

/** True when this outcome means the store now holds different bytes than before. */
export function outcomeWroteNewBytes(outcome: LivePersistOutcome): outcome is LivePersistWrite {
  return outcome.status === "saved" || outcome.status === "compiled";
}

/** True when the document is still carrying unsaved work after this outcome. */
export function outcomeLeavesBufferUnsaved(outcome: LivePersistOutcome): boolean {
  return (
    outcome.status === "deferred" ||
    outcome.status === "invalid" ||
    outcome.status === "failed"
  );
}

export interface LiveModulePersisterOptions {
  /** Compile + sandbox-parse gate. The single authority on "may this be stored". */
  gate: (source: string, name: string) => Promise<ObjectScriptSaveGate>;
  /** Write the gated JavaScript to the module store. */
  write: (docId: string, javascript: string) => Promise<void>;
  /** Called after EVERY completed pass, including the ones a flush drove. */
  onOutcome?: (docId: string, outcome: LivePersistOutcome) => void;
  /** Override the idle window (tests). */
  debounceMs?: number;
}

interface DocEntry {
  name: string;
  /** The bytes the store holds, as far as this persister knows. */
  stored: string;
  /** The bytes on screen. */
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<LivePersistOutcome> | null;
}

/** How many times one flush will chase a buffer that keeps moving under it. */
const MAX_FLUSH_PASSES = 3;

/**
 * The live-persist engine for module documents.
 *
 * One instance per editor window; documents are keyed by their module id, so a
 * flush of the document being left cannot be confused with a write of the one
 * being opened.
 */
export class LiveModulePersister {
  private readonly docs = new Map<string, DocEntry>();
  private readonly debounceMs: number;

  constructor(private readonly options: LiveModulePersisterOptions) {
    this.debounceMs = options.debounceMs ?? LIVE_PERSIST_DEBOUNCE_MS;
  }

  /**
   * Register (or re-baseline) a document with the bytes the store holds.
   *
   * Called whenever a listing lands, so an edit made in another window becomes
   * this persister's new "last stored" and cannot provoke a pointless write-back.
   * It never touches a buffer: only `note` moves that.
   */
  track(docId: string, name: string, stored: string): void {
    const existing = this.docs.get(docId);
    if (existing) {
      existing.name = name;
      // NOT while a write is in flight: that write's own completion is the
      // authority on what the store holds, and a listing that was requested
      // before it started would otherwise roll the baseline backwards and
      // provoke a redundant re-write of bytes already stored.
      if (!existing.inFlight) existing.stored = stored;
      return;
    }
    this.docs.set(docId, {
      name,
      stored,
      buffer: stored,
      timer: null,
      inFlight: null,
    });
  }

  /** Whether this persister is following a document. */
  tracks(docId: string): boolean {
    return this.docs.has(docId);
  }

  /** The bytes this persister believes are stored, or null for an unknown doc. */
  storedSource(docId: string): string | null {
    return this.docs.get(docId)?.stored ?? null;
  }

  /** True when the buffer differs from the stored bytes (a real unsaved state). */
  hasUnsavedEdits(docId: string): boolean {
    const entry = this.docs.get(docId);
    return !!entry && entry.buffer !== entry.stored;
  }

  /**
   * The buffer changed. Starts (or restarts) the idle window.
   *
   * Text identical to what is stored still cancels a pending write — undoing
   * back to the stored version must not leave a redundant write armed.
   */
  note(docId: string, name: string, source: string): void {
    const entry = this.docs.get(docId);
    if (!entry) return;
    entry.name = name;
    entry.buffer = source;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (source === entry.stored) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      // The idle pass may not rewrite the author's text (rule 4).
      void this.run(docId, false);
    }, this.debounceMs);
  }

  /**
   * Persist NOW and report what happened.
   *
   * `allowTransform` is the caller saying "this is an explicit gesture, you may
   * store compiled bytes that differ from the buffer" — Run, Debug, Ctrl+S,
   * switching document, closing the window. The idle path never sets it.
   */
  async flush(docId: string, allowTransform = true): Promise<LivePersistOutcome> {
    const entry = this.docs.get(docId);
    if (!entry) return { status: "unchanged" };
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    let outcome: LivePersistOutcome = { status: "unchanged" };
    for (let pass = 0; pass < MAX_FLUSH_PASSES; pass += 1) {
      outcome = await this.run(docId, allowTransform);
      // A pass that stored the text it was given may still be behind a buffer
      // the author moved WHILE it was in flight — chase it, bounded, so a flush
      // before Run really does leave the store holding the visible text.
      if (!outcomeWroteNewBytes(outcome)) break;
      const current = this.docs.get(docId);
      if (!current || current.buffer === current.stored) break;
    }
    return outcome;
  }

  /** Flush every tracked document (window close). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.docs.keys()].map((docId) => this.flush(docId, true)));
  }

  /** Drop a pending write without performing it (the document is gone). */
  forget(docId: string): void {
    const entry = this.docs.get(docId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.docs.delete(docId);
  }

  /**
   * Forget every document except these — the listing is authoritative about
   * which modules still exist, and a timer armed for a module that has been
   * deleted must not re-create it.
   */
  retain(docIds: Iterable<string>): void {
    const keep = new Set(docIds);
    for (const docId of [...this.docs.keys()]) {
      if (!keep.has(docId)) this.forget(docId);
    }
  }

  /** Cancel every armed timer. Does not cancel a write already in flight. */
  dispose(): void {
    for (const entry of this.docs.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.docs.clear();
  }

  /**
   * One pass. Coalesces against any write already running (rule 1), refuses to
   * write unchanged bytes (rule 2), and treats the gate as the sole authority on
   * whether anything may be stored at all (rules 3 and 4).
   */
  private async run(docId: string, allowTransform: boolean): Promise<LivePersistOutcome> {
    const entry = this.docs.get(docId);
    if (!entry) return { status: "unchanged" };

    if (entry.inFlight) {
      // COALESCE. Wait for the write that is running rather than starting a
      // second one, then decide again against the buffer as it is by then — by
      // which point `inFlight` is cleared, so this cannot recurse further.
      await entry.inFlight.catch(() => undefined);
      if (!this.docs.has(docId)) return { status: "unchanged" };
      return this.run(docId, allowTransform);
    }

    if (entry.buffer === entry.stored) return { status: "unchanged" };

    const source = entry.buffer;
    const name = entry.name;
    const pass = (async (): Promise<LivePersistOutcome> => {
      let gate: ObjectScriptSaveGate;
      try {
        gate = await this.options.gate(source, name);
      } catch (e) {
        return {
          status: "failed",
          message: `The script could not be compiled: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (!gate.ok) {
        // RULE 3. The last good stored version is left exactly as it was.
        return { status: "invalid", detail: gate.detail, message: gate.message };
      }
      if (gate.transformed && !allowTransform) {
        // RULE 4. Storing here would mean the store holds bytes the author is
        // not looking at, and rewriting the buffer would move their cursor.
        return {
          status: "deferred",
          message:
            "TypeScript is compiled to JavaScript when it is stored, and the stored script " +
            "is always the JavaScript. Press Ctrl+S (or Run) to compile and store it.",
        };
      }
      try {
        await this.options.write(docId, gate.javascript);
      } catch (e) {
        return {
          status: "failed",
          message: e instanceof Error ? e.message : String(e),
        };
      }
      const live = this.docs.get(docId);
      if (live) live.stored = gate.javascript;
      return gate.transformed
        ? { status: "compiled", stored: gate.javascript }
        : { status: "saved", stored: gate.javascript };
    })();

    entry.inFlight = pass;
    let outcome: LivePersistOutcome;
    try {
      outcome = await pass;
    } finally {
      if (entry.inFlight === pass) entry.inFlight = null;
    }
    this.options.onOutcome?.(docId, outcome);
    return outcome;
  }
}
