//! FILENAME: app/extensions/Charts/components/ChartSpecEditorApp.tsx
// PURPOSE: Root component for the Chart Spec Editor window.
// CONTEXT: Standalone React app in a separate Tauri window. Shows a Monaco JSON
//          editor on the left and a live chart preview on the right. Communicates
//          with the main window via Tauri events for bidirectional spec sync.
//          Includes a Reference panel with full ChartSpec documentation.

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ChartSpec, ParsedChartData, ChartLayout } from "../types";
import { DEFAULT_CHART_THEME } from "../rendering/chartTheme";
import type { ChartRenderTheme } from "../rendering/chartTheme";
import { paintBarChart, computeLayout as computeBarLayout } from "../rendering/barChartPainter";
import { paintLineChart, computeLineLayout } from "../rendering/lineChartPainter";
import { paintAreaChart, computeAreaLayout } from "../rendering/areaChartPainter";
import { paintHorizontalBarChart, computeHorizontalBarLayout } from "../rendering/horizontalBarChartPainter";
import { paintPieChart, computePieLayout } from "../rendering/pieChartPainter";
import { paintScatterChart, computeScatterLayout } from "../rendering/scatterChartPainter";
import { paintWaterfallChart, computeWaterfallLayout } from "../rendering/waterfallChartPainter";
import { paintComboChart, computeComboLayout } from "../rendering/comboChartPainter";
import { paintRadarChart, computeRadarLayout } from "../rendering/radarChartPainter";
import { paintBubbleChart, computeBubbleLayout } from "../rendering/bubbleChartPainter";
import { paintHistogramChart, computeHistogramLayout } from "../rendering/histogramChartPainter";
import { paintFunnelChart, computeFunnelLayout } from "../rendering/funnelChartPainter";
import {
  onOpenWithSpec,
  onSpecUpdated,
  onPreviewDataUpdated,
  emitSpecChanged,
  emitChartSpecEditorClosed,
} from "../lib/crossWindowEvents";
import { MonacoSpecEditor } from "./MonacoSpecEditor";
import { generateSpecReference } from "../lib/chartSpecSchema";

// ============================================================================
// Chart Rendering Helpers (same as ChartPreview)
// ============================================================================

function computeLayout(
  w: number, h: number, spec: ChartSpec, data: ParsedChartData, theme: ChartRenderTheme,
): ChartLayout {
  switch (spec.mark) {
    case "bar": return computeBarLayout(w, h, spec, data, theme);
    case "horizontalBar": return computeHorizontalBarLayout(w, h, spec, data, theme);
    case "line": return computeLineLayout(w, h, spec, data, theme);
    case "area": return computeAreaLayout(w, h, spec, data, theme);
    case "scatter": return computeScatterLayout(w, h, spec, data, theme);
    case "pie":
    case "donut": return computePieLayout(w, h, spec, data, theme);
    case "waterfall": return computeWaterfallLayout(w, h, spec, data, theme);
    case "combo": return computeComboLayout(w, h, spec, data, theme);
    case "radar": return computeRadarLayout(w, h, spec, data, theme);
    case "bubble": return computeBubbleLayout(w, h, spec, data, theme);
    case "histogram": return computeHistogramLayout(w, h, spec, data, theme);
    case "funnel": return computeFunnelLayout(w, h, spec, data, theme);
  }
}

