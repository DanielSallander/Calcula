//! FILENAME: app/extensions/Table/components/TableJsonPane.tsx
// PURPOSE: The "Table JSON" task pane: the selected table's definition as
//          editable JSON (Monaco, Apply / Revert).
// CONTEXT: Replaces the Table Design ribbon's JSON overlay, which was a
//          `position: fixed` box pinned at right 8 / top 140 over whatever the
//          window held there, with hardcoded chrome and no way to move, resize
//          or dock it. A task pane is the app's one surface for "a tall editor
//          beside the grid": it docks, resizes, closes from its own header and
//          follows the skin. The Table Design panel's JSON hero opens it (and
//          closes it again); the pane is registered in ../manifest.ts with
//          contextKeys ["table"].
//
//          WHICH TABLE. The pane follows the selection: the Table extension
//          broadcasts TABLE_STATE whenever the cursor enters a table, and the
//          pane retargets to it. It does NOT retarget while the editor holds
//          unsaved edits — switching would throw the edits away, and the old
//          overlay did worse: it kept the old text and pointed Apply at the NEW
//          table's id, so an Apply wrote one table's JSON over another. With
//          edits pending the pane says the selection has moved and stays put
//          until they are applied or reverted.
//
//          The editor body is keyed by table id, so a retarget is a fresh
//          `useJsonToggle` (a fresh fetch) rather than a mutation of one.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { css } from "@emotion/css";
import { onAppEvent, emitAppEvent, RibbonIcon } from "@api";
import type { TaskPaneViewProps } from "@api/uiTypes";
import { Button, LT, FONT_FAMILY, GAP_SM } from "@api/layout";
import { useJsonToggle, JsonToggleEditor } from "../../_shared/components/jsonToggle";
import { TableEvents } from "../lib/tableEvents";
import type { Table } from "../lib/tableStore";

/** Task pane view id (registered by ../manifest.ts, opened by the JSON hero). */
export const TABLE_JSON_PANE_ID = "table-json";

// ============================================================================
// Styles (tokens only)
// ============================================================================

