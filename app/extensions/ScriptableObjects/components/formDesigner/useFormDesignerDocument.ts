//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/useFormDesignerDocument.ts
// PURPOSE: The designer's ONLY relationship with the script: read the layout out
//          of the buffer on screen, and put an edited layout back into that same
//          buffer through the AST writer.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          ONE ARTIFACT, MECHANICALLY. The designer keeps no copy of the
//          layout: after every write it re-reads the buffer and draws what came
//          back. So a hand edit in the code tab is picked up the instant the
//          designer looks, a designer edit is visible in the code tab because
//          it IS the code tab's text, and there is no third state that can
//          disagree with either. It costs a parse per edit and buys the one
//          property the whole milestone rests on.
//
//          IT WRITES INTO THE BUFFER, NEVER TO DISK. `onSourceChange` is the
//          editor's own change path — the same one a keystroke takes, so the
//          module live-persist rules (liveModuleBuffer.ts), the dirty flag and
//          Monaco's undo stack all behave exactly as they do for typing. There
//          is no save call in this file and there must never be one.
//
//          A REFUSAL IS AN ANSWER, NOT AN ERROR. Every way the reader can
//          decline (a layout built out of variables, two regions, code between
//          the markers) arrives here as a sentence, and the designer shows that
//          sentence and offers the code editor. It never draws an approximation
//          of a layout it could not read exactly.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  describeCommentLoss,
  readFormRegion,
  writeFormRegion,
  type FormDesignerRefusal,
  type FormRegionComment,
} from "@api/formDesigner";
import type { FormSpec } from "@api/scriptHost/scriptFormSpec";

export interface FormDesignerDocumentOptions {
  /** The script text on screen right now. */
  source: string;
  /** Put new script text in the buffer — the editor's own change path. */
  onSourceChange: (next: string) => void;
  /** Names the script in compiler messages. */
  fileLabel?: string;
  /**
   * The user has been shown that saving destroys the comments inside the
   * region. Without it the writer REFUSES rather than eating them.
   */
  acknowledgeCommentLoss?: boolean;
}

export type FormDesignerDocument =
  | { status: "loading" }
  | {
      status: "ready";
      spec: FormSpec;
      /** Comments a write would delete; empty when there are none. */
      droppedComments: readonly FormRegionComment[];
      /** The sentence to show before the first write, or null. */
      commentWarning: string | null;
      /** Other `define(...)` calls outside the region — whichever runs last wins. */
      definesOutsideRegion: number;
    }
  | { status: "refused"; refusal: FormDesignerRefusal };

export interface FormDesignerDocumentState {
  document: FormDesignerDocument;
  /**
   * Write an edited layout into the buffer. Resolves with null when the buffer
   * now holds it, or with the refusal that stopped it — the caller shows that
   * sentence and the script is untouched.
   */
  applyEdit: (next: FormSpec) => Promise<FormDesignerRefusal | null>;
  /** True while a write is in flight; the canvas stays interactive but inert. */
  writing: boolean;
  /**
   * The document on hand was read from DIFFERENT text than the buffer now
   * holds — a write has landed and its re-read has not come back yet.
   *
   * A caller must not judge a path dead while this is true. Every edit names
   * the position it produced (the widget that was just dropped, the container
   * it went into), and that position exists only in the spec still being
   * parsed: checking it against the spec the edit was made FROM would discard
   * the selection of every successful edit at the moment it succeeded.
   */
  stale: boolean;
}

export function useFormDesignerDocument(
  options: FormDesignerDocumentOptions,
): FormDesignerDocumentState {
  const { source, onSourceChange, fileLabel, acknowledgeCommentLoss } = options;
  const [document, setDocument] = useState<FormDesignerDocument>({ status: "loading" });
  const [writing, setWriting] = useState(false);
  // The exact text the document on hand was parsed from. Stored rather than
  // inferred from a "reading" flag: the read is cancellable and re-entrant, and
  // the only honest answer to "is this spec the buffer's?" is comparing them.
  const [readFrom, setReadFrom] = useState<string | null>(null);

  // The read is asynchronous (the compiler chunk is lazy) and the buffer can
  // move while it runs, so a stale answer must never land: each read claims a
  // token and only the newest one is allowed to set state.
  const readToken = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const optionsRef = useRef({ fileLabel, acknowledgeCommentLoss });
  optionsRef.current = { fileLabel, acknowledgeCommentLoss };

  useEffect(() => {
    const token = ++readToken.current;
    let cancelled = false;
    void readFormRegion(source, { fileLabel }).then(
      (result) => {
        if (cancelled || token !== readToken.current) return;
        setReadFrom(source);
        if (!result.ok) {
          setDocument({ status: "refused", refusal: result.refusal });
          return;
        }
        setDocument({
          status: "ready",
          spec: result.spec,
          droppedComments: result.droppedComments,
          commentWarning: describeCommentLoss(result.droppedComments),
          definesOutsideRegion: result.definesOutsideRegion,
        });
      },
      (error: unknown) => {
        if (cancelled || token !== readToken.current) return;
        setReadFrom(source);
        setDocument({
          status: "refused",
          refusal: {
            code: "compiler-unavailable",
            message:
              `The designer could not read this script (${String(error)}). ` +
              "Nothing was changed; edit the layout in the code editor.",
          },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, fileLabel]);

  const applyEdit = useCallback(
    async (next: FormSpec): Promise<FormDesignerRefusal | null> => {
      setWriting(true);
      try {
        // Written against the buffer AS IT IS NOW, never against the text this
        // component last rendered: a write that raced a keystroke would splice
        // its region into a stale copy of the whole file and drop the keystroke.
        const before = sourceRef.current;
        const result = await writeFormRegion(before, next, {
          fileLabel: optionsRef.current.fileLabel,
          acknowledgeCommentLoss: optionsRef.current.acknowledgeCommentLoss === true,
        });
        if (!result.ok) return result.refusal;
        // Rule 2 of the writer: an edit that changes nothing writes no bytes,
        // and pushing identical text into the buffer would mark the document
        // dirty for a gesture that did nothing.
        if (result.changed) onSourceChange(result.source);
        return null;
      } finally {
        setWriting(false);
      }
    },
    [onSourceChange],
  );

  return { document, applyEdit, writing, stale: readFrom !== source };
}
