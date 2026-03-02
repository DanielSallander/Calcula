//! FILENAME: app/extensions/ScriptEditor/components/ScriptEditorPane.tsx
// PURPOSE: Task pane component for writing and running scripts.
// CONTEXT: Provides a textarea for code input, Run button, and console output display.

import React, { useState, useCallback, useRef, useEffect } from "react";
import type { TaskPaneViewProps } from "../../../src/api";
import { runScript } from "../lib/scriptApi";
import { openAdvancedEditor } from "../lib/openEditorWindow";
import type { RunScriptResponse } from "../types";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "#FAFAFA",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "6px 10px",
  borderBottom: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
  flexShrink: 0,
};

const editorContainerStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  resize: "none",
  border: "none",
  borderBottom: "1px solid #E0E0E0",
  padding: "8px 10px",
  fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 13,
  lineHeight: "1.5",
  outline: "none",
  backgroundColor: "#FFFFFF",
  color: "#1E1E1E",
  tabSize: 2,
};

const consoleContainerStyle: React.CSSProperties = {
  height: 160,
  minHeight: 80,
  display: "flex",
  flexDirection: "column",
  borderTop: "1px solid #E0E0E0",
  flexShrink: 0,
};

const consoleHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 10px",
  backgroundColor: "#F5F5F5",
  borderBottom: "1px solid #E8E8E8",
  fontSize: 11,
  color: "#666",
  flexShrink: 0,
};

const consoleOutputStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "6px 10px",
  fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 12,
  lineHeight: "1.4",
  backgroundColor: "#1E1E1E",
  color: "#D4D4D4",
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
  border: "1px solid #0078D4",
  borderRadius: 2,
  backgroundColor: "#0078D4",
  color: "#FFF",
};

const buttonDisabledStyle: React.CSSProperties = {
  ...buttonStyle,
  opacity: 0.6,
  cursor: "not-allowed",
};

const clearButtonStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
  border: "1px solid #CCC",
  borderRadius: 2,
  backgroundColor: "transparent",
  color: "#666",
};

const advancedEditorButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  cursor: "pointer",
  border: "1px solid #0078D4",
  borderRadius: 2,
  backgroundColor: "transparent",
  color: "#0078D4",
};

// ============================================================================
// Default Script Template
// ============================================================================

const DEFAULT_SCRIPT = `// Welcome to Calcula Script Editor
// Use the Calcula API to read/write spreadsheet data.

// Read a cell value (row, col are 0-based)
const value = Calcula.getCellValue(0, 0);
Calcula.log("Cell A1 =", value);

// Write a value
// Calcula.setCellValue(0, 1, "Hello from script!");
`;

// ============================================================================
// Console Line Component
// ============================================================================

interface ConsoleLineProps {
  text: string;
  type: "output" | "error" | "info";
}

function ConsoleLine({ text, type }: ConsoleLineProps): React.ReactElement {
  const color =
    type === "error" ? "#F48771" : type === "info" ? "#569CD6" : "#D4D4D4";

  return React.createElement(
    "div",
    { style: { color, whiteSpace: "pre-wrap", wordBreak: "break-all" } },
    text,
  );
}

// ============================================================================
// Component
// ============================================================================

interface ConsoleEntry {
  text: string;
  type: "output" | "error" | "info";
}

