//! FILENAME: app/extensions/Charts/components/ChartSpecEditorApp.tsx
// PURPOSE: Root component for the Chart Spec Editor window.
// CONTEXT: Standalone React app in a separate Tauri window. Shows a Monaco JSON
//          editor on the left and a live chart preview on the right. Communicates
//          with the main window via Tauri events for bidirectional spec sync.
//          Includes a Reference panel with full ChartSpec documentation.

import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ChartSpec, ParsedChartData } from "../types";
import { resolveChartTheme } from "../rendering/chartTheme";
import { dispatchPaint, dispatchComputeLayout } from "../rendering/chartDispatch";
import {
  onOpenWithSpec,
  onSpecUpdated,
  onPreviewDataUpdated,
  emitSpecChanged,
  emitChartSpecEditorClosed,
  emitEditorReady,
} from "../lib/crossWindowEvents";
import { MonacoSpecEditor } from "./MonacoSpecEditor";
import { generateSpecReference } from "../lib/chartSpecSchema";
import { generateSpecGuide } from "../lib/chartSpecGuide";

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

    const theme = resolveChartTheme(spec.config);
    const layout = dispatchComputeLayout(w, h, spec, data, theme);
    ctx.clearRect(0, 0, w, h);
    dispatchPaint(ctx, data, spec, layout, theme);
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

      const theme = resolveChartTheme(spec.config);
      const layout = dispatchComputeLayout(w, h, spec, data, theme);
      ctx.clearRect(0, 0, w, h);
      dispatchPaint(ctx, data, spec, layout, theme);
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
const guideContent = generateSpecGuide();

// ── Inline text renderer (handles **bold** and `code`) ──────────────────

