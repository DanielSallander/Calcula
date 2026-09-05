//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/FormDesignerPanel.tsx
// PURPOSE: The visual form designer: a palette, a canvas painted by the shared
//          widget tree, and a property panel — every gesture of which ends as
//          CODE in the script the user already owns.
// CONTEXT: M5b of docs/design/typescript-forms.md §14.
//
//          ONE ARTIFACT (app/src/api/scriptTranspile.ts's header) is the rule
//          this milestone lives or dies by, and here is what it costs in
//          practice: this component holds no layout. Its whole state is a
//          SELECTION and an OPEN CONTAINER — two paths, both re-validated
//          against whatever the source says on the next read. Every edit builds
//          a new `FormSpec` from the one the reader just returned, hands it to
//          `writeFormRegion`, and puts the resulting SOURCE into the editor's
//          buffer. There is no designer document, no autosave of a layout, and
//          nothing that could still be true after the user edits the code by
//          hand.
//
//          THREE THINGS STOP AN EDIT, and each says so rather than acting:
//            - the reader REFUSED the script (a layout built out of variables,
//              two regions, code between the markers). The canvas is not drawn
//              at all — an approximation of somebody's code is worse than no
//              designer — and the refusal offers the code editor.
//            - the region holds COMMENTS, which a re-emit destroys. Editing is
//              blocked until the user has seen the sentence naming them.
//            - the script is READ-ONLY (a publisher's, or one that would not
//              load). The designer still draws it; nothing may write it.

import React, { useCallback, useMemo, useState } from "react";

import type { FormSpec, FormWidgetType } from "@api/scriptHost/scriptFormSpec";
import type { FormDesignerRefusal } from "@api/formDesigner";

import { DesignerCanvas, type DesignerKeyCommand } from "./DesignerCanvas";
import { DesignerPalette } from "./DesignerPalette";
import { DesignerProperties } from "./DesignerProperties";
import type { DesignerDrag } from "./designerDrag";
import {
  ROOT_PATH,
  childListAt,
  childPath,
  childrenOf,
  containerAddressOf,
  containerPathOf,
  indexOfPath,
  insertWidget,
  isPrefixPath,
  moveWidget,
  pathKey,
  removeWidget,
  samePath,
  setSpecKey,
  setWidgetKey,
  widgetAt,
  type FormPath,
} from "./designerModel";
import { newWidgetOfType } from "./widgetPalette";
import { useFormDesignerDocument } from "./useFormDesignerDocument";
import * as S from "./designerStyles";

export interface FormDesignerPanelProps {
  /** The script text on screen. The designer reads its layout out of this. */
  source: string;
  /** Put edited script text into the buffer — the editor's own change path. */
  onSourceChange: (next: string) => void;
  /** Leave the designer for the code editor. */
  onEditAsCode: () => void;
  /** Names the script in compiler messages. */
  fileLabel?: string;
  /** Draw it, never write it (a distributed script, an unreadable record). */
  readOnly?: boolean;
  /** Why it is read-only, in the user's words. */
  readOnlyReason?: string;
}