export function ScriptEditorPane(
  _props: TaskPaneViewProps,
): React.ReactElement {
  const [source, setSource] = useState(DEFAULT_SCRIPT);
  const [isRunning, setIsRunning] = useState(false);
  const [consoleLines, setConsoleLines] = useState<ConsoleEntry[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll console to bottom on new output
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleLines]);

  const handleRun = useCallback(async () => {
    if (isRunning || !source.trim()) return;

    setIsRunning(true);
    setConsoleLines((prev) => [
      ...prev,
      { text: "--- Running script ---", type: "info" },
    ]);

    try {
      const result: RunScriptResponse = await runScript(source);

      if (result.type === "success") {
        // Add console output lines
        const newLines: ConsoleEntry[] = result.output.map((line) => ({
          text: line,
          type: "output" as const,
        }));

        // Add summary
        newLines.push({
          text: `--- Done (${result.durationMs}ms, ${result.cellsModified} cell(s) modified) ---`,
          type: "info",
        });

        setConsoleLines((prev) => [...prev, ...newLines]);

        // If cells were modified, trigger a grid data re-fetch.
        // Note: "grid:refresh" re-fetches data from backend;
        // AppEvents.GRID_REFRESH only repaints the existing cache.
        if (result.cellsModified > 0) {
          window.dispatchEvent(new CustomEvent("grid:refresh"));
        }
      } else {
        // Error result
        const newLines: ConsoleEntry[] = result.output.map((line) => ({
          text: line,
          type: "output" as const,
        }));
        newLines.push({
          text: `Error: ${result.message}`,
          type: "error",
        });
        setConsoleLines((prev) => [...prev, ...newLines]);
      }
    } catch (err) {
      setConsoleLines((prev) => [
        ...prev,
        {
          text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
          type: "error",
        },
      ]);
    } finally {
      setIsRunning(false);
    }
  }, [source, isRunning]);

  const handleClearConsole = useCallback(() => {
    setConsoleLines([]);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Stop propagation so the spreadsheet container doesn't intercept
      // Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+Z, arrow keys, etc.
      e.stopPropagation();

      // Ctrl+Enter to run
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        handleRun();
        return;
      }

      // Tab inserts 2 spaces
      if (e.key === "Tab") {
        e.preventDefault();
        const target = e.currentTarget;
        const start = target.selectionStart;
        const end = target.selectionEnd;
        const value = target.value;
        const newValue = value.substring(0, start) + "  " + value.substring(end);
        setSource(newValue);
        // Restore cursor position after React re-render
        requestAnimationFrame(() => {
          target.selectionStart = target.selectionEnd = start + 2;
        });
      }
    },
    [handleRun],
  );

  // ---- Render ----

  return React.createElement(
    "div",
    { style: containerStyle },

    // Header with Run button
    React.createElement(
      "div",
      { style: headerStyle },
      React.createElement(
        "span",
        { style: { fontWeight: 600, fontSize: 13 } },
        "Script Editor",
      ),
      React.createElement(
        "div",
        { style: { display: "flex", gap: 6, alignItems: "center" } },
        React.createElement(
          "button",
          {
            style: advancedEditorButtonStyle,
            onClick: () => openAdvancedEditor(source),
            title: "Open in Advanced Editor with IntelliSense",
          },
          "Advanced Editor",
        ),
        React.createElement(
          "span",
          {
            style: { fontSize: 11, color: "#888" },
          },
          "Ctrl+Enter to run",
        ),
        React.createElement(
          "button",
          {
            style: isRunning ? buttonDisabledStyle : buttonStyle,
            onClick: handleRun,
            disabled: isRunning,
            title: "Run script (Ctrl+Enter)",
          },
          isRunning ? "Running..." : "Run",
        ),
      ),
    ),

    // Editor area
    React.createElement(
      "div",
      { style: editorContainerStyle },
      React.createElement("textarea", {
        ref: textareaRef,
        style: textareaStyle,
        value: source,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
          setSource(e.target.value),
        onKeyDown: handleKeyDown,
        placeholder: "Write your script here...",
        spellCheck: false,
      }),
    ),

    // Console output area
    React.createElement(
      "div",
      { style: consoleContainerStyle },
      React.createElement(
        "div",
        { style: consoleHeaderStyle },
        React.createElement("span", null, "Console Output"),
        React.createElement(
          "button",
          {
            style: clearButtonStyle,
            onClick: handleClearConsole,
            title: "Clear console",
          },
          "Clear",
        ),
      ),
      React.createElement(
        "div",
        { style: consoleOutputStyle },
        consoleLines.map((entry, i) =>
          React.createElement(ConsoleLine, {
            key: i,
            text: entry.text,
            type: entry.type,
          }),
        ),
        React.createElement("div", { ref: consoleEndRef }),
      ),
    ),
  );
}
