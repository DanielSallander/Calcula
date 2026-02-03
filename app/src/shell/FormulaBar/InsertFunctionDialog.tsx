//! FILENAME: app/src/shell/FormulaBar/InsertFunctionDialog.tsx
// PURPOSE: Dialog for searching and inserting functions into formulas
// CONTEXT: Opened by clicking the fx button in the formula bar

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getAllFunctions, getFunctionTemplate } from "../../core/lib/tauri-api";
import type { FunctionInfo } from "../../core/types";
import * as S from './InsertFunctionDialog.styles';

interface InsertFunctionDialogProps {
  onSelect: (functionName: string, template: string) => void;
  onClose: () => void;
}

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "math", label: "Math & Trig" },
  { id: "statistical", label: "Statistical" },
  { id: "text", label: "Text" },
  { id: "logical", label: "Logical" },
  { id: "date_time", label: "Date & Time" },
  { id: "lookup", label: "Lookup & Reference" },
  { id: "financial", label: "Financial" },
];

export function InsertFunctionDialog({
  onSelect,
  onClose,
}: InsertFunctionDialogProps): React.ReactElement {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [functions, setFunctions] = useState<FunctionInfo[]>([]);
  const [selectedFunction, setSelectedFunction] = useState<FunctionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

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

  // Derive filtered functions during render (not in an effect)
  const filteredFunctions = useMemo(() => {
    let filtered = functions;

    if (selectedCategory !== "all") {
      filtered = filtered.filter(
        (fn) => fn.category.toLowerCase().replace(/[& ]/g, "_") === selectedCategory ||
                fn.category.toLowerCase() === selectedCategory
      );
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
    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  const handleInsert = useCallback(async () => {
    if (!selectedFunction) return;

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

  return (
    <S.Overlay>
      <S.DialogContainer ref={dialogRef} onKeyDown={handleKeyDown}>
        <S.Header>
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
          {CATEGORIES.map((cat) => (
            <S.CategoryButton
              key={cat.id}
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
          </S.FunctionDetails>
        )}

        <S.Footer>
          <S.CancelButton onClick={onClose}>Cancel</S.CancelButton>
          <S.InsertButton onClick={handleInsert} disabled={!selectedFunction}>
            Insert
          </S.InsertButton>
        </S.Footer>
      </S.DialogContainer>
    </S.Overlay>
  );
}