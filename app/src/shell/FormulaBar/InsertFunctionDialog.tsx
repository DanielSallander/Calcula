//! FILENAME: app/src/shell/FormulaBar/InsertFunctionDialog.tsx
// PURPOSE: Dialog for searching and inserting functions into formulas
// CONTEXT: Opened by clicking the fx button in the formula bar
//
// TWO STEPS, LIKE EXCEL. Step 1 is the searchable catalog. Step 2 appears only
// for a function that an extension has registered an argument builder for
// (@api/functionBuilders) — Excel's "Function Arguments" dialog, except the
// panel is supplied by whichever extension owns the domain the arguments come
// from, because the shell may not import an extension and knows nothing about
// BI models, pivots or anything else a function might read.
//
// Every other function keeps the original behaviour: a template goes into the
// formula-bar editor and the user completes it against the grid.

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useDialogWindow } from "../../api/dialogWindow";
import {
  findFunctionBuilder,
  subscribeToFunctionBuilders,
  type FunctionBuilderRegistration,
} from "../../api/functionBuilders";
import { getAllFunctions, getFunctionTemplate } from "../../core/lib/tauri-api";
import type { FunctionInfo } from "../../core/types";
import * as S from './InsertFunctionDialog.styles';

interface InsertFunctionDialogProps {
  /** A plain function: insert its template into the editor and let the user finish. */
  onSelect: (functionName: string, template: string) => void;
  /** A builder produced a complete formula: the host commits it to the cell. */
  onBuilt: (formula: string) => void;
  /** The cell the formula will land in, handed to a builder as context. */
  anchor: { row: number; col: number };
  onClose: () => void;
}

/**
 * Display names for catalog categories that read better under another name.
 *
 * DELIBERATELY SPARSE. The category list itself is DERIVED from the catalog the
 * backend ships, never enumerated here: the hard-coded list this replaced held
 * eight entries against the catalog's fifteen, so Cube, Engineering, Dynamic
 * Array, Information, Database, Writeback, UI and Matrix had no button at all —
 * and two of the eight it did list ("Date & Time", "Lookup & Reference") were
 * DEAD, because the id they compared against was written `date_time` while the
 * normalizer turned the catalog's `Date & Time` into `date___time`. Matching a
 * derived label against the string it was derived from cannot drift that way.
 */
const CATEGORY_LABELS = new Map<string, string>([
  ["Math", "Math & Trig"],
  ["UI", "Interface"],
]);

function categoryLabel(category: string): string {
  return CATEGORY_LABELS.get(category) ?? category;
}