function renderInlineText(text: string, key?: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let partKey = 0;

  while (remaining.length > 0) {
    // Match **bold** or `inline code`
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const codeMatch = remaining.match(/`([^`]+)`/);

    // Find whichever comes first
    let firstMatch: { index: number; length: number; node: React.ReactNode } | null = null;

    if (boldMatch && boldMatch.index !== undefined) {
      const idx = boldMatch.index;
      if (!firstMatch || idx < firstMatch.index) {
        firstMatch = {
          index: idx,
          length: boldMatch[0].length,
          node: <strong key={`${key}-b-${partKey}`} style={{ color: "#e0e0e0", fontWeight: 600 }}>{boldMatch[1]}</strong>,
        };
      }
    }
    if (codeMatch && codeMatch.index !== undefined) {
      const idx = codeMatch.index;
      if (!firstMatch || idx < firstMatch.index) {
        firstMatch = {
          index: idx,
          length: codeMatch[0].length,
          node: <code key={`${key}-c-${partKey}`} style={{
            backgroundColor: "#2d2d2d",
            padding: "1px 4px",
            borderRadius: "3px",
            fontFamily: "'Cascadia Code', Consolas, monospace",
            fontSize: "12px",
            color: "#ce9178",
          }}>{codeMatch[1]}</code>,
        };
      }
    }

    if (!firstMatch) {
      parts.push(remaining);
      break;
    }

    if (firstMatch.index > 0) {
      parts.push(remaining.slice(0, firstMatch.index));
    }
    parts.push(firstMatch.node);
    partKey++;
    remaining = remaining.slice(firstMatch.index + firstMatch.length);
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ── Markdown-like renderer ──────────────────────────────────────────────

function renderMarkdownContent(content: string): React.ReactNode[] {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={elements.length} style={{
          backgroundColor: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: "4px",
          padding: "10px 12px",
          margin: "6px 0 8px 0",
          overflow: "auto",
          fontFamily: "'Cascadia Code', Consolas, monospace",
          fontSize: "12px",
          lineHeight: "1.5",
          color: lang === "json" ? "#ce9178" : "#d4d4d4",
          whiteSpace: "pre",
        }}>
          {codeLines.join("\n")}
        </pre>,
      );
      continue;
    }

    // Headers
    if (line.startsWith("# ")) {
      elements.push(<h1 key={elements.length} style={{ fontSize: "18px", fontWeight: 700, margin: "0 0 12px 0", color: "#e0e0e0", borderBottom: "1px solid #3c3c3c", paddingBottom: "6px" }}>{renderInlineText(line.slice(2))}</h1>);
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(<h2 key={elements.length} style={{ fontSize: "15px", fontWeight: 600, margin: "16px 0 8px 0", color: "#569cd6" }}>{renderInlineText(line.slice(3))}</h2>);
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      elements.push(<h3 key={elements.length} style={{ fontSize: "13px", fontWeight: 600, margin: "12px 0 6px 0", color: "#4ec9b0" }}>{renderInlineText(line.slice(4))}</h3>);
      i++;
      continue;
    }

    // Table row
    if (line.startsWith("|") && line.includes("|")) {
      const cells = line.split("|").filter(Boolean).map((c) => c.trim());
      if (cells.every((c) => c.match(/^-+$/))) {
        i++;
        continue; // Skip separator rows
      }
      const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
      const isHeader = nextLine.match(/^\|[\s-|]+$/);
      elements.push(
        <div key={elements.length} style={{ display: "flex", fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: "11px", lineHeight: "1.8" }}>
          {cells.map((cell, ci) => (
            <span key={ci} style={{
              flex: ci === 0 ? "0 0 160px" : ci === 1 ? "0 0 130px" : "1",
              fontWeight: isHeader ? 600 : 400,
              color: ci === 0 ? "#dcdcaa" : ci === 1 ? "#4ec9b0" : "#d4d4d4",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {renderInlineText(cell)}
            </span>
          ))}
        </div>,
      );
      i++;
      continue;
    }

    // List items
    if (line.startsWith("- ")) {
      elements.push(<div key={elements.length} style={{ paddingLeft: "12px", marginBottom: "2px" }}>{renderInlineText(line)}</div>);
      i++;
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      elements.push(<div key={elements.length} style={{ paddingLeft: "12px", marginBottom: "2px" }}>{renderInlineText(line)}</div>);
      i++;
      continue;
    }

    // Empty line
    if (line === "") {
      elements.push(<div key={elements.length} style={{ height: "6px" }} />);
      i++;
      continue;
    }

    // Regular text
    elements.push(<div key={elements.length}>{renderInlineText(line)}</div>);
    i++;
  }

  return elements;
}

function ReferencePanel(): React.ReactElement {
  return (
    <div style={referencePanelStyle}>
      {renderMarkdownContent(referenceContent)}
    </div>
  );
}

function GuidePanel(): React.ReactElement {
  return (
    <div style={referencePanelStyle}>
      {renderMarkdownContent(guideContent)}
    </div>
  );
}

// ============================================================================
// AI Prompt Panel
// ============================================================================

function AiPromptPanel({ currentSpec }: { currentSpec: string }): React.ReactElement {
  const [task, setTask] = useState("");
  const [includeReference, setIncludeReference] = useState(true);
  const [includeCurrentSpec, setIncludeCurrentSpec] = useState(true);
  const [includeGuide, setIncludeGuide] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const buildPrompt = useCallback((): string => {
    const parts: string[] = [];

    parts.push("I am working with a spreadsheet application called Calcula that has a declarative JSON-based chart specification language (similar to Vega-Lite). I need help with the following task:\n");

    parts.push("## Task\n");
    parts.push(task || "(no task described)");
    parts.push("");

    if (includeCurrentSpec && currentSpec) {
      parts.push("## My Current Chart Spec\n");
      parts.push("```json");
      parts.push(currentSpec);
      parts.push("```\n");
    }

    if (includeReference) {
      parts.push("## ChartSpec Reference\n");
      parts.push(referenceContent);
      parts.push("");
    }

    if (includeGuide) {
      parts.push("## ChartSpec Guide\n");
      parts.push(guideContent);
      parts.push("");
    }

    parts.push("---");
    parts.push("Please respond with a valid ChartSpec JSON object. Only use properties documented in the reference above.");

    return parts.join("\n");
  }, [task, includeReference, includeCurrentSpec, includeGuide, currentSpec]);

  const handleCopy = useCallback(async () => {
    const prompt = buildPrompt();
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [buildPrompt]);

  const prompt = buildPrompt();
  const charCount = prompt.length;
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;

  const checkboxStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    cursor: "pointer",
    fontSize: "12px",
    color: "#ccc",
  };

  const copyBtnStyle: React.CSSProperties = {
    padding: "8px 24px",
    backgroundColor: copied ? "#2ea043" : "#0e639c",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background-color 0.2s",
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
      {/* Task input area */}
      <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid #3c3c3c", flexShrink: 0 }}>
        <div style={{ fontSize: "14px", fontWeight: 600, color: "#e0e0e0", marginBottom: "8px" }}>
          Describe your chart task
        </div>
        <div style={{ fontSize: "11px", color: "#888", marginBottom: "8px" }}>
          Write what you want to achieve. Your task, current spec, and reference docs will be bundled into a prompt ready to paste into any AI assistant.
        </div>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder={"e.g., Make a bar chart that colors negative values red and positive values green.\nAdd a dashed target line at 500.\nUse a dark theme with larger title font."}
          style={{
            width: "100%",
            height: "100px",
            backgroundColor: "#252526",
            color: "#d4d4d4",
            border: "1px solid #3c3c3c",
            borderRadius: "4px",
            padding: "8px 10px",
            fontSize: "13px",
            fontFamily: "'Segoe UI', system-ui, sans-serif",
            lineHeight: "1.5",
            resize: "vertical",
            outline: "none",
            boxSizing: "border-box",
          }}
          onFocus={(e) => { e.target.style.borderColor = "#0e639c"; }}
          onBlur={(e) => { e.target.style.borderColor = "#3c3c3c"; }}
        />
      </div>

      {/* Options row */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "20px",
        padding: "10px 20px",
        borderBottom: "1px solid #3c3c3c",
        flexShrink: 0,
      }}>
        <span style={{ fontSize: "12px", color: "#888", marginRight: "4px" }}>Include:</span>
        <label style={checkboxStyle}>
          <input type="checkbox" checked={includeCurrentSpec} onChange={(e) => setIncludeCurrentSpec(e.target.checked)} />
          Current Spec
        </label>
        <label style={checkboxStyle}>
          <input type="checkbox" checked={includeReference} onChange={(e) => setIncludeReference(e.target.checked)} />
          Reference
        </label>
        <label style={checkboxStyle}>
          <input type="checkbox" checked={includeGuide} onChange={(e) => setIncludeGuide(e.target.checked)} />
          Guide
        </label>
        <div style={{ flex: 1 }} />
        <button
          style={{ ...btnStyle, fontSize: "11px" }}
          onClick={() => setShowPreview(!showPreview)}
        >
          {showPreview ? "Hide Preview" : "Show Preview"}
        </button>
      </div>

      {/* Preview or info */}
      {showPreview ? (
        <div style={{
          flex: 1,
          overflow: "auto",
          minHeight: 0,
          padding: "12px 20px",
          backgroundColor: "#1a1a1a",
        }}>
          <pre style={{
            fontFamily: "'Cascadia Code', Consolas, monospace",
            fontSize: "11px",
            lineHeight: "1.5",
            color: "#999",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
          }}>
            {prompt}
          </pre>
        </div>
      ) : (
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "16px",
          padding: "20px",
          minHeight: 0,
        }}>
          <div style={{ fontSize: "13px", color: "#888", textAlign: "center", maxWidth: "400px", lineHeight: "1.6" }}>
            Describe what you want, then click <strong style={{ color: "#e0e0e0" }}>Copy to Clipboard</strong> to get a complete prompt bundled with the ChartSpec documentation and your current spec.
            Paste it into ChatGPT, Claude, or any AI assistant.
          </div>
          <div style={{ fontSize: "11px", color: "#666", textAlign: "center" }}>
            The AI will receive everything it needs to produce valid ChartSpec JSON.
          </div>
        </div>
      )}

      {/* Bottom bar: copy button + stats */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 20px",
        borderTop: "1px solid #3c3c3c",
        flexShrink: 0,
      }}>
        <span style={{ fontSize: "11px", color: "#666" }}>
          {wordCount.toLocaleString()} words / {charCount.toLocaleString()} chars
        </span>
        <button style={copyBtnStyle} onClick={handleCopy}>
          {copied ? "Copied!" : "Copy to Clipboard"}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// View Modes
