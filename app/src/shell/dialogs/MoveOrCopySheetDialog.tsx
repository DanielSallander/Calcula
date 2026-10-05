//! FILENAME: app/src/shell/dialogs/MoveOrCopySheetDialog.tsx
// PURPOSE: Excel's Move or Copy dialog (Home > Cells > Format > Move or Copy
//          Sheet...): a "Before sheet" list ending in "(move to end)", a
//          "Create a copy" box, OK / Cancel.
// CONTEXT: The dialog only ANSWERS -- `{ beforeIndex, copy }`, with
//          `beforeIndex` a TRUE workbook index or null for the end -- and the
//          sheet tab strip does the work (sheetTabFlows.ts: `copy_sheet` and/or
//          `move_sheet`, then the strip's own sheet-switch steps). Opened by
//          the `core.sheet.moveOrCopy` command (SheetTabs/sheetCommands.ts),
//          registered with the dialog host there.
//
//          Named divergences from Excel:
//            - no "To book:" box: a Calcula window holds one workbook, so the
//              only book a sheet can go to is this one;
//            - the list shows the VISIBLE sheets, the ones on the tab strip; a
//              hidden sheet keeps its place among them;
//            - "Create a copy" is disabled for a canvas, which the backend
//              refuses to copy (its objects would not come along).
//
//          Keyboard: the list takes the arrows, Home and End; Enter is OK and
//          Escape is Cancel anywhere in the dialog; a double-click on a row
//          chooses it and confirms, as in Excel.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import * as S from "./MoveOrCopySheetDialog.styles";

export const MOVE_OR_COPY_SHEET_DIALOG_ID = "core:move-or-copy-sheet";

/** What the user chose. `beforeIndex` null is "(move to end)". */
export interface MoveOrCopySheetChoice {
  beforeIndex: number | null;
  copy: boolean;
}

export interface MoveOrCopySheetData {
  /** TRUE index of the sheet being moved or copied. */
  sourceIndex: number;
  sourceName: string;
  /** The sheets the "Before sheet" list offers, in tab order (TRUE indices). */
  sheets: Array<{ index: number; name: string }>;
  /** False for a sheet the backend cannot copy (a canvas). */
  canCopy: boolean;
  /** Called once with the choice on OK; never on Cancel. */
  onResult: (choice: MoveOrCopySheetChoice) => void | Promise<void>;
}

/** A row of the list: a sheet's TRUE index, or the end. */
type RowKey = number | "end";

export function MoveOrCopySheetDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const d = (data ?? {}) as unknown as Partial<MoveOrCopySheetData>;
  const sheets = useMemo(() => d.sheets ?? [], [d.sheets]);
  const canCopy = d.canCopy === true;
  const onResult = d.onResult;

  const rows = useMemo<Array<{ key: RowKey; label: string }>>(
    () => [
      ...sheets.map((s) => ({ key: s.index as RowKey, label: s.name })),
      { key: "end" as RowKey, label: "(move to end)" },
    ],
    [sheets],
  );

  // Excel opens with the sheet being moved selected in the list.
  const [selected, setSelected] = useState<RowKey>(() =>
    sheets.some((s) => s.index === d.sourceIndex) ? (d.sourceIndex as number) : "end",
  );
  const [copy, setCopy] = useState(false);

  const win = useDialogWindow({ minWidth: 320, minHeight: 200, resizable: false });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // Keep the selected row in view as the arrows walk the list. (jsdom has no
  // scrollIntoView, hence the optional call.)
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const confirm = useCallback(
    (row: RowKey = selected) => {
      onClose();
      void onResult?.({ beforeIndex: row === "end" ? null : row, copy: canCopy && copy });
    },
    [selected, copy, canCopy, onResult, onClose],
  );

  const cancel = useCallback(() => onClose(), [onClose]);

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const at = rows.findIndex((r) => r.key === selected);
      let next = at;
      if (e.key === "ArrowDown") next = Math.min(rows.length - 1, at + 1);
      else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = rows.length - 1;
      else return;
      e.preventDefault();
      if (next >= 0 && next < rows.length) setSelected(rows[next].key);
    },
    [rows, selected],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Nothing typed here may reach the grid's keyboard.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        // A focused button answers Enter itself (Cancel must stay Cancel).
        if ((e.target as HTMLElement).tagName === "BUTTON") return;
        e.preventDefault();
        confirm();
      }
    },
    [cancel, confirm],
  );

  const optionId = (key: RowKey): string => `move-or-copy-option-${key}`;

  return (
    <S.Backdrop onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <S.DialogContainer
        ref={win.ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-or-copy-title"
        data-testid="move-or-copy-sheet-dialog"
        style={{ position: "relative", ...win.style }}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <S.Header onMouseDown={win.onHeaderMouseDown}>
          <S.Title id="move-or-copy-title">Move or Copy</S.Title>
          <S.CloseButton onClick={cancel} title="Close (Esc)" aria-label="Close">✕</S.CloseButton>
        </S.Header>
        <S.Body>
          <S.Label data-testid="move-or-copy-source">
            Move selected sheet: <S.SourceName>{d.sourceName ?? ""}</S.SourceName>
          </S.Label>
          <S.Label id="move-or-copy-before-label">Before sheet:</S.Label>
          <S.List
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-labelledby="move-or-copy-before-label"
            aria-activedescendant={optionId(selected)}
            data-testid="move-or-copy-before-list"
            onKeyDown={handleListKeyDown}
          >
            {rows.map((row) => (
              <S.Option
                key={String(row.key)}
                id={optionId(row.key)}
                role="option"
                aria-selected={row.key === selected}
                $selected={row.key === selected}
                data-testid={`move-or-copy-before-${row.key}`}
                onClick={() => setSelected(row.key)}
                onDoubleClick={() => {
                  setSelected(row.key);
                  confirm(row.key);
                }}
              >
                {row.label}
              </S.Option>
            ))}
          </S.List>
          <S.CheckRow
            $disabled={!canCopy}
            title={canCopy ? undefined : "A canvas sheet cannot be copied yet: its objects would not come along."}
          >
            <input
              type="checkbox"
              data-testid="move-or-copy-create-copy"
              checked={canCopy && copy}
              disabled={!canCopy}
              onChange={(e) => setCopy(e.target.checked)}
            />
            Create a copy
          </S.CheckRow>
        </S.Body>
        <S.Footer>
          <S.Button data-testid="move-or-copy-cancel" onClick={cancel}>Cancel</S.Button>
          <S.Button $primary data-testid="move-or-copy-ok" onClick={() => confirm()}>OK</S.Button>
        </S.Footer>
        {win.resizeHandles}
      </S.DialogContainer>
    </S.Backdrop>
  );
}

export default MoveOrCopySheetDialog;