const styles = {
  root: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-family: ${FONT_FAMILY};
    color: ${LT.text};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${GAP_SM}px;
    flex: none;
    min-height: 32px;
    padding: 4px 10px;
    box-sizing: border-box;
    border-bottom: 1px solid ${LT.controlDivider};
  `,
  title: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 600;
  `,
  notice: css`
    flex: none;
    padding: 6px 10px;
    font-size: 11px;
    line-height: 1.4;
    color: ${LT.warnFg};
    background: ${LT.warnBg};
  `,
  body: css`
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  `,
  message: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: ${GAP_SM}px;
    padding: 12px 10px;
    font-size: 12px;
    color: ${LT.textSecondary};
  `,
  error: css`
    color: ${LT.dangerFg};
  `,
};

// ============================================================================
// Editor body — one table
// ============================================================================

interface TableTarget {
  id: string;
  name: string;
}

interface TableJsonBodyProps {
  target: TableTarget;
  /** Reports whether this table's editor holds unsaved edits. */
  onDirtyChange: (dirty: boolean, target: TableTarget) => void;
}

function TableJsonBody({ target, onDirtyChange }: TableJsonBodyProps): React.ReactElement {
  const json = useJsonToggle("table", target.id, () => {
    // The backend object changed under the table cache: re-read it (which also
    // re-broadcasts TABLE_STATE through the Design tab sync), and ask for the
    // current state so the Design sections refresh their copies at once.
    emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
    emitAppEvent(TableEvents.TABLE_REQUEST_STATE);
  });

  // The pane IS the JSON view, so JSON mode is entered on mount — exactly
  // once (a ref, so StrictMode's double effect cannot toggle it back off).
  const entered = useRef(false);
  const { toggle } = json;
  useEffect(() => {
    if (entered.current) return;
    entered.current = true;
    void toggle();
  }, [toggle]);

  // Tell the pane whether leaving this table would lose edits. The target is
  // read through a ref so a rename (same id, new name) does not re-announce.
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  const pending = json.dirty && json.isJsonMode;
  useEffect(() => {
    onDirtyChange(pending, targetRef.current);
  }, [pending, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false, targetRef.current), [onDirtyChange]);

  if (!json.isJsonMode) {
    return (
      <div className={styles.message} data-testid="table-json-status">
        {json.error ? (
          <>
            <span className={styles.error}>{json.error}</span>
            <Button variant="outlined" onClick={() => void toggle()}>
              Retry
            </Button>
          </>
        ) : (
          <span>Loading table JSON...</span>
        )}
      </div>
    );
  }

  return (
    <div className={styles.body}>
      <JsonToggleEditor
        json={json.json}
        onChange={json.setJson}
        onApply={() => void json.apply()}
        onRevert={json.revert}
        dirty={json.dirty}
        error={json.error}
        loading={json.loading}
      />
    </div>
  );
}

// ============================================================================
// The pane
// ============================================================================

function targetFromData(data: Record<string, unknown> | undefined): TableTarget | null {
  const id = data?.tableId;
  if (typeof id !== "string" || id === "") return null;
  const name = typeof data?.tableName === "string" ? data.tableName : "";
  return { id, name };
}

export function TableJsonPane({ data }: TaskPaneViewProps): React.ReactElement {
  const opened = targetFromData(data);
  const openedId = opened?.id ?? null;

  /** The table the selection is on (or the one the pane was opened for). */
  const [followed, setFollowed] = useState<TableTarget | null>(opened);
  /** The table whose editor holds unsaved edits — the pane stays on it. */
  const [held, setHeld] = useState<TableTarget | null>(null);

  // Opened again (the hero, for another table): follow the new request. The
  // "adjust state when a prop changes" pattern — during render, not in an
  // effect, so the stale table never paints first.
  const [lastOpenedId, setLastOpenedId] = useState(openedId);
  if (openedId !== lastOpenedId) {
    setLastOpenedId(openedId);
    if (opened && followed?.id !== opened.id) setFollowed(opened);
  }

  // Follow the selection, and ask for the current state once on mount.
  useEffect(() => {
    const unsub = onAppEvent<{ table: Table }>(TableEvents.TABLE_STATE, (detail) => {
      const table = detail?.table;
      if (!table) return;
      setFollowed((prev) =>
        prev && prev.id === table.id && prev.name === table.name
          ? prev
          : { id: table.id, name: table.name },
      );
    });
    emitAppEvent(TableEvents.TABLE_REQUEST_STATE);
    return unsub;
  }, []);

  const handleDirtyChange = useCallback((dirty: boolean, target: TableTarget) => {
    setHeld(dirty ? target : null);
  }, []);

  // Retarget only when nothing unsaved would be lost. A rename of the SAME
  // table always flows through (the key is the id, so the editor survives).
  const shown: TableTarget | null =
    held && (!followed || followed.id !== held.id) ? held : followed;

  if (!shown) {
    return (
      <div className={styles.root}>
        <div className={styles.message} data-testid="table-json-empty">
          Select a cell inside a table to edit its definition as JSON.
        </div>
      </div>
    );
  }

  const selectionMoved = followed !== null && followed.id !== shown.id;

  return (
    <div className={styles.root} data-testid="table-json-pane">
      <div className={styles.header}>
        <RibbonIcon.Table size={16} />
        <span className={styles.title} title={shown.name || undefined}>
          {shown.name || "Table"}
        </span>
      </div>
      {selectionMoved && (
        <div className={styles.notice} role="status" data-testid="table-json-held">
          The selection moved to {followed?.name || "another table"}. Apply or revert your
          edits to follow it.
        </div>
      )}
      <TableJsonBody key={shown.id} target={shown} onDirtyChange={handleDirtyChange} />
    </div>
  );
}