function paintChart(
  ctx: CanvasRenderingContext2D, data: ParsedChartData, spec: ChartSpec,
  layout: ChartLayout, theme: ChartRenderTheme,
): void {
  switch (spec.mark) {
    case "bar": paintBarChart(ctx, data, spec, layout, theme); break;
    case "horizontalBar": paintHorizontalBarChart(ctx, data, spec, layout, theme); break;
    case "line": paintLineChart(ctx, data, spec, layout, theme); break;
    case "area": paintAreaChart(ctx, data, spec, layout, theme); break;
    case "scatter": paintScatterChart(ctx, data, spec, layout, theme); break;
    case "pie":
    case "donut": paintPieChart(ctx, data, spec, layout, theme); break;
    case "waterfall": paintWaterfallChart(ctx, data, spec, layout, theme); break;
    case "combo": paintComboChart(ctx, data, spec, layout, theme); break;
    case "radar": paintRadarChart(ctx, data, spec, layout, theme); break;
    case "bubble": paintBubbleChart(ctx, data, spec, layout, theme); break;
    case "histogram": paintHistogramChart(ctx, data, spec, layout, theme); break;
    case "funnel": paintFunnelChart(ctx, data, spec, layout, theme); break;
  }
}

// ============================================================================
// Styles
// ============================================================================

const appStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  backgroundColor: "#1e1e1e",
  color: "#d4d4d4",
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  fontSize: 13,
  overflow: "hidden",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "6px 12px",
  gap: "8px",
  borderBottom: "1px solid #3c3c3c",
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  color: "#e0e0e0",
  flex: 1,
};

const btnStyle: React.CSSProperties = {
  fontSize: "11px",
  padding: "3px 10px",
  backgroundColor: "transparent",
  color: "#999",
  border: "1px solid #3c3c3c",
  borderRadius: "3px",
  cursor: "pointer",
};

const btnActiveStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: "#0e639c",
  color: "#fff",
  borderColor: "#0e639c",
};

const splitContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};

const editorPaneStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
};

const previewPaneStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  backgroundColor: "#ffffff",
};

const resizeHandleStyle: React.CSSProperties = {
  width: "6px",
  cursor: "col-resize",
  backgroundColor: "#2d2d2d",
  flexShrink: 0,
  position: "relative",
};

const resizeHandleLineStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: "2px",
  height: "40px",
  backgroundColor: "#555",
  borderRadius: "1px",
};

const errorBarStyle: React.CSSProperties = {
  color: "#e15759",
  fontSize: "11px",
  padding: "3px 12px",
  borderTop: "1px solid #3c3c3c",
  flexShrink: 0,
  minHeight: "20px",
};

const statusBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "2px 12px",
  borderTop: "1px solid #3c3c3c",
  fontSize: "11px",
  color: "#888",
  flexShrink: 0,
};

const referencePanelStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "16px 20px",
  backgroundColor: "#1e1e1e",
  color: "#d4d4d4",
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  fontSize: "13px",
  lineHeight: "1.6",
};

// ============================================================================
// Resize Handle
// ============================================================================

function ResizeHandle({ onDragStart, onDrag }: {
  onDragStart: () => void;
  onDrag: (deltaX: number) => void;
}): React.ReactElement {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onDragStart();
    const startX = e.clientX;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      onDrag(moveEvent.clientX - startX);
    };
    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [onDragStart, onDrag]);

  return (
    <div style={resizeHandleStyle} onMouseDown={handleMouseDown}>
      <div style={resizeHandleLineStyle} />
    </div>
  );
}

// ============================================================================
// Preview Canvas
// ============================================================================

function PreviewCanvas({ spec, data }: {
  spec: ChartSpec | null;
  data: ParsedChartData | null;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    if (!spec || !data || data.series.length === 0) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#999999";
      ctx.font = "13px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        data ? "No numeric data to chart" : "Waiting for chart data...",
        w / 2, h / 2,
      );
      return;
    }

    const layout = computeLayout(w, h, spec, data, DEFAULT_CHART_THEME);
    ctx.clearRect(0, 0, w, h);
    paintChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
  }, [spec, data]);

  // Re-render on resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      if (!canvas || !spec || !data || data.series.length === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);

      const layout = computeLayout(w, h, spec, data, DEFAULT_CHART_THEME);
      ctx.clearRect(0, 0, w, h);
      paintChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [spec, data]);

  return (
    <div ref={containerRef} style={{ flex: 1, minHeight: 0 }}>
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  );
}

