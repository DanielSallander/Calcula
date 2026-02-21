//! FILENAME: app/extensions/EvaluateFormula/components/EvaluateFormulaDialog.tsx
// PURPOSE: Evaluate Formula dialog - step-by-step formula debugger UI.
// CONTEXT: Displays the formula with underlined next-to-evaluate sub-expression.
//          Buttons: Evaluate, Step In, Step Out, Restart, Close.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  evalFormulaInit,
  evalFormulaEvaluate,
  evalFormulaStepIn,
  evalFormulaStepOut,
  evalFormulaRestart,
  evalFormulaClose,
} from "../../../src/api";
import type { EvalStepState } from "../../../src/api";

// ============================================================================
// Styles (CSS variables from app theme)
// ============================================================================

const v = (name: string) => `var(${name})`;

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1050,
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
    width: 480,
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
    gap: 14,
  },
  refRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
  },
  refLabel: {
    color: v("--text-secondary"),
    flexShrink: 0,
  },
  refValue: {
    fontFamily: "monospace",
    fontWeight: 600,
  },
  evalSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
  evalLabel: {
    color: v("--text-secondary"),
    fontSize: 12,
  },
  formulaBox: {
    background: v("--grid-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    padding: "10px 12px",
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: 14,
    lineHeight: 1.6,
    minHeight: 44,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
    overflowY: "auto" as const,
    maxHeight: 120,
  },
  underline: {
    textDecoration: "underline",
    textDecorationThickness: "2px",
    textUnderlineOffset: "3px",
    fontWeight: 700,
    color: v("--accent-primary"),
  },
  resultRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    marginTop: 2,
  },
  resultLabel: {
    color: v("--text-secondary"),
    flexShrink: 0,
  },
  resultValue: {
    fontFamily: "Consolas, 'Courier New', monospace",
    fontWeight: 600,
  },
  stepInHint: {
    fontSize: 11,
    color: v("--text-secondary"),
    fontStyle: "italic" as const,
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
  },
  footerLeft: {
    display: "flex",
    gap: 6,
  },
  footerRight: {
    display: "flex",
    gap: 6,
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
  errorText: {
    color: "#e74c3c",
    fontSize: 12,
  },
  completeText: {
    color: "#27ae60",
    fontSize: 13,
    fontWeight: 600,
  },
};

// ============================================================================
// Component
// ============================================================================

