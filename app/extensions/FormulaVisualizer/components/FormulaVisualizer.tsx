//! FILENAME: app/extensions/FormulaVisualizer/components/FormulaVisualizer.tsx
// PURPOSE: Main container component for the Formula Visualizer dialog.
// CONTEXT: Loads the evaluation plan from backend, wires all sub-components.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "@api/uiTypes";
import type { FormulaEvalPlan } from "@api";
import { getFormulaEvalPlan } from "@api";
import { FormulaReductionStrip } from "./FormulaReductionStrip";
import { PlaybackControls } from "./PlaybackControls";
import { ExecutionPlanTree } from "./ExecutionPlanTree";
import { PlanLegend } from "./PlanLegend";
import { usePlayback } from "../hooks/usePlayback";
import { formatPlanAsYaml } from "../utils/exportPlan";

const v = (name: string) => `var(${name})`;

// ============================================================================
// Styles
// ============================================================================

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
    width: 780,
    maxWidth: "90vw",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 16px",
    borderBottom: `1px solid ${v("--border-default")}`,
    flexShrink: 0,
  },
  title: {
    fontWeight: 600,
    fontSize: 15,
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  headerBtn: {
    background: "transparent",
    border: `1px solid ${v("--border-default")}`,
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "3px 8px",
    borderRadius: 4,
    fontSize: 11,
    lineHeight: 1,
    fontFamily: "'Segoe UI', system-ui, sans-serif",
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
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    flex: 1,
    overflow: "hidden",
  },
  footer: {
    padding: "0 16px 8px",
    flexShrink: 0,
  },
  errorText: {
    color: "#e74c3c",
    fontSize: 13,
    padding: 16,
    textAlign: "center" as const,
  },
  loadingText: {
    color: v("--text-secondary"),
    fontSize: 13,
    padding: 24,
    textAlign: "center" as const,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap" as const,
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    color: v("--text-secondary"),
    cursor: "pointer",
    userSelect: "none" as const,
  },
  zoomControl: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    marginLeft: "auto",
  },
};

// ============================================================================
// Component
// ============================================================================

export function FormulaVisualizer(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const [plan, setPlan] = useState<FormulaEvalPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [showValues, setShowValues] = useState(true);
  const [showRefs, setShowRefs] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [copyLabel, setCopyLabel] = useState("Copy");

  const totalSteps = plan?.steps.length ?? 0;
  const playback = usePlayback(totalSteps);

  // Load plan on mount
  useEffect(() => {
    const sel = data as Record<string, unknown> | undefined;
    const activeRow = (sel?.activeRow as number) ?? 0;
    const activeCol = (sel?.activeCol as number) ?? 0;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getFormulaEvalPlan(activeRow, activeCol)
      .then((result) => {
        if (cancelled) return;
        setPlan(result);
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

  // Copy plan as YAML
  const handleCopy = useCallback(() => {
    if (!plan) return;
    const yaml = formatPlanAsYaml(plan);
    navigator.clipboard.writeText(yaml).then(() => {
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy"), 1500);
    });
  }, [plan]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (!plan) return;

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (playback.state.status === "playing") {
          playback.pause();
        } else {
          playback.play();
        }
      } else if (e.key === "ArrowRight") {
        e.stopPropagation();
        playback.stepForward();
      } else if (e.key === "ArrowLeft") {
        e.stopPropagation();
        playback.stepBack();
      } else if (e.key === "r" || e.key === "R") {
        if (!e.ctrlKey && !e.metaKey) {
          e.stopPropagation();
          playback.reset();
        }
      } else if (e.key >= "1" && e.key <= "5") {
        e.stopPropagation();
        playback.setSpeed(Number(e.key) - 1);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [plan, playback]);

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  const handleHoverNode = useCallback((id: string | null) => {
    setHoveredNodeId(id);
  }, []);

  return (
    <div style={styles.backdrop} onMouseDown={handleBackdropClick}>
      <div ref={dialogRef} style={styles.dialog}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.title}>Formula Visualizer</span>
          <div style={styles.headerActions}>
            {plan && (
              <button style={styles.headerBtn} onClick={handleCopy} title="Copy plan as YAML">
                {copyLabel}
              </button>
            )}
            <button style={styles.closeBtn} onClick={onClose}>
              X
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {isLoading && (
            <div style={styles.loadingText}>Loading evaluation plan...</div>
          )}

          {error && (
            <div style={styles.errorText}>{error}</div>
          )}

          {plan && !error && (
            <>
              {/* Formula reduction strip */}
              <FormulaReductionStrip
                plan={plan}
                currentStep={playback.state.currentStep}
                hoveredNodeId={hoveredNodeId}
                onHoverNode={handleHoverNode}
              />

              {/* Playback controls */}
              <PlaybackControls
                controls={playback}
                totalSteps={totalSteps}
              />

              {/* Toolbar: settings + zoom */}
              <div style={styles.toolbar}>
                <label style={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={showValues}
                    onChange={(e) => setShowValues(e.target.checked)}
                  />
                  Show values
                </label>
                <label style={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={showRefs}
                    onChange={(e) => setShowRefs(e.target.checked)}
                  />
                  Show references
                </label>

                <div style={styles.zoomControl}>
                  <span style={{ fontSize: 11, color: v("--text-secondary") }}>Zoom:</span>
                  <input
                    type="range"
                    min={25}
                    max={200}
                    step={5}
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                    style={{ width: 80, cursor: "pointer" }}
                    title={`${zoom}%`}
                  />
                  <span style={{ fontSize: 11, color: v("--text-secondary"), minWidth: 32 }}>
                    {zoom}%
                  </span>
                </div>
              </div>

              {/* Execution plan tree */}
              <ExecutionPlanTree
                plan={plan}
                currentStep={playback.state.currentStep}
                isComplete={playback.state.status === "complete"}
                hoveredNodeId={hoveredNodeId}
                onHoverNode={handleHoverNode}
                showValues={showValues}
                showRefs={showRefs}
                zoom={zoom}
              />
            </>
          )}
        </div>

        {/* Legend footer */}
        {plan && !error && (
          <div style={styles.footer}>
            <PlanLegend />
          </div>
        )}
      </div>
    </div>
  );
}
