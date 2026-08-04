//! FILENAME: app/extensions/ScriptableObjects/lib/liveEditPolicy.ts
// PURPOSE: Say, per document KIND, what "live editing" is allowed to do to it —
//          as data the editor branches on, not as a comment somebody has to
//          remember while adding the next document kind.
// CONTEXT: The Object Script Editor holds three very different things behind one
//          text buffer, and "an edit is immediately live" is only true of one of
//          them. Making that a table is the point: a new kind cannot be added
//          without answering both questions.

/** The three things this editor can have open. */
export type EditorDocumentKind =
  /** A workbook MODULE script — a recorded macro or a hand-authored module. */
  | "module"
  /** A registered object script, mounted in a realm right now. */
  | "objectScript"
  /** AI-authored code under review. No backend record; nothing has run. */
  | "aiDraft";

export interface LiveEditPolicy {
  kind: EditorDocumentKind;
  /**
   * Does an idle pause write the buffer to the store, with no gesture at all?
   * This is the VBE behaviour, and it is only safe where a store write is JUST a
   * store write.
   */
  autoPersistOnIdle: boolean;
  /**
   * Does an explicit gesture — Run, Debug, Ctrl+S, switching document, closing
   * the window — write it through first, so what runs is what is on screen?
   */
  persistOnGesture: boolean;
  /** One sentence, suitable for a tooltip, explaining the row above. */
  rationale: string;
}

const POLICIES: Record<EditorDocumentKind, LiveEditPolicy> = {
  // A module store write is JUST a write: nothing is mounted, no realm restarts,
  // no `setup()` re-runs, and no capability grant is re-evaluated (grants are
  // re-checked at MOUNT, and a module has no standing mount — buttons mount it
  // transiently per click, the debugger mounts it transiently per session). So
  // the VBE model applies literally: the module IS the code, and Ctrl+S saves
  // the workbook, not the module.
  module: {
    kind: "module",
    autoPersistOnIdle: true,
    persistOnGesture: true,
    rationale:
      "A module is the live code: edits are stored as you type, and the workbook is what you save.",
  },
  // An object script's save is also an APPLY — emitSaveAndApply remounts the
  // live realm, which re-runs setup() and re-hashes the source for the
  // capability-grant binding. Doing that on an idle timer would restart running
  // code (and re-prompt for capabilities) every time the author paused typing,
  // for half-written text they never asked to run. It still flushes on an
  // explicit gesture: pressing Run IS asking for it.
  objectScript: {
    kind: "objectScript",
    autoPersistOnIdle: false,
    persistOnGesture: true,
    rationale:
      "Saving an object script also remounts it and re-runs setup(), so it is applied when you ask — Run, Debug or Ctrl+S — not while you type.",
  },
  // An AI draft becomes real code only when a human presses Save. Nothing may
  // write it — not a timer, not a gesture, not closing the window. Run and Debug
  // are not offered for a draft at all, so there is no gesture to honour.
  aiDraft: {
    kind: "aiDraft",
    autoPersistOnIdle: false,
    persistOnGesture: false,
    rationale:
      "An AI draft is not saved, not mounted and has never run. Only you, pressing Save, can turn it into a script.",
  },
};

/** The policy for a document kind. */
export function liveEditPolicyFor(kind: EditorDocumentKind): LiveEditPolicy {
  return POLICIES[kind];
}

/** Which kind the editor currently has open. */
export function editorDocumentKind(flags: {
  isDraft: boolean;
  isModule: boolean;
}): EditorDocumentKind {
  if (flags.isDraft) return "aiDraft";
  return flags.isModule ? "module" : "objectScript";
}
