//! FILENAME: app/extensions/Sparklines/components/CreateSparklineDialog.tsx
// PURPOSE: Dialog for creating sparklines.
// CONTEXT: Opened via Insert > Sparklines > Line/Column/Win-Loss menu items.
//          User specifies the data range and location range.
//          Location can be a single cell, a single row, or a single column.
//          Validation enforces dimension alignment between data and location ranges.
//          Both inputs support cell selection mode (click-through backdrop).
//          When selecting, the dialog collapses to a compact bar and is draggable.

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useGridState, indexToCol, letterToColumn, ExtensionRegistry } from "../../../src/api";
import type { DialogProps } from "../../../src/api";
import { emitAppEvent, AppEvents, restoreFocusToGrid } from "../../../src/api/events";
import { createSparklineGroup, getGroupById, updateSparklineGroup } from "../store";
import { ensureDesignTabRegistered } from "../handlers/selectionHandler";
import { validateSparklineRanges } from "../types";
import type { SparklineType, CellRange } from "../types";

import {
  DialogContainer,
  Header,
  Title,
  CloseButton,
  Body,
  FieldGroup,
  Label,
  Input,
  TypeSelector,
  TypeButton,
  Footer,
  Button,
  ErrorMessage,
  CollapsedBar,
  CollapsedFields,
  CollapsedFieldRow,
  CollapsedLabel,
  CollapsedInput,
  ExpandButton,
} from "./CreateSparklineDialog.styles";

// ============================================================================
// Range Parsing
// ============================================================================

