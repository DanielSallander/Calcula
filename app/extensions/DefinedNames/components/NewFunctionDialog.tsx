//! FILENAME: app/extensions/DefinedNames/components/NewFunctionDialog.tsx
// PURPOSE: Dialog for creating or editing custom functions (LAMBDA-based named ranges).
// CONTEXT: Opened from Name Manager "New Function..." button or Formulas menu.

import React, { useState, useEffect, useCallback, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  createNamedRange,
  updateNamedRange,
  getSheets,
  AppEvents,
  emitAppEvent,
} from "../../../src/api";
import { isValidName } from "../lib/nameUtils";
import {
  FUNCTION_FOLDER_NAME,
  buildLambdaRefersTo,
  parseLambdaRefersTo,
} from "../lib/lambdaUtils";
import {
  registerFormulaLanguage,
  setFormulaEditorParams,
  LANGUAGE_ID,
} from "./MonacoFormulaSetup";

const v = (name: string) => `var(${name})`;

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1060,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 560,
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${v("--border-default")}`,
  },
  title: {
    fontWeight: 600,
    fontSize: 15,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  },
  body: {
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
  },
  field: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: v("--text-secondary"),
  },
  input: {
    padding: "6px 8px",
    fontSize: 13,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  select: {
    padding: "6px 8px",
    fontSize: 13,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  textarea: {
    padding: "6px 8px",
    fontSize: 13,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    resize: "vertical" as const,
    minHeight: 40,
  },
  error: {
    color: "#e74c3c",
    fontSize: 11,
    marginTop: 2,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  btn: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 70,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 70,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  btnDisabled: {
    opacity: 0.45,
    cursor: "not-allowed" as const,
  },
  // Parameter list styles
  paramRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  paramInput: {
    flex: 1,
    padding: "4px 8px",
    fontSize: 13,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
  paramBtn: {
    background: "transparent",
    border: "none",
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "2px 6px",
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  },
  addParamBtn: {
    alignSelf: "flex-start" as const,
    padding: "4px 10px",
    fontSize: 12,
    borderRadius: 4,
    cursor: "pointer",
    background: "transparent",
    color: v("--accent-primary"),
    border: `1px solid ${v("--accent-primary")}`,
  },
  editorContainer: {
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    overflow: "hidden",
    height: 200,
  },
};

// ============================================================================
// Parameter validation
// ============================================================================

function isValidParamName(name: string): boolean {
  if (!name || name.length === 0) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name);
}

// ============================================================================
// Component
// ============================================================================

export function NewFunctionDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const mode = (data?.mode as string) ?? "new";
  const editName = data?.editName as string | undefined;
  const editRefersTo = data?.editRefersTo as string | undefined;
  const editSheetIndex = data?.editSheetIndex as number | null | undefined;
  const editComment = data?.editComment as string | undefined;

  const [name, setName] = useState("");
  const [params, setParams] = useState<string[]>([""]);
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");
  const [scopeIndex, setScopeIndex] = useState<number | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize on open
  useEffect(() => {
    if (!isOpen) return;

    // Register Monaco language on first open
    registerFormulaLanguage();

    // Load sheet names
    getSheets().then((result) => {
      setSheetNames(result.sheets.map((s) => s.name));
    });

    // Populate fields
    if (mode === "edit" && editName && editRefersTo) {
      setName(editName);
      setScopeIndex(editSheetIndex ?? null);
      setComment(editComment ?? "");

      const parsed = parseLambdaRefersTo(editRefersTo);
      if (parsed) {
        setParams(parsed.params.length > 0 ? parsed.params : [""]);
        setBody(parsed.body);
      } else {
        setParams([""]);
        setBody(editRefersTo.startsWith("=") ? editRefersTo.substring(1) : editRefersTo);
      }
    } else {
      setName("");
      setParams([""]);
      setBody("");
      setComment("");
      setScopeIndex(null);
    }

    setValidationError(null);
    setIsSubmitting(false);
  }, [isOpen, mode, editName, editRefersTo, editSheetIndex, editComment]);

  // Update Monaco IntelliSense whenever params change
  useEffect(() => {
    const validParams = params.filter((p) => p.trim().length > 0);
    setFormulaEditorParams(validParams);
  }, [params]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Don't close if Monaco suggests or focuses
        const activeEl = document.activeElement;
        const isMonacoFocused = activeEl?.closest(".monaco-editor");
        // Check if Monaco widget (autocomplete, etc.) is visible
        const widget = document.querySelector(".monaco-editor .suggest-widget.visible");
        if (widget) return;
        if (isMonacoFocused) {
          // Only close if no widget is open -- let user press Escape twice
          return;
        }
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose]
  );

  // Parameter management
  const addParam = useCallback(() => {
    setParams((prev) => [...prev, ""]);
  }, []);

  const removeParam = useCallback((index: number) => {
    setParams((prev) => {
      if (prev.length <= 1) return [""];
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const updateParam = useCallback((index: number, value: string) => {
    setParams((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    setValidationError(null);
  }, []);

  const moveParamUp = useCallback((index: number) => {
    if (index <= 0) return;
    setParams((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  const moveParamDown = useCallback((index: number) => {
    setParams((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }, []);

  const handleEditorMount: OnMount = useCallback((editorInstance) => {
    editorRef.current = editorInstance;

    // Show placeholder text when editor is empty
    const placeholderText =
      "// Example: a tax-inclusive price calculator\n" +
      "// Parameters: amount, rate\n" +
      "amount * (1 + rate)";
    const placeholderEl = document.createElement("div");
    placeholderEl.style.cssText =
      "color: #6a6a6a; pointer-events: none; position: absolute; top: 4px; left: 64px; " +
      "font-family: 'Cascadia Code', 'Consolas', 'Courier New', monospace; font-size: 13px; " +
      "white-space: pre; line-height: 18px;";
    placeholderEl.textContent = placeholderText;

    const updatePlaceholder = () => {
      const value = editorInstance.getValue();
      placeholderEl.style.display = value.length === 0 ? "block" : "none";
    };

    const domNode = editorInstance.getDomNode();
    if (domNode) {
      const overlayWidgets = domNode.querySelector(".overflow-guard");
      if (overlayWidgets) {
        overlayWidgets.appendChild(placeholderEl);
      }
    }

    updatePlaceholder();
    editorInstance.onDidChangeModelContent(updatePlaceholder);
  }, []);

  const handleBodyChange = useCallback((value: string | undefined) => {
    setBody(value ?? "");
    setValidationError(null);
  }, []);

  const handleOk = useCallback(async () => {
    // Validate function name
    if (!isValidName(name)) {
      setValidationError(
        "Invalid name. Names must start with a letter or underscore, contain only letters, numbers, underscores, and periods, and cannot be cell references."
      );
      return;
    }

    // Validate parameters
    const validParams = params.filter((p) => p.trim().length > 0);
    for (const p of validParams) {
      if (!isValidParamName(p.trim())) {
        setValidationError(
          `Invalid parameter name "${p}". Parameters must start with a letter or underscore.`
        );
        return;
      }
    }

    // Check for duplicate param names
    const upperParams = validParams.map((p) => p.trim().toUpperCase());
    const uniqueParams = new Set(upperParams);
    if (uniqueParams.size !== upperParams.length) {
      setValidationError("Duplicate parameter names are not allowed.");
      return;
    }

    // Validate body
    if (!body.trim()) {
      setValidationError("Function body cannot be empty.");
      return;
    }

    setIsSubmitting(true);
    setValidationError(null);

    try {
      const trimmedParams = validParams.map((p) => p.trim());
      const refersTo = buildLambdaRefersTo(trimmedParams, body.trim());

      if (mode === "edit" && editName) {
        const result = await updateNamedRange(
          editName,
          scopeIndex,
          refersTo,
          comment || undefined,
          FUNCTION_FOLDER_NAME
        );
        if (!result.success) {
          setValidationError(result.error ?? "Failed to update function.");
          setIsSubmitting(false);
          return;
        }
      } else {
        const result = await createNamedRange(
          name,
          scopeIndex,
          refersTo,
          comment || undefined,
          FUNCTION_FOLDER_NAME
        );
        if (!result.success) {
          setValidationError(result.error ?? "Failed to create function.");
          setIsSubmitting(false);
          return;
        }
      }

      emitAppEvent(AppEvents.NAMED_RANGES_CHANGED);
      onClose();
    } catch (error) {
      setValidationError(`Error: ${error}`);
      setIsSubmitting(false);
    }
  }, [name, params, body, comment, scopeIndex, mode, editName, onClose]);

  if (!isOpen) return null;

  const title = mode === "edit" ? "Edit Function" : "New Function";
  const okDisabled = isSubmitting || !name.trim() || !body.trim();

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>{title}</span>
          <button style={styles.closeBtn} onClick={onClose}>
            X
          </button>
        </div>

        <div style={styles.body}>
          {/* Function Name */}
          <div style={styles.field}>
            <label style={styles.label}>Function name:</label>
            <input
              style={styles.input}
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setValidationError(null);
              }}
              disabled={mode === "edit"}
              autoFocus
              placeholder="e.g. AddTax"
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          {/* Parameters */}
          <div style={styles.field}>
            <label style={styles.label}>Parameters:</label>
            {params.map((param, index) => (
              <div key={index} style={styles.paramRow}>
                <input
                  style={styles.paramInput}
                  type="text"
                  value={param}
                  onChange={(e) => updateParam(index, e.target.value)}
                  placeholder={`param${index + 1}`}
                  onKeyDown={(e) => e.stopPropagation()}
                />
                <button
                  style={{
                    ...styles.paramBtn,
                    opacity: index === 0 ? 0.3 : 1,
                  }}
                  onClick={() => moveParamUp(index)}
                  disabled={index === 0}
                  title="Move up"
                >
                  ^
                </button>
                <button
                  style={{
                    ...styles.paramBtn,
                    opacity: index === params.length - 1 ? 0.3 : 1,
                  }}
                  onClick={() => moveParamDown(index)}
                  disabled={index === params.length - 1}
                  title="Move down"
                >
                  v
                </button>
                <button
                  style={styles.paramBtn}
                  onClick={() => removeParam(index)}
                  title="Remove parameter"
                >
                  x
                </button>
              </div>
            ))}
            <button style={styles.addParamBtn} onClick={addParam}>
              + Add Parameter
            </button>
          </div>

          {/* Description */}
          <div style={styles.field}>
            <label style={styles.label}>Description:</label>
            <textarea
              style={styles.textarea}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder="(optional)"
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>

          {/* Function Body (Monaco Editor) */}
          <div style={styles.field}>
            <label style={styles.label}>Function body:</label>
            <div style={styles.editorContainer}>
              <Editor
                height="100%"
                language={LANGUAGE_ID}
                theme="vs-dark"
                value={body}
                onChange={handleBodyChange}
                onMount={handleEditorMount}
                options={{
                  fontSize: 13,
                  fontFamily:
                    "'Cascadia Code', 'Consolas', 'Courier New', monospace",
                  lineNumbers: "on",
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  wordWrap: "on",
                  quickSuggestions: true,
                  suggestOnTriggerCharacters: true,
                  renderLineHighlight: "gutter",
                  scrollbar: {
                    verticalScrollbarSize: 10,
                    horizontalScrollbarSize: 10,
                  },
                  overviewRulerLanes: 0,
                  folding: false,
                  glyphMargin: false,
                  padding: { top: 4, bottom: 4 },
                }}
              />
            </div>
          </div>

          {/* Scope */}
          <div style={styles.field}>
            <label style={styles.label}>Scope:</label>
            <select
              style={styles.select}
              value={scopeIndex === null ? "__workbook__" : String(scopeIndex)}
              onChange={(e) => {
                const val = e.target.value;
                setScopeIndex(
                  val === "__workbook__" ? null : parseInt(val, 10)
                );
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <option value="__workbook__">Workbook</option>
              {sheetNames.map((sn, i) => (
                <option key={i} value={String(i)}>
                  {sn}
                </option>
              ))}
            </select>
          </div>

          {validationError && (
            <div style={styles.error}>{validationError}</div>
          )}
        </div>

        <div style={styles.footer}>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={
              okDisabled
                ? { ...styles.btnPrimary, ...styles.btnDisabled }
                : styles.btnPrimary
            }
            onClick={handleOk}
            disabled={okDisabled}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