export function EvaluateFormulaDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const [evalState, setEvalState] = useState<EvalStepState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize session on mount
  useEffect(() => {
    const sel = data as Record<string, unknown> | undefined;
    const activeRow = (sel?.activeRow as number) ?? 0;
    const activeCol = (sel?.activeCol as number) ?? 0;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    evalFormulaInit(activeRow, activeCol)
      .then((state) => {
        if (cancelled) return;
        if (state.error) {
          setError(state.error);
        } else {
          setEvalState(state);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Cleanup session on unmount
  useEffect(() => {
    return () => {
      if (evalState?.sessionId) {
        evalFormulaClose(evalState.sessionId).catch(() => {});
      }
    };
  }, [evalState?.sessionId]);

  // Keyboard handler
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleClose();
      } else if (e.key === "Enter" && evalState?.canEvaluate && !evalState.isComplete && !isLoading) {
        e.stopPropagation();
        handleEvaluate();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [evalState, isLoading]);

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        handleClose();
      }
    },
    [evalState],
  );

  // --- Action handlers ---

  const handleClose = useCallback(() => {
    if (evalState?.sessionId) {
      evalFormulaClose(evalState.sessionId).catch(() => {});
    }
    onClose();
  }, [evalState, onClose]);

  const runCommand = useCallback(
    async (fn: (sessionId: string) => Promise<EvalStepState>) => {
      if (!evalState?.sessionId || isLoading) return;
      setIsLoading(true);
      setError(null);
      try {
        const newState = await fn(evalState.sessionId);
        if (newState.error) {
          setError(newState.error);
        }
        setEvalState(newState);
      } catch (err) {
        setError(String(err));
      } finally {
        setIsLoading(false);
      }
    },
    [evalState, isLoading],
  );

  const handleEvaluate = useCallback(() => {
    runCommand(evalFormulaEvaluate);
  }, [runCommand]);

  const handleStepIn = useCallback(() => {
    runCommand(evalFormulaStepIn);
  }, [runCommand]);

  const handleStepOut = useCallback(() => {
    runCommand(evalFormulaStepOut);
  }, [runCommand]);

  const handleRestart = useCallback(() => {
    runCommand(evalFormulaRestart);
  }, [runCommand]);

  // --- Render helpers ---

  function renderFormula(): React.ReactNode {
    if (!evalState) return null;

    const { formulaDisplay, underlineStart, underlineEnd, isComplete } = evalState;

    if (isComplete || underlineStart >= underlineEnd) {
      return <span>{formulaDisplay}</span>;
    }

    const before = formulaDisplay.slice(0, underlineStart);
    const highlighted = formulaDisplay.slice(underlineStart, underlineEnd);
    const after = formulaDisplay.slice(underlineEnd);

    return (
      <>
        <span>{before}</span>
        <span style={styles.underline}>{highlighted}</span>
        <span>{after}</span>
      </>
    );
  }

  function btnStyle(enabled: boolean, primary?: boolean): React.CSSProperties {
    const base = primary ? styles.btnPrimary : styles.btn;
    return enabled ? base : { ...base, ...styles.btnDisabled };
  }

  // --- Render ---

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Evaluate Formula</span>
          <button style={styles.closeBtn} onClick={handleClose}>
            X
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Reference */}
          {evalState && (
            <div style={styles.refRow}>
              <span style={styles.refLabel}>Reference:</span>
              <span style={styles.refValue}>{evalState.cellReference}</span>
            </div>
          )}

          {/* Formula display */}
          <div style={styles.evalSection}>
            <span style={styles.evalLabel}>Evaluation:</span>
            <div style={styles.formulaBox}>
              {isLoading && !evalState ? (
                <span style={{ color: v("--text-secondary") }}>Loading...</span>
              ) : error && !evalState ? (
                <span style={styles.errorText}>{error}</span>
              ) : evalState ? (
                renderFormula()
              ) : null}
            </div>
          </div>

          {/* Result of last evaluation */}
          {evalState?.evaluationResult && (
            <div style={styles.resultRow}>
              <span style={styles.resultLabel}>Result:</span>
              <span style={styles.resultValue}>{evalState.evaluationResult}</span>
            </div>
          )}

          {/* Step-in hint */}
          {evalState?.canStepIn && evalState.stepInTarget && (
            <div style={styles.stepInHint}>
              {evalState.stepInTarget} contains a formula - click Step In to debug it
            </div>
          )}

          {/* Complete indicator */}
          {evalState?.isComplete && (
            <div style={styles.completeText}>Evaluation complete</div>
          )}

          {/* Error display */}
          {error && evalState && (
            <div style={styles.errorText}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <div style={styles.footerLeft}>
            <button
              style={btnStyle(!!evalState?.canEvaluate && !evalState?.isComplete && !isLoading, true)}
              onClick={handleEvaluate}
              disabled={!evalState?.canEvaluate || evalState?.isComplete || isLoading}
            >
              Evaluate
            </button>
            <button
              style={btnStyle(!!evalState?.canStepIn && !isLoading)}
              onClick={handleStepIn}
              disabled={!evalState?.canStepIn || isLoading}
            >
              Step In
            </button>
            <button
              style={btnStyle(!!evalState?.canStepOut && !isLoading)}
              onClick={handleStepOut}
              disabled={!evalState?.canStepOut || isLoading}
            >
              Step Out
            </button>
            <button
              style={btnStyle(!!evalState && !isLoading)}
              onClick={handleRestart}
              disabled={!evalState || isLoading}
            >
              Restart
            </button>
          </div>
          <div style={styles.footerRight}>
            <button style={styles.btn} onClick={handleClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