// ============================================================================

type ViewMode = "editor" | "reference" | "guide" | "ai-prompt";

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

    const openPromise = onOpenWithSpec((payload) => {
      setSpec(payload.spec);
      setPreviewData(payload.previewData);
      setJsonText(JSON.stringify(payload.spec, null, 2));
      setParseError(null);
      setIsEditing(false);
    });
    unlisteners.push(openPromise);

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

    // Signal to the main window that listeners are ready.
    // Wait for the critical onOpenWithSpec listener to be registered first.
    openPromise.then(() => emitEditorReady());

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
        <button
          style={viewMode === "guide" ? btnActiveStyle : btnStyle}
          onClick={() => setViewMode("guide")}
        >
          Guide
        </button>
        <button
          style={viewMode === "ai-prompt" ? btnActiveStyle : btnStyle}
          onClick={() => setViewMode("ai-prompt")}
        >
          AI Prompt
        </button>
        <div style={{ width: "1px", height: "16px", backgroundColor: "#3c3c3c", margin: "0 4px" }} />
        <button style={btnStyle} onClick={handleFormat}>Format</button>
        <button style={btnStyle} onClick={handleReset}>Reset</button>
      </div>

      {/* Content: Editor+Preview, Reference+Preview, or Guide (full width) */}
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
      ) : viewMode === "reference" ? (
        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
          <div style={{ flex: `0 0 ${splitRatio * 100}%`, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            <ReferencePanel />
          </div>
          <div style={{ width: "1px", backgroundColor: "#3c3c3c", flexShrink: 0 }} />
          <div style={{ ...previewPaneStyle, flex: 1 }}>
            <PreviewCanvas spec={spec} data={previewData} />
          </div>
        </div>
      ) : viewMode === "guide" ? (
        <GuidePanel />
      ) : (
        <AiPromptPanel currentSpec={jsonText} />
      )}

      {/* Error bar */}
      {parseError && (
        <div style={errorBarStyle}>{parseError}</div>
      )}

      {/* Status bar */}
      <div style={statusBarStyle}>
        <span>{spec ? `Type: ${spec.mark}` : "No spec loaded"}</span>
        <span>{
          viewMode === "editor" ? `${lineCount} lines` :
          viewMode === "reference" ? "Reference" :
          viewMode === "guide" ? "Guide" :
          "AI Prompt"
        }</span>
      </div>
    </div>
  );
}
