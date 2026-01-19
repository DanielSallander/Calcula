// FILENAME: shell/FormulaBar/InsertFunctionDialog.tsx
// PURPOSE: Dialog for searching and inserting functions into formulas
// CONTEXT: Opened by clicking the fx button in the formula bar

import React, { useState, useEffect, useCallback, useRef } from "react";
import { getAllFunctions, getFunctionTemplate } from "../../core/lib/tauri-api";
import type { FunctionInfo } from "../../core/types";

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
  const [filteredFunctions, setFilteredFunctions] = useState<FunctionInfo[]>([]);
  const [selectedFunction, setSelectedFunction] = useState<FunctionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Load all functions on mount
  useEffect(() => {
    setIsLoading(true);
    getAllFunctions()
      .then((result) => {
        setFunctions(result.functions);
        setFilteredFunctions(result.functions);
        setIsLoading(false);
      })
      .catch((error) => {
        console.error("Failed to load functions:", error);
        setIsLoading(false);
      });
  }, []);

  // Filter functions when search term or category changes
  useEffect(() => {
    let filtered = functions;

    // Filter by category
    if (selectedCategory !== "all") {
      filtered = filtered.filter(
        (fn) => fn.category.toLowerCase().replace(/[& ]/g, "_") === selectedCategory ||
                fn.category.toLowerCase() === selectedCategory
      );
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (fn) =>
          fn.name.toLowerCase().includes(term) ||
          fn.description.toLowerCase().includes(term)
      );
    }

    setFilteredFunctions(filtered);
    
    // Select first function if current selection is not in filtered list
    if (filtered.length > 0 && (!selectedFunction || !filtered.includes(selectedFunction))) {
      setSelectedFunction(filtered[0]);
    } else if (filtered.length === 0) {
      setSelectedFunction(null);
    }
  }, [searchTerm, selectedCategory, functions, selectedFunction]);

  // Focus search input on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Handle click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Handle keyboard navigation
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
    [selectedFunction, filteredFunctions, onClose]
  );

  const handleInsert = useCallback(async () => {
    if (!selectedFunction) return;
    
    try {
      const template = await getFunctionTemplate(selectedFunction.name);
      onSelect(selectedFunction.name, template);
    } catch (error) {
      console.error("Failed to get function template:", error);
      // Fallback to basic template
      onSelect(selectedFunction.name, `=${selectedFunction.name}(`);
    }
  }, [selectedFunction, onSelect]);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        ref={dialogRef}
        onKeyDown={handleKeyDown}
        style={{
          backgroundColor: "#ffffff",
          borderRadius: "4px",
          boxShadow: "0 4px 20px rgba(0, 0, 0, 0.2)",
          width: "500px",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px",
            borderBottom: "1px solid #e0e0e0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
            Insert Function
          </h2>
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: "18px",
              color: "#666",
              padding: "4px",
            }}
          >
            x
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #e0e0e0" }}>
          <input
            ref={searchInputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search for a function..."
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "1px solid #d0d0d0",
              borderRadius: "4px",
              fontSize: "13px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Category selector */}
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid #e0e0e0",
            display: "flex",
            flexWrap: "wrap",
            gap: "4px",
          }}
        >
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              style={{
                padding: "4px 8px",
                fontSize: "11px",
                border: "1px solid #d0d0d0",
                borderRadius: "3px",
                backgroundColor:
                  selectedCategory === cat.id ? "#0078d4" : "#ffffff",
                color: selectedCategory === cat.id ? "#ffffff" : "#333333",
                cursor: "pointer",
              }}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Function list */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            minHeight: "200px",
            maxHeight: "300px",
          }}
        >
          {isLoading ? (
            <div style={{ padding: "20px", textAlign: "center", color: "#666" }}>
              Loading functions...
            </div>
          ) : filteredFunctions.length === 0 ? (
            <div style={{ padding: "20px", textAlign: "center", color: "#666" }}>
              No functions found
            </div>
          ) : (
            filteredFunctions.map((fn) => (
              <div
                key={fn.name}
                onClick={() => setSelectedFunction(fn)}
                onDoubleClick={handleInsert}
                style={{
                  padding: "8px 16px",
                  cursor: "pointer",
                  backgroundColor:
                    selectedFunction?.name === fn.name ? "#e8f4fc" : "transparent",
                  borderLeft:
                    selectedFunction?.name === fn.name
                      ? "3px solid #0078d4"
                      : "3px solid transparent",
                }}
              >
                <div style={{ fontWeight: 500, fontSize: "13px" }}>{fn.name}</div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "#666",
                    marginTop: "2px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {fn.description}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Function details */}
        {selectedFunction && (
          <div
            style={{
              padding: "12px 16px",
              borderTop: "1px solid #e0e0e0",
              backgroundColor: "#f9f9f9",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "4px" }}>
              {selectedFunction.name}({selectedFunction.syntax})
            </div>
            <div style={{ fontSize: "12px", color: "#444" }}>
              {selectedFunction.description}
            </div>
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid #e0e0e0",
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "6px 16px",
              border: "1px solid #d0d0d0",
              borderRadius: "4px",
              backgroundColor: "#ffffff",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleInsert}
            disabled={!selectedFunction}
            style={{
              padding: "6px 16px",
              border: "none",
              borderRadius: "4px",
              backgroundColor: selectedFunction ? "#0078d4" : "#cccccc",
              color: "#ffffff",
              cursor: selectedFunction ? "pointer" : "default",
              fontSize: "13px",
            }}
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}