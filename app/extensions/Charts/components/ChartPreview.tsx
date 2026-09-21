//! FILENAME: app/extensions/Charts/components/ChartPreview.tsx
// PURPOSE: Live chart preview canvas inside the dialog.
// CONTEXT: Renders any chart type using the same painters used for grid overlays,
//          giving WYSIWYG feedback as the user configures their chart.

import React, { useRef, useEffect, useCallback } from "react";
import type { ChartSpec, ParsedChartData } from "../types";
import { hasRenderableData } from "../types";
import { resolveChartTheme } from "../rendering/chartTheme";
import { dispatchPaint, dispatchComputeLayout } from "../rendering/chartDispatch";
import { PreviewContainer, PreviewCanvas } from "./CreateChartDialog.styles";

interface ChartPreviewProps {
  spec: ChartSpec;
  data: ParsedChartData | null;
  /**
   * What to say when there is nothing to draw. The default blames a missing
   * data range, which is a lie whenever the range is fine and the user has
   * simply unchecked every series — a lie the pinned preview pane now puts in
   * front of the user the whole time, so the caller says why instead.
   */
  emptyMessage?: string;
}

export function ChartPreview({ spec, data, emptyMessage }: ChartPreviewProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /** Paint at the canvas's CURRENT client size. Called on data/spec change and
   *  on every resize — the canvas backing store is sized from clientWidth, so a
   *  paint that predates a resize leaves a stretched bitmap behind. */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    if (!hasRenderableData(data)) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#999999";
      ctx.font = "12px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        emptyMessage ??
          (data ? "No numeric data to chart" : "Select a data range to preview"),
        w / 2,
        h / 2,
      );
      return;
    }

    const theme = resolveChartTheme(spec.config);
    const layout = dispatchComputeLayout(w, h, spec, data, theme);
    ctx.clearRect(0, 0, w, h);
    dispatchPaint(ctx, data, spec, layout, theme);
  }, [spec, data, emptyMessage]);

  useEffect(() => {
    paint();
  }, [paint]);

  // The preview now fills a resizable pane (dialog drag-resize, splitter drag,
  // Spec-tab full view), so its size changes independently of spec/data.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => paint());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [paint]);

  return (
    <PreviewContainer>
      <PreviewCanvas ref={canvasRef} />
    </PreviewContainer>
  );
}
