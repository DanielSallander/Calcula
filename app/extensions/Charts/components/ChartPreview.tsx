//! FILENAME: app/extensions/Charts/components/ChartPreview.tsx
// PURPOSE: Live chart preview canvas inside the dialog.
// CONTEXT: Renders a bar chart using the same painter used for grid overlays,
//          giving WYSIWYG feedback as the user configures their chart.

import React, { useRef, useEffect } from "react";
import type { ChartSpec, ParsedChartData } from "../types";
import { paintBarChart, computeLayout } from "../rendering/barChartPainter";
import { DEFAULT_CHART_THEME } from "../rendering/chartTheme";
import { PreviewContainer, PreviewCanvas } from "./CreateChartDialog.styles";

interface ChartPreviewProps {
  spec: ChartSpec;
  data: ParsedChartData | null;
}

export function ChartPreview({ spec, data }: ChartPreviewProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.series.length === 0) {
      // Draw empty state
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          canvas.width = canvas.clientWidth * dpr;
          canvas.height = canvas.clientHeight * dpr;
          ctx.scale(dpr, dpr);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
          ctx.fillStyle = "#999999";
          ctx.font = "12px 'Segoe UI', system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(
            data ? "No numeric data to chart" : "Select a data range to preview",
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          );
        }
      }
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const layout = computeLayout(w, h, spec, data, DEFAULT_CHART_THEME);
    ctx.clearRect(0, 0, w, h);
    paintBarChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
  }, [spec, data]);

  return (
    <PreviewContainer>
      <PreviewCanvas ref={canvasRef} />
    </PreviewContainer>
  );
}
