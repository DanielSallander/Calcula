//! FILENAME: app/extensions/Animation/components/MonteCarloView.tsx
// PURPOSE: Live Monte Carlo output — a compact histogram + running stats over the
//          accumulated outcome samples. Subscribes to the monteCarloStore (rAF-
//          coalesced), so it stays responsive across thousands of trials.
import React, { useEffect, useState } from "react";
import {
  mcSubscribe,
  mcSamples,
  mcOutcomeLabel,
  computeStats,
  computeHistogram,
} from "../lib/monteCarloStore";

const sectionTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  opacity: 0.7,
  textTransform: "uppercase",
};

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a !== 0 && (a < 0.001 || a >= 1e6)) return n.toExponential(2);
  return (Math.round(n * 100) / 100).toString();
}

export function MonteCarloView(): React.ReactElement {
  const [, setTick] = useState(0);
  useEffect(() => mcSubscribe(() => setTick((t) => t + 1)), []);

  const samples = mcSamples();
  const stats = computeStats(samples);
  const hist = computeHistogram(samples, 20);
  const label = mcOutcomeLabel();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 220 }}>
      <span style={sectionTitle}>Monte Carlo{label ? ` · ${label}` : ""}</span>
      {!stats ? (
        <div style={{ opacity: 0.6, fontSize: 11 }}>Press Play to run trials.</div>
      ) : (
        <>
          <svg width="100%" height={64} viewBox="0 0 200 64" preserveAspectRatio="none" style={{ display: "block" }}>
            {hist &&
              (() => {
                const max = Math.max(1, ...hist.counts);
                const n = hist.counts.length;
                const bw = 200 / n;
                return hist.counts.map((c, i) => {
                  const h = (c / max) * 60;
                  return <rect key={i} x={i * bw + 0.5} y={62 - h} width={Math.max(0.5, bw - 1)} height={h} fill="#217346" />;
                });
              })()}
          </svg>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
            <span>trials: <strong>{stats.count}</strong></span>
            <span>mean: <strong>{fmt(stats.mean)}</strong></span>
            <span>std: <strong>{fmt(stats.std)}</strong></span>
            <span>min / max: <strong>{fmt(stats.min)}</strong> / <strong>{fmt(stats.max)}</strong></span>
            <span>p5: <strong>{fmt(stats.p5)}</strong></span>
            <span>p95: <strong>{fmt(stats.p95)}</strong></span>
          </div>
        </>
      )}
    </div>
  );
}