// ============================================================================
// Reference Panel
// ============================================================================

const referenceContent = generateSpecReference();

function ReferencePanel(): React.ReactElement {
  return (
    <div style={referencePanelStyle}>
      {referenceContent.split("\n").map((line, i) => {
        // Render simple markdown-like formatting
        if (line.startsWith("# ")) {
          return <h1 key={i} style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 12px 0", color: "#e0e0e0", borderBottom: "1px solid #3c3c3c", paddingBottom: "6px" }}>{line.slice(2)}</h1>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={i} style={{ fontSize: "15px", fontWeight: 600, margin: "16px 0 8px 0", color: "#569cd6" }}>{line.slice(3)}</h2>;
        }
        if (line.startsWith("### ")) {
          return <h3 key={i} style={{ fontSize: "13px", fontWeight: 600, margin: "12px 0 6px 0", color: "#4ec9b0" }}>{line.slice(4)}</h3>;
        }
        if (line.startsWith("|") && line.includes("|")) {
          // Table row
          const cells = line.split("|").filter(Boolean).map((c) => c.trim());
          if (cells.every((c) => c.match(/^-+$/))) {
            return null; // Skip separator rows
          }
          const isHeader = i > 0 && referenceContent.split("\n")[i + 1]?.match(/^\|[\s-|]+$/);
          return (
            <div key={i} style={{ display: "flex", fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: "11px", lineHeight: "1.8" }}>
              {cells.map((cell, ci) => (
                <span key={ci} style={{
                  flex: ci === 0 ? "0 0 160px" : ci === 1 ? "0 0 130px" : "1",
                  fontWeight: isHeader ? 600 : 400,
                  color: ci === 0 ? "#dcdcaa" : ci === 1 ? "#4ec9b0" : "#d4d4d4",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {cell}
                </span>
              ))}
            </div>
          );
        }
        if (line.startsWith("- ")) {
          return <div key={i} style={{ paddingLeft: "12px", marginBottom: "2px" }}>{line}</div>;
        }
        if (line.startsWith("1. ") || line.startsWith("2. ") || line.startsWith("3. ")) {
          return <div key={i} style={{ paddingLeft: "12px", marginBottom: "2px" }}>{line}</div>;
        }
        if (line === "") {
          return <div key={i} style={{ height: "6px" }} />;
        }
        return <div key={i}>{line}</div>;
      })}
    </div>
  );
}

// ============================================================================
// View Modes
// ============================================================================

type ViewMode = "editor" | "reference";

// ============================================================================
// Main App Component
// ============================================================================

export function ChartSpecEditorApp(): React.ReactElement {
  const [spec, setSpec] = useState<ChartSpec | null>(null);
  const [previewData, setPreviewData] = useState<ParsedChartData | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const baseSplitRatio = useRef(0.5);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("editor");

  // Listen for events from main window
  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];

    unlisteners.push(
      onOpenWithSpec((payload) => {
        setSpec(payload.spec);
        setPreviewData(payload.previewData);
        setJsonText(JSON.stringify(payload.spec, null, 2));
        setParseError(null);
        setIsEditing(false);
      }),
    );

    unlisteners.push(
      onSpecUpdated((payload) => {
        setSpec(payload.spec);
        if (!isEditing) {
          setJsonText(JSON.stringify(payload.spec, null, 2));
          setParseError(null);
        }
      }),
    );

    unlisteners.push(
      onPreviewDataUpdated((payload) => {
        setPreviewData(payload.data);
      }),
    );

    const handleBeforeUnload = () => {
      emitChartSpecEditorClosed();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      unlisteners.forEach((p) => p.then((unlisten) => unlisten()));
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isEditing]);

  // Sync spec -> JSON text when not editing
  useEffect(() => {
    if (!isEditing && spec) {
      setJsonText(JSON.stringify(spec, null, 2));
      setParseError(null);
    }
  }, [spec, isEditing]);

  const handleChange = useCallback((text: string) => {
    setJsonText(text);
    setIsEditing(true);

    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") {
        setParseError("Spec must be a JSON object");
        return;
      }
      if (!parsed.mark || typeof parsed.mark !== "string") {
        setParseError("Missing or invalid 'mark' field");
        return;
      }
      setParseError(null);
      setSpec(parsed as ChartSpec);
      emitSpecChanged(parsed);
    } catch (err) {
      if (err instanceof SyntaxError) {
        setParseError(`JSON syntax error: ${err.message}`);
      } else {
        setParseError(String(err));
      }
    }
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleFormat = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      const formatted = JSON.stringify(parsed, null, 2);
      setJsonText(formatted);
      setParseError(null);
    } catch {
      // Keep as-is
    }
  }, [jsonText]);

  const handleReset = useCallback(() => {
    if (spec) {
      setJsonText(JSON.stringify(spec, null, 2));
      setParseError(null);
      setIsEditing(false);
    }
  }, [spec]);

  // Resize
  const handleResizeDragStart = useCallback(() => {
    baseSplitRatio.current = splitRatio;
  }, [splitRatio]);

  const handleResizeDrag = useCallback((deltaX: number) => {
    const container = splitContainerRef.current;
    if (!container) return;
    const totalWidth = container.clientWidth;
    if (totalWidth === 0) return;
    const newRatio = baseSplitRatio.current + deltaX / totalWidth;
    setSplitRatio(Math.max(0.2, Math.min(0.8, newRatio)));
  }, []);

  const lineCount = jsonText.split("\n").length;

  return (
    <div style={appStyle}>
      {/* Toolbar */}
      <div style={toolbarStyle}>
        <span style={titleStyle}>Chart Specification</span>
        <button
          style={viewMode === "editor" ? btnActiveStyle : btnStyle}
          onClick={() => setViewMode("editor")}
        >
          Editor
        </button>
        <button
          style={viewMode === "reference" ? btnActiveStyle : btnStyle}
          onClick={() => setViewMode("reference")}
        >
          Reference
        </button>
        <div style={{ width: "1px", height: "16px", backgroundColor: "#3c3c3c", margin: "0 4px" }} />
        <button style={btnStyle} onClick={handleFormat}>Format</button>
        <button style={btnStyle} onClick={handleReset}>Reset</button>
      </div>

      {/* Content: Editor+Preview or Reference */}
      {viewMode === "editor" ? (
        <div ref={splitContainerRef} style={splitContainerStyle}>
          {/* Editor pane */}
          <div style={{ ...editorPaneStyle, flex: `0 0 ${splitRatio * 100}%` }}>
            <MonacoSpecEditor
              value={jsonText}
              onChange={handleChange}
              onBlur={handleBlur}
              minimap={jsonText.split("\n").length > 100}
            />
          </div>

          <ResizeHandle onDragStart={handleResizeDragStart} onDrag={handleResizeDrag} />

          {/* Preview pane */}
          <div style={{ ...previewPaneStyle, flex: 1 }}>
            <PreviewCanvas spec={spec} data={previewData} />
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {/* Reference panel takes left side, preview stays on right */}
          <div style={{ flex: `0 0 ${splitRatio * 100}%`, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            <ReferencePanel />
          </div>
          <div style={{ width: "1px", backgroundColor: "#3c3c3c", flexShrink: 0 }} />
          <div style={{ ...previewPaneStyle, flex: 1 }}>
            <PreviewCanvas spec={spec} data={previewData} />
          </div>
        </div>
      )}

      {/* Error bar */}
      {parseError && (
        <div style={errorBarStyle}>{parseError}</div>
      )}

      {/* Status bar */}
      <div style={statusBarStyle}>
        <span>{spec ? `Type: ${spec.mark}` : "No spec loaded"}</span>
        <span>{viewMode === "editor" ? `${lineCount} lines` : "Reference"}</span>
      </div>
    </div>
  );
}
