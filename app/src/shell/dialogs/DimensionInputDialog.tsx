//! FILENAME: app/src/shell/dialogs/DimensionInputDialog.tsx
// PURPOSE: Proper styled dialog for setting Column Width / Row Height, replacing
//          the raw window.prompt. Speaks Excel units (column = characters,
//          row = points) and converts to the pixel value the engine stores.
// CONTEXT: Registered with DialogExtensions and opened from the grid context menu
//          (registries/gridExtensions.ts) and from Home > Format (Row Height...,
//          Column Width..., Default Width... -- registries/gridFormatCommands.ts).
//          Movable via useDialogWindow, per the app-wide dialog convention.
//
//          Three modes. `defaultWidth` is Excel's Standard Width dialog: the
//          STANDARD column width, in the same character units as Column Width
//          (it is a column width, just not one column's).

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { DialogProps } from "@api/uiTypes";
import { DEFAULT_GRID_CONFIG } from "@api/types";
import { useDialogWindow } from "@api/dialogWindow";
import { formatNumber, parseNumber } from "@api/locale";
import * as S from "./DimensionInputDialog.styles";

export const DIMENSION_INPUT_DIALOG_ID = "core:dimension-input";

export type DimensionMode = "columnWidth" | "rowHeight" | "defaultWidth";

export interface DimensionInputData {
  mode: DimensionMode;
  /** Current size in pixels (the engine's storage unit). */
  currentPx: number;
  /** 1-based label for the affected range, e.g. "A" or "3" (display only). */
  rangeLabel?: string;
  /** Called with the new pixel size when the user confirms (never on cancel). */
  onResult?: (newPx: number) => void;
}

// --- Excel unit conversions -------------------------------------------------
// Column width is measured in "characters" of the default font's digit:
//   MDW (Maximum Digit Width) of Calibri 11 @ 96 DPI = 7px; pixels = chars*MDW + 5,
//   where 5 = 2px+2px side padding + the 1px gridline. Kept as FLOAT (no rounding)
//   so distinct character values (8.43 vs 8.47) map to distinct pixels and the
//   entered value round-trips instead of collapsing back to the default.
// Row height is measured in POINTS (like Excel): px = pt * 96/72.
const MDW = 7;
const COL_PAD = 5;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Column widths -- one column's or the standard one -- are in characters. */
const inCharacters = (mode: DimensionMode): boolean => mode !== "rowHeight";

function pxToUnits(mode: DimensionMode, px: number): number {
  return inCharacters(mode)
    ? round2((px - COL_PAD) / MDW)
    : round2(px * (72 / 96));
}
function unitsToPx(mode: DimensionMode, units: number): number {
  return inCharacters(mode)
    ? units * MDW + COL_PAD
    : units * (96 / 72);
}

/** The window title and the field's words, per mode (Excel's own). */
const MODE_TEXT: Record<DimensionMode, { title: string; field: string }> = {
  columnWidth: { title: "Column Width", field: "Column width" },
  rowHeight: { title: "Row Height", field: "Row height" },
  defaultWidth: { title: "Standard Width", field: "Standard column width" },
};

export function DimensionInputDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const d = (data ?? {}) as unknown as Partial<DimensionInputData>;
  const mode: DimensionMode = d.mode ?? "columnWidth";
  // Defensive fallback only (`currentPx` is required in DimensionInputData).
  // It reads DEFAULT_GRID_CONFIG rather than repeating the number: those two
  // defaults have exactly one definition each — the Rust consts in
  // core/persistence, mirrored into DEFAULT_GRID_CONFIG and pinned to them by
  // core/lib/__tests__/defaultGeometry.test.ts. A literal here would be the
  // sixth copy of the pair that already drifted once. It is also MODE-AWARE:
  // the old `?? 64.29` handed a row-height dialog a column width.
  const currentPx =
    d.currentPx ??
    (inCharacters(mode)
      ? DEFAULT_GRID_CONFIG.defaultCellWidth
      : DEFAULT_GRID_CONFIG.defaultCellHeight);
  const rangeLabel = d.rangeLabel;
  const onResult = d.onResult;

  const win = useDialogWindow({ minWidth: 320, minHeight: 160, resizable: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<string>(() => formatNumber(pxToUnits(mode, currentPx)));

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  }, []);

  const unitWord = inCharacters(mode) ? "characters" : "points";
  const text = MODE_TEXT[mode] ?? MODE_TEXT.columnWidth;

  // Shown and read in the APP locale (P2 S11), as Excel's box is: "8,43"
  // under sv-SE and de-DE. It used to accept either mark by folding "," into
  // "." -- which read de-DE "1.000" (one thousand) as 1 and could never be
  // the same rule as the cell it sizes.
  const parsed = useMemo(() => parseNumber(value) ?? NaN, [value]);

  const valid = !Number.isNaN(parsed) && parsed > 0;
  const previewPx = valid ? unitsToPx(mode, parsed) : NaN;

  const finish = useCallback((apply: boolean) => {
    if (apply && valid) onResult?.(previewPx);
    onClose();
  }, [valid, previewPx, onResult, onClose]);

  const handleOK = useCallback(() => { if (valid) finish(true); }, [valid, finish]);
  const handleCancel = useCallback(() => finish(false), [finish]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") { handleCancel(); }
    else if (e.key === "Enter") { e.preventDefault(); handleOK(); }
  }, [handleCancel, handleOK]);

  return (
    <S.Backdrop onMouseDown={(e) => { if (e.target === e.currentTarget) handleCancel(); }}>
      <S.DialogContainer
        ref={win.ref}
        style={{ position: "relative", ...win.style }}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <S.Header onMouseDown={win.onHeaderMouseDown}>
          <S.Title>{text.title}</S.Title>
          <S.CloseButton onClick={handleCancel} title="Close (Esc)">✕</S.CloseButton>
        </S.Header>
        <S.Body>
          <S.Field>
            {text.field}
            {rangeLabel ? ` (${rangeLabel})` : ""} in {unitWord}:
            <S.Input
              ref={inputRef}
              type="text"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </S.Field>
          {valid
            ? <S.Hint>= {round2(previewPx)} pixels</S.Hint>
            : <S.ErrorText>Enter a positive number.</S.ErrorText>}
        </S.Body>
        <S.Footer>
          <S.Button onClick={handleCancel}>Cancel</S.Button>
          <S.Button $primary onClick={handleOK} disabled={!valid}>OK</S.Button>
        </S.Footer>
        {win.resizeHandles}
      </S.DialogContainer>
    </S.Backdrop>
  );
}

export default DimensionInputDialog;