export function InsertFunctionDialog({
  onSelect,
  onBuilt,
  anchor,
  onClose,
}: InsertFunctionDialogProps): React.ReactElement {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [functions, setFunctions] = useState<FunctionInfo[]>([]);
  const [selectedFunction, setSelectedFunction] = useState<FunctionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Step 2: the function whose arguments are being assembled, and the formula
  // the builder has assembled so far (null = not insertable yet).
  const [builderFor, setBuilderFor] = useState<
    { fn: FunctionInfo; registration: FunctionBuilderRegistration } | null
  >(null);
  const [builtFormula, setBuiltFormula] = useState<string | null>(null);

  // Extensions activate after the shell mounts, so the registry is re-read on
  // every change rather than once — otherwise opening fx early in a session
  // would hide a builder for the rest of it.
  const [buildersVersion, setBuildersVersion] = useState(0);
  useEffect(() => subscribeToFunctionBuilders(() => setBuildersVersion((v) => v + 1)), []);

  // Movable + resizable dialog window (shared hook).
  // win.ref doubles as the click-outside detection ref.
  const win = useDialogWindow({ minWidth: 380, minHeight: 380 });
  const dialogRef = win.ref;

  useEffect(() => {
    getAllFunctions()
      .then((result) => {
        setFunctions(result.functions);
        setIsLoading(false);
      })
      .catch((error) => {
        console.error("Failed to load functions:", error);
        setIsLoading(false);
      });
  }, []);

  // The category buttons ARE the catalog's categories: whatever the backend
  // ships gets a button, in alphabetical order, with "All" first.
  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const fn of functions) {
      if (fn.category) seen.add(fn.category);
    }
    const sorted = [...seen].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
    // null IS "no filter": a real absence, not a reserved string that some
    // future catalog category could collide with.
    const rows: { id: string | null; label: string }[] = [{ id: null, label: "All" }];
    for (const c of sorted) rows.push({ id: c, label: categoryLabel(c) });
    return rows;
  }, [functions]);

  // Derive filtered functions during render (not in an effect)
  const filteredFunctions = useMemo(() => {
    let filtered = functions;

    if (selectedCategory !== null) {
      filtered = filtered.filter((fn) => fn.category === selectedCategory);
    }

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (fn) =>
          fn.name.toLowerCase().includes(term) ||
          fn.description.toLowerCase().includes(term)
      );
    }

    return filtered;
  }, [searchTerm, selectedCategory, functions]);

  // Auto-select first function when filtered list changes (render-time derived state)
  const [prevFiltered, setPrevFiltered] = useState(filteredFunctions);
  if (filteredFunctions !== prevFiltered) {
    setPrevFiltered(filteredFunctions);
    if (filteredFunctions.length > 0 && (!selectedFunction || !filteredFunctions.includes(selectedFunction))) {
      setSelectedFunction(filteredFunctions[0]);
    } else if (filteredFunctions.length === 0) {
      setSelectedFunction(null);
    }
  }

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    // Step 2 is real work in a form: an accidental click on the grid behind it
    // must not throw the arguments away. Step 1 keeps the light-dismiss it has
    // always had, where the cost of a mis-click is one re-open.
    if (builderFor) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose, builderFor, dialogRef]);

  const handleInsert = useCallback(async () => {
    if (!selectedFunction) return;

    // A registered builder takes over: the user is sent to step 2 instead of
    // being handed a template they would have to spell the arguments into.
    const registration = findFunctionBuilder(selectedFunction.name);
    if (registration) {
      setBuiltFormula(null);
      setBuilderFor({ fn: selectedFunction, registration });
      return;
    }

    try {
      const template = await getFunctionTemplate(selectedFunction.name);
      onSelect(selectedFunction.name, template);
    } catch (error) {
      console.error("Failed to get function template:", error);
      onSelect(selectedFunction.name, `=${selectedFunction.name}(`);
    }
  }, [selectedFunction, onSelect]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && selectedFunction) {
        e.preventDefault();
        handleInsert();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const currentIndex = selectedFunction
          ? filteredFunctions.indexOf(selectedFunction)
          : -1;
        const nextIndex = Math.min(currentIndex + 1, filteredFunctions.length - 1);
        setSelectedFunction(filteredFunctions[nextIndex]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const currentIndex = selectedFunction
          ? filteredFunctions.indexOf(selectedFunction)
          : filteredFunctions.length;
        const prevIndex = Math.max(currentIndex - 1, 0);
        setSelectedFunction(filteredFunctions[prevIndex]);
      }
    },
    [selectedFunction, filteredFunctions, onClose, handleInsert]
  );

  // Computed BEFORE the step-2 early return below, because it is a hook.
  // `buildersVersion` is the dependency that matters: findFunctionBuilder reads
  // live module state, so the memo has to be invalidated by the subscription
  // rather than by anything in its own body.
  const selectedHasBuilder = useMemo(
    () => selectedFunction !== null && findFunctionBuilder(selectedFunction.name) !== null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedFunction, buildersVersion],
  );

  const handleBuilderBack = useCallback(() => {
    setBuilderFor(null);
    setBuiltFormula(null);
  }, []);

  const handleBuilderInsert = useCallback(() => {
    // Re-checked here rather than trusted from the builder's own submit: a
    // builder may call onSubmit on an Enter keypress before its last change has
    // been reported, and an incomplete formula must be a no-op, not a bad cell.
    if (!builtFormula) return;
    onBuilt(builtFormula);
  }, [builtFormula, onBuilt]);

  const handleBuilderKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Only Escape. The list's Enter/Arrow handling would fight the form
      // controls a builder is made of, and Insert has a button of its own.
      if (e.key === "Escape") {
        e.preventDefault();
        handleBuilderBack();
      }
    },
    [handleBuilderBack],
  );

  if (builderFor) {
    const Builder = builderFor.registration.component;
    return (
      <S.Overlay>
        <S.DialogContainer
          ref={dialogRef}
          $wide
          onKeyDown={handleBuilderKeyDown}
          style={{ position: "relative", ...win.style }}
          data-testid="function-builder"
        >
          <S.Header onMouseDown={win.onHeaderMouseDown}>
            <S.Title>{builderFor.fn.name} — Function Arguments</S.Title>
            <S.CloseButton onClick={onClose}>x</S.CloseButton>
          </S.Header>

          <S.BuilderBody>
            <Builder
              context={{
                functionName: builderFor.fn.name,
                row: anchor.row,
                col: anchor.col,
              }}
              onFormulaChange={setBuiltFormula}
              onSubmit={handleBuilderInsert}
            />
          </S.BuilderBody>

          <S.BuilderPreview data-testid="function-builder-preview">
            {builtFormula || "—"}
          </S.BuilderPreview>

          <S.Footer>
            <S.CancelButton onClick={handleBuilderBack}>Back</S.CancelButton>
            <S.FooterSpacer />
            <S.CancelButton onClick={onClose}>Cancel</S.CancelButton>
            <S.InsertButton onClick={handleBuilderInsert} disabled={!builtFormula}>
              Insert
            </S.InsertButton>
          </S.Footer>
          {win.resizeHandles}
        </S.DialogContainer>
      </S.Overlay>
    );
  }

  return (
    <S.Overlay>
      <S.DialogContainer
        ref={dialogRef}
        onKeyDown={handleKeyDown}
        style={{ position: "relative", ...win.style }}
      >
        <S.Header onMouseDown={win.onHeaderMouseDown}>
          <S.Title>Insert Function</S.Title>
          <S.CloseButton onClick={onClose}>x</S.CloseButton>
        </S.Header>

        <S.SearchContainer>
          <S.SearchInput
            ref={searchInputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search for a function..."
          />
        </S.SearchContainer>

        <S.CategoryContainer>
          {categories.map((cat) => (
            <S.CategoryButton
              key={cat.id ?? "all"}
              onClick={() => setSelectedCategory(cat.id)}
              isActive={selectedCategory === cat.id}
            >
              {cat.label}
            </S.CategoryButton>
          ))}
        </S.CategoryContainer>

        <S.FunctionListContainer>
          {isLoading ? (
            <S.LoadingMessage>Loading functions...</S.LoadingMessage>
          ) : filteredFunctions.length === 0 ? (
            <S.EmptyMessage>No functions found</S.EmptyMessage>
          ) : (
            filteredFunctions.map((fn) => (
              <S.FunctionItem
                key={fn.name}
                onClick={() => setSelectedFunction(fn)}
                onDoubleClick={handleInsert}
                isSelected={selectedFunction?.name === fn.name}
              >
                <S.FunctionName>{fn.name}</S.FunctionName>
                <S.FunctionDescription>{fn.description}</S.FunctionDescription>
              </S.FunctionItem>
            ))
          )}
        </S.FunctionListContainer>

        {selectedFunction && (
          <S.FunctionDetails>
            <S.FunctionSignature>
              {selectedFunction.name}({selectedFunction.syntax})
            </S.FunctionSignature>
            <S.FunctionFullDescription>
              {selectedFunction.description}
            </S.FunctionFullDescription>
            {selectedHasBuilder && (
              <S.BuilderBadge>Insert opens a guided builder</S.BuilderBadge>
            )}
          </S.FunctionDetails>
        )}

        <S.Footer>
          <S.CancelButton onClick={onClose}>Cancel</S.CancelButton>
          <S.InsertButton onClick={handleInsert} disabled={!selectedFunction}>
            Insert
          </S.InsertButton>
        </S.Footer>
        {win.resizeHandles}
      </S.DialogContainer>
    </S.Overlay>
  );
}
