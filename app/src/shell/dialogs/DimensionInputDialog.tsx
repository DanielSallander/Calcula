//! FILENAME: app/src/shell/dialogs/DimensionInputDialog.tsx
// PURPOSE: Proper styled dialog for setting Column Width / Row Height, replacing
//          the raw window.prompt. Speaks Excel units (column = characters,
//          row = points) and converts to the pixel value the engine stores.
// CONTEXT: Registered with DialogExtensions and opened from the grid context menu
//          (registries/gridExtensions.ts). Movable via useDialogWindow, per the
//          app-wide dialog convention.

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import * as S from "./DimensionInputDialog.styles";

export const DIMENSION_INPUT_DIALOG_ID = "core:dimension-input";

export type DimensionMode = "columnWidth" | "rowHeight";

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

function pxToUnits(mode: DimensionMode, px: number): number {
  return mode === "columnWidth"
    ? round2((px - COL_PAD) / MDW)
    : round2(px * (72 / 96));
}
function unitsToPx(mode: DimensionMode, units: number): number {
  return mode === "columnWidth"
    ? units * MDW + COL_PAD
    : units * (96 / 72);
}

export function DimensionInputDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const d = (data ?? {}) as unknown as Partial<DimensionInputData>;
  const mode: DimensionMode = d.mode ?? "columnWidth";
  const currentPx = d.currentPx ?? 64.29;
  const rangeLabel = d.rangeLabel;
  const onResult = d.onResult;

  const win = useDialogWindow({ minWidth: 320, minHeight: 160, resizable: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<string>(() => String(pxToUnits(mode, currentPx)));

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  }, []);

  const isColumn = mode === "columnWidth";
  const unitWord = isColumn ? "characters" : "points";

  // Parse tolerantly: accept both '.' and ',' (sv-SE) decimal separators.
  const parsed = useMemo(() => {
    const n = parseFloat(value.replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  }, [value]);

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
          <S.Title>{isColumn ? "Column Width" : "Row Height"}</S.Title>
          <S.CloseButton onClick={handleCancel} title="Close (Esc)">✕</S.CloseButton>
        </S.Header>
        <S.Body>
          <S.Field>
            {isColumn ? "Column width" : "Row height"}
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
