//! FILENAME: app/extensions/Insights/components/InsightCard.tsx
// PURPOSE: One computed fact, rendered so a reader can interrogate it.
// CONTEXT: The "why" affordance is the strategy layer's entire visible payoff.
//          A fact with provenance can answer "why does it think a rise here is
//          bad?" with a named attribute, its value, and where the value came
//          from — base metadata, an inference, a KPI, a strategy declaration, a
//          rule. A raw-grid fact has no provenance and must therefore show NO
//          affordance at all: an empty "why" that opens onto nothing teaches the
//          reader that the button means nothing, which is worse than not having
//          it. Both directions are pinned by tests.
//
//          `score` is rendered as a WEIGHT, never as a percentage. It is a
//          ranking number; dressing it as "82% confident" would be a claim the
//          engine never made.
//
//          Evidence clicks: a `range` selects the cells. A `query` has no pivot-
//          opening path from here, so it renders its measures and group-by as
//          text rather than pretending to be a link.

import React from "react";
import type { Insight, InsightEvidence } from "@api/insightsService";

export interface InsightCardProps {
  insight: Insight;
  /**
   * When the bundle was computed (epoch ms), or null.
   *
   * Present for the model path, where the answer is only as fresh as the last
   * refresh of the model behind it. A range answer is computed from cells the
   * reader is looking at, so it carries no such line.
   */
  asOf: number | null;
  whyExpanded: boolean;
  onToggleWhy: (insightId: string) => void;
  onEvidenceClick: (evidence: InsightEvidence) => void;
  /**
   * "Show on chart": present only when the bundle came from a chart, so the
   * button never opens onto nothing (the same rule as "Why?").
   */
  onShowOnChart?: (insightId: string) => void;
  /** The button's words: "Show on chart" (default) or "Show on sheet". */
  showOnLabel?: string;
}

const cardStyle: React.CSSProperties = {
  border: "1px solid #E0E0E0",
  borderRadius: 6,
  background: "#FFF",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const kindStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "#3A6EA5",
  background: "#EDF3FA",
  borderRadius: 3,
  padding: "2px 6px",
};

const weightStyle: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 10,
  color: "#8A8A8A",
};

const textStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: "#222",
};

const asOfStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#8A8A8A",
};

const evidenceRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const evidenceLinkStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#2A5DB0",
  background: "none",
  border: "1px solid #CFE0F5",
  borderRadius: 3,
  padding: "1px 6px",
  cursor: "pointer",
};

const evidenceTextStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  border: "1px solid #E4E4E4",
  borderRadius: 3,
  padding: "1px 6px",
};

const whyButtonStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  fontSize: 11,
  color: "#5A5A5A",
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline",
};

const whyListStyle: React.CSSProperties = {
  margin: 0,
  padding: "6px 8px",
  listStyle: "none",
  background: "#F7F7F7",
  borderRadius: 4,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const whyItemStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#444",
};

/** "Revenue, Margin by Region, Month" — a query's evidence as plain text. */
export function describeQueryEvidence(evidence: InsightEvidence): string {
  const measures = evidence.measures ?? [];
  const groupBy = evidence.groupBy ?? [];
  if (measures.length === 0 && groupBy.length === 0) return evidence.label;
  const head = measures.length > 0 ? measures.join(", ") : evidence.label;
  return groupBy.length > 0 ? `${head} by ${groupBy.join(", ")}` : head;
}

function formatAsOf(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
  }
}

export function InsightCard({
  insight,
  asOf,
  whyExpanded,
  onToggleWhy,
  onEvidenceClick,
  onShowOnChart,
  showOnLabel = "Show on chart",
}: InsightCardProps): React.ReactElement {
  const hasWhy = insight.provenance.length > 0;
  const whyListId = `insight-why-${insight.id}`;
  const actionRowStyle: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center" };

  return (
    <div style={cardStyle} data-testid="insight-card" data-insight-id={insight.id}>
      <div style={headerStyle}>
        <span style={kindStyle} data-testid="insight-kind">
          {insight.kind}
        </span>
        <span style={weightStyle} data-testid="insight-weight">
          weight {insight.score.toFixed(2)}
        </span>
      </div>

      <div style={textStyle} data-testid="insight-text">
        {insight.text}
      </div>

      {asOf !== null && (
        <div style={asOfStyle} data-testid="insight-asof">
          As of {formatAsOf(asOf)}
        </div>
      )}

      {insight.evidence.length > 0 && (
        <div style={evidenceRowStyle}>
          {insight.evidence.map((ev, i) =>
            ev.kind === "range" ? (
              <button
                key={`${ev.kind}-${i}`}
                type="button"
                style={evidenceLinkStyle}
                data-testid="insight-evidence-range"
                onClick={() => onEvidenceClick(ev)}
              >
                {ev.label}
              </button>
            ) : (
              <span
                key={`${ev.kind}-${i}`}
                style={evidenceTextStyle}
                data-testid="insight-evidence-query"
                title={ev.label}
              >
                {describeQueryEvidence(ev)}
              </span>
            ),
          )}
        </div>
      )}

      {(hasWhy || onShowOnChart) && (
        <div style={actionRowStyle}>
          {hasWhy && (
            <button
              type="button"
              style={whyButtonStyle}
              data-testid="insight-why-toggle"
              aria-expanded={whyExpanded}
              aria-controls={whyListId}
              onClick={() => onToggleWhy(insight.id)}
            >
              {whyExpanded ? "Hide why" : "Why?"}
            </button>
          )}
          {onShowOnChart && (
            <button
              type="button"
              style={whyButtonStyle}
              data-testid="insight-show-on-chart"
              onClick={() => onShowOnChart(insight.id)}
            >
              {showOnLabel}
            </button>
          )}
        </div>
      )}

      {hasWhy && whyExpanded && (
        <ul id={whyListId} style={whyListStyle} data-testid="insight-why-list">
          {insight.provenance.map((p, i) => (
            <li key={`${p.attribute}-${i}`} style={whyItemStyle}>
              {p.attribute}: {p.value} ({p.source})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