/** Parse an A1-style reference into a CellRange. Supports single cell or range. */
function parseA1Range(rangeStr: string): CellRange | null {
  let ref = rangeStr;
  const bangIdx = ref.lastIndexOf("!");
  if (bangIdx !== -1) {
    ref = ref.substring(bangIdx + 1);
  }
  ref = ref.replace(/'/g, "").replace(/\$/g, "").trim().toUpperCase();

  // Range format: A1:B10
  const rangeMatch = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (rangeMatch) {
    const startCol = letterToColumn(rangeMatch[1]);
    const startRow = parseInt(rangeMatch[2], 10) - 1;
    const endCol = letterToColumn(rangeMatch[3]);
    const endRow = parseInt(rangeMatch[4], 10) - 1;

    if (startRow < 0 || endRow < 0 || startCol < 0 || endCol < 0) return null;

    return {
      startRow: Math.min(startRow, endRow),
      startCol: Math.min(startCol, endCol),
      endRow: Math.max(startRow, endRow),
      endCol: Math.max(startCol, endCol),
    };
  }

  // Single cell: A1
  const cellMatch = ref.match(/^([A-Z]+)(\d+)$/);
  if (cellMatch) {
    const col = letterToColumn(cellMatch[1]);
    const row = parseInt(cellMatch[2], 10) - 1;
    if (row < 0 || col < 0) return null;
    return { startRow: row, startCol: col, endRow: row, endCol: col };
  }

  return null;
}

function toA1(row: number, col: number): string {
  return `${indexToCol(col)}${row + 1}`;
}

function rangeToA1(range: { startRow: number; startCol: number; endRow: number; endCol: number }): string {
  const minRow = Math.min(range.startRow, range.endRow);
  const minCol = Math.min(range.startCol, range.endCol);
  const maxRow = Math.max(range.startRow, range.endRow);
  const maxCol = Math.max(range.startCol, range.endCol);
  if (minRow === maxRow && minCol === maxCol) {
    return toA1(minRow, minCol);
  }
  return `${toA1(minRow, minCol)}:${toA1(maxRow, maxCol)}`;
}

// ============================================================================
// Which input field is active for cell selection
// ============================================================================

type ActiveField = "dataRange" | "location" | null;

// ============================================================================
// Component
// ============================================================================

export function CreateSparklineDialog({ onClose, data }: DialogProps) {
  const gridState = useGridState();
  const sel = gridState.selection;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Edit mode: when editGroupId is provided, we're editing an existing group
  const editGroupId = data?.editGroupId as number | undefined;
  const existingGroup = editGroupId !== undefined ? getGroupById(editGroupId) : undefined;
  const isEditMode = existingGroup !== undefined;

  const initialType = isEditMode
    ? existingGroup.type
    : (data?.sparklineType as SparklineType) ?? "line";

  const [sparklineType, setSparklineType] = useState<SparklineType>(initialType);
  const [dataRangeText, setDataRangeText] = useState("");
  const [locationText, setLocationText] = useState("");
  const [error, setError] = useState("");
  const [activeField, setActiveField] = useState<ActiveField>(null);

  const dataRangeRef = useRef<HTMLInputElement>(null);
  const locationRef = useRef<HTMLInputElement>(null);
  const collapsedDataRef = useRef<HTMLInputElement>(null);
  const collapsedLocationRef = useRef<HTMLInputElement>(null);

  // Refs for stable callbacks
  const activeFieldRef = useRef<ActiveField>(null);
  activeFieldRef.current = activeField;

  const setDataRangeTextRef = useRef(setDataRangeText);
  setDataRangeTextRef.current = setDataRangeText;

  const setLocationTextRef = useRef(setLocationText);
  setLocationTextRef.current = setLocationText;

  // ============================================================================
  // Drag State (mouse-event based, works in Tauri WebView2)
  // ============================================================================

  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    // Only drag from left mouse button, not from input fields or buttons
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "BUTTON") return;

    isDragging.current = true;

    const el = dialogRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      dragOffset.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }

    e.preventDefault();
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      setPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      });
    };

    const handleMouseUp = () => {
      isDragging.current = false;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Initialize from existing group (edit mode) or current selection (create mode)
  useEffect(() => {
    if (isEditMode && existingGroup) {
      // Pre-populate from the existing sparkline group
      setDataRangeText(rangeToA1(existingGroup.dataRange));
      setLocationText(rangeToA1(existingGroup.location));
      setSparklineType(existingGroup.type);
    } else if (sel) {
      // Default location: the active cell (endRow/endCol)
      setLocationText(toA1(sel.endRow, sel.endCol));

      // If a range is selected, use it as the data range
      if (sel.startRow !== sel.endRow || sel.startCol !== sel.endCol) {
        setDataRangeText(rangeToA1(sel));
      }
    }
  }, []);

  // ============================================================================
  // Selection Tracking (click + drag-select)
  // ============================================================================

  useEffect(() => {
    if (!activeField) return;

    // Listen for selection changes from the grid.
    // This fires on both initial click (single cell) and drag extension (range).
    // By NOT using a click interceptor, we allow the core's native selection
    // behavior to proceed, enabling drag-to-select ranges.
    const unregSelection = ExtensionRegistry.onSelectionChange((newSel) => {
      const field = activeFieldRef.current;
      if (!field || !newSel) return;

      const ref = rangeToA1(newSel);

      if (field === "location") {
        setLocationTextRef.current(ref);
      } else if (field === "dataRange") {
        setDataRangeTextRef.current(ref);
      }
    });

    return () => {
      unregSelection();
    };
  }, [activeField]);

  // Keep focus on the active input when clicking the grid
  useEffect(() => {
    if (!activeField) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (dialogRef.current?.contains(target)) return;

      setTimeout(() => {
        if (activeFieldRef.current === "location") {
          (locationRef.current ?? collapsedLocationRef.current)?.focus();
        } else if (activeFieldRef.current === "dataRange") {
          (dataRangeRef.current ?? collapsedDataRef.current)?.focus();
        }
      }, 50);
    };

    window.addEventListener("mousedown", handleMouseDown, true);
    return () => window.removeEventListener("mousedown", handleMouseDown, true);
  }, [activeField]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const activateField = useCallback((field: ActiveField) => {
    setActiveField(field);
  }, []);

  const handleExpand = useCallback(() => {
    setActiveField(null);
  }, []);

  const handleInputBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    if (relatedTarget && dialogRef.current?.contains(relatedTarget)) {
      if (relatedTarget === dataRangeRef.current) {
        setActiveField("dataRange");
      } else if (relatedTarget === locationRef.current) {
        setActiveField("location");
      } else {
        setActiveField(null);
      }
    }
  }, []);

  const handleOk = useCallback(() => {
    setError("");
    setActiveField(null);

    // Parse data range
    const dataRange = parseA1Range(dataRangeText);
    if (!dataRange) {
      setError("Invalid data range. Use A1:A10 format.");
      return;
    }

    // Parse location range (can be single cell or 1D range)
    const location = parseA1Range(locationText);
    if (!location) {
      setError("Invalid location range. Use a cell (F1) or range (F1:F5).");
      return;
    }

    if (isEditMode && editGroupId !== undefined) {
      // Edit mode: update the existing group's ranges and type
      const validation = validateSparklineRanges(location, dataRange);
      if (!validation.valid) {
        setError(validation.error ?? "Invalid range combination.");
        return;
      }
      updateSparklineGroup(editGroupId, {
        location,
        dataRange,
        type: sparklineType,
      });
    } else {
      // Create mode: create a new sparkline group (includes validation)
      const result = createSparklineGroup(location, dataRange, sparklineType);
      if (!result.valid) {
        setError(result.error ?? "Invalid range combination.");
        return;
      }
    }

    // Show the Sparkline ribbon tab immediately (don't wait for selection change)
    ensureDesignTabRegistered();

    // Refresh the grid
    emitAppEvent(AppEvents.GRID_REFRESH);
    restoreFocusToGrid();
    onClose();
  }, [dataRangeText, locationText, sparklineType, onClose, isEditMode, editGroupId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (activeField) {
          // In collapsed mode, Enter expands back to full dialog
          setActiveField(null);
        } else {
          handleOk();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (activeField) {
          setActiveField(null);
        } else {
          onClose();
        }
      }
    },
    [handleOk, onClose, activeField],
  );

  const typeLabel =
    sparklineType === "winloss"
      ? "Win/Loss"
      : sparklineType.charAt(0).toUpperCase() + sparklineType.slice(1);

  const isSelecting = activeField !== null;

  // Position style: absolute positioning if dragged, otherwise centered
  const positionStyle: React.CSSProperties = position
    ? { position: "fixed", left: position.x, top: position.y }
    : {};

  // ============================================================================
  // Collapsed Bar (shown during range selection)
  // ============================================================================

  if (isSelecting) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1050,
          background: "transparent",
          pointerEvents: "none",
        }}
      >
        <CollapsedBar
          ref={dialogRef}
          onKeyDown={handleKeyDown}
          style={{
            pointerEvents: "auto",
            position: "fixed",
            ...(position
              ? { left: position.x, top: position.y }
              : { left: "50%", top: 60, transform: "translateX(-50%)" }
            ),
          }}
        >
          <CollapsedFields>
            <CollapsedFieldRow
              $active={activeField === "dataRange"}
              onMouseDown={(e) => {
                if (activeField === "dataRange") {
                  handleDragStart(e);
                } else {
                  setActiveField("dataRange");
                  setTimeout(() => collapsedDataRef.current?.focus(), 0);
                }
              }}
            >
              <CollapsedLabel>Data Range:</CollapsedLabel>
              <CollapsedInput
                ref={collapsedDataRef}
                type="text"
                value={dataRangeText}
                onChange={(e) => setDataRangeText(e.target.value)}
                onFocus={() => setActiveField("dataRange")}
                autoFocus={activeField === "dataRange"}
              />
            </CollapsedFieldRow>

            <CollapsedFieldRow
              $active={activeField === "location"}
              onMouseDown={(e) => {
                if (activeField === "location") {
                  handleDragStart(e);
                } else {
                  setActiveField("location");
                  setTimeout(() => collapsedLocationRef.current?.focus(), 0);
                }
              }}
            >
              <CollapsedLabel>Location:</CollapsedLabel>
              <CollapsedInput
                ref={collapsedLocationRef}
                type="text"
                value={locationText}
                onChange={(e) => setLocationText(e.target.value)}
                onFocus={() => setActiveField("location")}
                autoFocus={activeField === "location"}
              />
            </CollapsedFieldRow>
          </CollapsedFields>

          <ExpandButton
            onClick={handleExpand}
            title="Expand dialog"
          >
            &#9660;
          </ExpandButton>
        </CollapsedBar>
      </div>
    );
  }

  // ============================================================================
  // Full Dialog (shown when not selecting)
  // ============================================================================

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1050,
        background: "rgba(0, 0, 0, 0.45)",
        display: position ? "block" : "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background 0.15s ease",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <DialogContainer
        ref={dialogRef}
        onKeyDown={handleKeyDown}
        style={{ pointerEvents: "auto", ...positionStyle }}
      >
        <Header onMouseDown={handleDragStart}>
          <Title>{isEditMode ? "Edit" : "Create"} Sparklines ({typeLabel})</Title>
          <CloseButton onClick={() => { setActiveField(null); onClose(); }}>X</CloseButton>
        </Header>

        <Body>
          <FieldGroup>
            <Label>Type</Label>
            <TypeSelector>
              <TypeButton
                $active={sparklineType === "line"}
                onClick={() => setSparklineType("line")}
              >
                Line
              </TypeButton>
              <TypeButton
                $active={sparklineType === "column"}
                onClick={() => setSparklineType("column")}
              >
                Column
              </TypeButton>
              <TypeButton
                $active={sparklineType === "winloss"}
                onClick={() => setSparklineType("winloss")}
              >
                Win/Loss
              </TypeButton>
            </TypeSelector>
          </FieldGroup>

          <FieldGroup>
            <Label>Data Range</Label>
            <Input
              ref={dataRangeRef}
              type="text"
              value={dataRangeText}
              onChange={(e) => setDataRangeText(e.target.value)}
              onFocus={() => activateField("dataRange")}
              onBlur={handleInputBlur}
              placeholder="e.g. A1:A10 or A1:E5"
            />
          </FieldGroup>

          <FieldGroup>
            <Label>Location Range</Label>
            <Input
              ref={locationRef}
              type="text"
              value={locationText}
              onChange={(e) => setLocationText(e.target.value)}
              onFocus={() => activateField("location")}
              onBlur={handleInputBlur}
              placeholder="e.g. F1 or F1:F5"
            />
          </FieldGroup>

          {error && <ErrorMessage>{error}</ErrorMessage>}
        </Body>

        <Footer>
          <Button onClick={() => { setActiveField(null); onClose(); }}>Cancel</Button>
          <Button $primary onClick={handleOk}>OK</Button>
        </Footer>
      </DialogContainer>
    </div>
  );
}