export function FormDesignerPanel({
  source,
  onSourceChange,
  onEditAsCode,
  fileLabel,
  readOnly,
  readOnlyReason,
}: FormDesignerPanelProps): React.ReactElement {
  const [acknowledgedComments, setAcknowledgedComments] = useState(false);
  const [writeRefusal, setWriteRefusal] = useState<FormDesignerRefusal | null>(null);
  const [openState, setOpenContainer] = useState<FormPath>(ROOT_PATH);
  const [selectedState, setSelected] = useState<FormPath | null>(null);

  const { document, applyEdit, writing, stale } = useFormDesignerDocument({
    source,
    onSourceChange,
    fileLabel,
    acknowledgeCommentLoss: acknowledgedComments,
  });

  const spec = document.status === "ready" ? document.spec : null;

  /**
   * A selection is a POSITION, and positions expire: the code tab can delete
   * the widget it named, and a container can stop being a container. Rather
   * than let a stale path address whatever slid into its place, both are
   * re-checked against every spec the reader returns and dropped when dead.
   *
   * DURING RENDER, not in an effect. React's own guidance for state derived
   * from a changed input, and here it matters more than style: an effect would
   * paint one frame with the dead path still selected, and everything below —
   * the property panel, the canvas, the key handler — would read it.
   *
   * NEVER AGAINST A STALE SPEC. Between a write landing in the buffer and its
   * re-read coming back, the spec on hand is the one the edit was made FROM —
   * and every position an edit reports (a dropped widget, the group it went
   * into) is by definition absent from it. Judging them there would delete the
   * result of every successful edit at the instant it succeeded.
   */
  if (spec && !stale) {
    if (childListAt(spec, openState) === null) setOpenContainer(ROOT_PATH);
    if (selectedState !== null && widgetAt(spec, selectedState) === null) setSelected(null);
  }

  /**
   * The container and the selection AS THE SPEC ON HAND CAN EXPRESS THEM.
   *
   * The state above is where the user asked to be; these two are where the spec
   * currently drawn can put them, and they differ only for the frames the
   * paragraph above describes. Deriving rather than resetting is what lets that
   * window pass without destroying the state: the canvas falls back to the form
   * itself for one paint and lands inside the new container when the read
   * returns, instead of snapping to the root and staying there.
   */
  const openContainer = spec !== null && childListAt(spec, openState) === null ? ROOT_PATH : openState;
  const selected =
    spec !== null && selectedState !== null && widgetAt(spec, selectedState) === null
      ? null
      : selectedState;

  const blockedReason = useMemo((): string | null => {
    if (readOnly) {
      return readOnlyReason ?? "This script is read-only here, so the designer will not change it.";
    }
    if (document.status === "ready" && document.commentWarning && !acknowledgedComments) {
      return document.commentWarning;
    }
    return null;
  }, [readOnly, readOnlyReason, document, acknowledgedComments]);

  const editsBlocked = blockedReason !== null || document.status !== "ready";

  /**
   * Apply one edited spec, and select — and, when the edit moved the widget
   * somewhere the canvas is not showing, OPEN — what the operation says to.
   *
   * A widget dropped into a group is otherwise gone from the screen while still
   * being the thing the property panel is editing. Descending into the
   * destination is what makes "it went in there" something the user SEES rather
   * than has to reconstruct from what vanished.
   */
  const commit = useCallback(
    async (next: FormSpec, select?: FormPath | null, open?: FormPath): Promise<void> => {
      if (editsBlocked) return;
      const refusal = await applyEdit(next);
      setWriteRefusal(refusal);
      // A refused write left the script alone, so neither the selection nor the
      // open container may move to a position that only exists in the spec that
      // was rejected.
      if (refusal !== null) return;
      if (open !== undefined && !samePath(open, openState)) setOpenContainer(open);
      if (select !== undefined) setSelected(select);
    },
    [applyEdit, editsBlocked, openState],
  );

  /** Where a palette press puts a widget: after the selection, else at the end. */
  const insertionIndex = useCallback((): number => {
    if (!spec) return 0;
    const list = childListAt(spec, openContainer) ?? [];
    if (selected !== null && samePath(containerPathOf(selected), openContainer)) {
      return indexOfPath(selected) + 1;
    }
    return list.length;
  }, [spec, openContainer, selected]);

  const handleAdd = useCallback(
    (type: FormWidgetType) => {
      if (!spec) return;
      const widget = newWidgetOfType(type, spec);
      const { spec: next, path } = insertWidget(spec, openContainer, insertionIndex(), widget);
      void commit(next, path);
    },
    [spec, openContainer, insertionIndex, commit],
  );

  /**
   * A drop, into WHATEVER container took it.
   *
   * `container` comes from the target the pointer was actually over — the open
   * container's list, or a container card's body one level down — and is never
   * assumed to be the open one. Reading it from panel state instead is how this
   * shipped, and it made reparenting inexpressible: source and destination were
   * the same list by construction, so a widget aimed at a group was reordered
   * beside it and nothing said so.
   */
  const handleDrop = useCallback(
    (drag: DesignerDrag, container: FormPath, index: number) => {
      if (!spec) return;
      // The destination is measured from the DOM, so a container the code tab
      // deleted mid-drag must not be written to at the address it used to have.
      if (childListAt(spec, container) === null) return;
      if (drag.kind === "palette") {
        const widget = newWidgetOfType(drag.widgetType, spec);
        const { spec: next, path } = insertWidget(spec, container, index, widget);
        void commit(next, path, containerPathOf(path));
        return;
      }
      // A move whose source has gone (the code tab deleted it under the drag)
      // is a no-op, never an insert of a widget reconstructed from nothing.
      if (widgetAt(spec, drag.path) === null) return;
      if (isPrefixPath(drag.path, container)) {
        setWriteRefusal({
          code: "invalid-spec",
          message: "A container cannot be moved inside itself.",
        });
        return;
      }
      const { spec: next, path } = moveWidget(spec, drag.path, container, index);
      if (next === spec) {
        setSelected(path);
        return;
      }
      // `moveWidget` re-measures the destination after the removal, so the
      // container to open is the one the returned path actually sits in — not
      // the address the drop reported before the widget left its old list.
      void commit(next, path, containerPathOf(path));
    },
    [spec, commit],
  );

  const handleOpen = useCallback(
    (path: FormPath) => {
      if (!spec) return;
      const widget = widgetAt(spec, path);
      if (!widget || childrenOf(widget) === null) return;
      setOpenContainer(containerAddressOf(path));
      setSelected(null);
    },
    [spec],
  );

  const handleNavigate = useCallback((container: FormPath) => {
    setOpenContainer(container);
    setSelected(null);
  }, []);

  const handleDelete = useCallback(() => {
    if (!spec || selected === null) return;
    const { spec: next, path } = removeWidget(spec, selected);
    if (next === spec) return;
    void commit(next, samePath(path, openContainer) ? null : path);
  }, [spec, selected, openContainer, commit]);

  const handleKeyCommand = useCallback(
    (command: DesignerKeyCommand) => {
      if (!spec) return;
      const list = childListAt(spec, openContainer) ?? [];
      switch (command.kind) {
        case "select": {
          if (list.length === 0) return;
          const at =
            selected !== null && samePath(containerPathOf(selected), openContainer)
              ? indexOfPath(selected)
              : command.delta > 0
                ? -1
                : list.length;
          const next = Math.max(0, Math.min(at + command.delta, list.length - 1));
          setSelected([...openContainer, { index: next }]);
          return;
        }
        case "reorder": {
          if (selected === null || !samePath(containerPathOf(selected), openContainer)) return;
          const from = indexOfPath(selected);
          // `moveWidget` takes the index in the list as it is BEFORE the
          // removal, so moving down one place is an insert two slots along.
          const to = command.delta > 0 ? from + 2 : from - 1;
          if (to < 0 || to > list.length) return;
          const { spec: next, path } = moveWidget(spec, selected, openContainer, to);
          if (next === spec) return;
          void commit(next, path);
          return;
        }
        case "indent": {
          // INTO THE CONTAINER JUST ABOVE, at its end. That is the outliner
          // rule, and it is the only one that names a destination without a
          // second gesture — the mouse points at the container it means, the
          // keyboard cannot, so the rule has to be positional.
          if (selected === null || !samePath(containerPathOf(selected), openContainer)) return;
          const from = indexOfPath(selected);
          const above = from > 0 ? list[from - 1] : null;
          const into = above === null ? null : childrenOf(above);
          if (into === null) {
            if (!editsBlocked) {
              setWriteRefusal({
                code: "invalid-spec",
                message:
                  "Ctrl+Right puts a widget inside the container just above it, and there is no " +
                  "group, row or tabs above this one. Move it below one first.",
              });
            }
            return;
          }
          const destination = containerAddressOf(childPath(openContainer, from - 1));
          const { spec: next, path } = moveWidget(spec, selected, destination, into.length);
          if (next === spec) return;
          void commit(next, path, containerPathOf(path));
          return;
        }
        case "outdent": {
          // Out of the open container, landing directly after it. At the top
          // level there is nowhere further out, and the breadcrumb already says
          // so — a message there would be noise on a key that changed nothing.
          if (selected === null || !samePath(containerPathOf(selected), openContainer)) return;
          if (openContainer.length === 0) return;
          const outside = containerPathOf(openContainer);
          const { spec: next, path } = moveWidget(
            spec,
            selected,
            outside,
            indexOfPath(openContainer) + 1,
          );
          if (next === spec) return;
          void commit(next, path, containerPathOf(path));
          return;
        }
        case "descend": {
          if (selected === null) return;
          handleOpen(selected);
          return;
        }
        case "ascend": {
          if (openContainer.length === 0) {
            setSelected(null);
            return;
          }
          const wasOpen = openContainer;
          setOpenContainer(containerPathOf(wasOpen));
          setSelected([...containerPathOf(wasOpen), { index: indexOfPath(wasOpen) }]);
          return;
        }
        case "delete":
          handleDelete();
      }
    },
    [spec, openContainer, selected, commit, editsBlocked, handleOpen, handleDelete],
  );

  const handleSetWidgetKey = useCallback(
    (key: string, value: unknown) => {
      if (!spec || selected === null) return;
      const next = setWidgetKey(spec, selected, key, value);
      if (next === spec) return;
      void commit(next, selected);
    },
    [spec, selected, commit],
  );

  const handleSetSpecKey = useCallback(
    (key: string, value: unknown) => {
      if (!spec) return;
      const next = setSpecKey(spec, key, value);
      if (next === spec) return;
      void commit(next, selected);
    },
    [spec, selected, commit],
  );

  if (document.status === "loading") {
    return (
      <div style={{ ...S.canvasSurface, color: S.COLORS.muted }} data-testid="designer-loading">
        Reading the layout out of this script…
      </div>
    );
  }

  if (document.status === "refused") {
    return <DesignerRefusalCard refusal={document.refusal} onEditAsCode={onEditAsCode} />;
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
      data-testid="form-designer"
      data-designer-blocked={editsBlocked ? "true" : "false"}
    >
      {blockedReason ? (
        <div style={S.banner("warn")} data-testid="designer-block-banner">
          <span style={{ flex: 1 }}>{blockedReason}</span>
          {!readOnly && document.commentWarning ? (
            <button
              type="button"
              className="ose-btn"
              data-testid="designer-accept-comment-loss"
              onClick={() => setAcknowledgedComments(true)}
            >
              Rewrite the block anyway
            </button>
          ) : null}
          <button type="button" className="ose-btn" onClick={onEditAsCode}>
            Edit as code
          </button>
        </div>
      ) : null}
      {document.definesOutsideRegion > 0 ? (
        <div style={S.banner("warn")} data-testid="designer-outside-define-banner">
          <span style={{ flex: 1 }}>
            This script calls define(...) {document.definesOutsideRegion} more{" "}
            {document.definesOutsideRegion === 1 ? "time" : "times"} outside the designer's block.
            Whichever call runs last is the layout the form shows, so what you edit here may not be
            what appears.
          </span>
        </div>
      ) : null}
      {writeRefusal ? (
        <div style={S.banner("error")} data-testid="designer-write-refusal">
          <span style={{ flex: 1 }}>{writeRefusal.message}</span>
          <button
            type="button"
            className="ose-btn"
            data-testid="designer-dismiss-refusal"
            onClick={() => setWriteRefusal(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <DesignerPalette disabled={editsBlocked || writing} onAdd={handleAdd} />
        <DesignerCanvas
          spec={document.spec}
          openContainer={openContainer}
          selected={selected}
          onSelect={setSelected}
          onOpen={handleOpen}
          onNavigate={handleNavigate}
          onDrop={handleDrop}
          onKeyCommand={handleKeyCommand}
        />
        <DesignerProperties
          spec={document.spec}
          widget={selected === null ? null : widgetAt(document.spec, selected)}
          // WHICH widget its boxes are editing, not just which keys. A box still
          // holding an uncommitted draft when the selection moves would
          // otherwise commit it to whatever is selected by the time the field is
          // left — and a palette press moves the selection without taking focus
          // off the box, because the drag gesture cancels the press's default.
          selectionKey={pathKey(selected ?? ROOT_PATH)}
          disabled={editsBlocked || writing}
          onSetWidgetKey={handleSetWidgetKey}
          onSetSpecKey={handleSetSpecKey}
          onDelete={handleDelete}
        />
      </div>
    </div>
  );
}

/**
 * The designer declining to open, with the reader's own sentence.
 *
 * It offers exactly one thing — the code editor — because that is the only
 * honest answer: the layout in this script is expressed in a way the designer
 * cannot draw without guessing, and a designer that guesses writes its guess
 * back over the user's code the first time anything moves.
 */
function DesignerRefusalCard({
  refusal,
  onEditAsCode,
}: {
  refusal: FormDesignerRefusal;
  onEditAsCode: () => void;
}): React.ReactElement {
  return (
    <div
      style={{ ...S.canvasSurface, color: S.COLORS.text }}
      data-testid="designer-refusal"
      data-refusal-code={refusal.code}
      role="status"
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        The designer cannot open this form
      </div>
      <div style={{ lineHeight: 1.6, maxWidth: 640 }}>{refusal.message}</div>
      {refusal.nodeText ? (
        <pre
          data-testid="designer-refusal-code"
          style={{
            marginTop: 8,
            padding: 8,
            backgroundColor: S.COLORS.panel,
            border: `1px solid ${S.COLORS.panelBorder}`,
            borderRadius: 3,
            fontFamily: "'Cascadia Code', Consolas, monospace",
            fontSize: 11,
            whiteSpace: "pre-wrap",
          }}
        >
          {refusal.nodeText}
        </pre>
      ) : null}
      <button
        type="button"
        className="ose-btn primary"
        data-testid="designer-refusal-edit-as-code"
        onClick={onEditAsCode}
        style={{ marginTop: 10 }}
      >
        Edit as code
      </button>
    </div>
  );
}
