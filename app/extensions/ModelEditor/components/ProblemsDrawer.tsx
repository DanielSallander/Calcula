// FILENAME: app/extensions/ModelEditor/components/ProblemsDrawer.tsx
// PURPOSE: The one place that answers "what is wrong with this model?", with
//          every row a link to the object it concerns.
// CONTEXT: Non-modal on purpose. A problems list you must dismiss to act on is
//          a list you read once and close; this one stays open beside the
//          section you are fixing, which is the whole point of the rows being
//          navigable.
//
//          It states its COVERAGE rather than implying it. An empty list means
//          "the checks that ran found nothing", and the checks that ran are
//          named — because "Problems 0" reading as "checked and clean" when it
//          means "nothing was checked" is the one way a panel like this can
//          actively mislead.

import React from "react";
import { styles } from "./editorShared";
import type { SectionId } from "./editorShared";
import { FONT, ME, RADIUS, SHADOW, SPACE, TABULAR } from "./theme";
import { describeCoverage, groupProblems } from "../lib/problems";
import type { Problem, ProblemCoverage, ProblemSeverity } from "../lib/problems";

const TONE: Record<ProblemSeverity, { fg: string; bg: string; glyph: string; label: string }> = {
  error: { fg: ME.dangerFg, bg: ME.dangerBg, glyph: "●", label: "Error" },
  warning: { fg: ME.warnFg, bg: ME.warnBg, glyph: "▲", label: "Warning" },
  info: { fg: ME.infoFg, bg: ME.infoBg, glyph: "ⓘ", label: "Info" },
};

export function ProblemsDrawer({
  problems,
  coverage,
  busy,
  onNavigate,
  onRecheck,
  onClose,
}: {
  problems: Problem[];
  coverage: ProblemCoverage;
  busy: boolean;
  onNavigate: (section: SectionId, selection?: string) => void;
  onRecheck: () => void;
  onClose: () => void;
}): React.ReactElement {
  const groups = groupProblems(problems);

  return (
    <aside
      data-testid="problems-drawer"
      aria-label="Problems"
      style={{
        width: 380,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: ME.surface,
        borderLeft: `1px solid ${ME.borderSubtle}`,
        boxShadow: SHADOW.popover,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: SPACE.sm,
          padding: `${SPACE.md}px ${SPACE.lg}px`,
          borderBottom: `1px solid ${ME.borderSubtle}`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: FONT.sectionTitle, flex: 1 }}>
          Problems{" "}
          <span style={{ ...TABULAR, color: ME.text3, fontWeight: 400 }}>{problems.length}</span>
        </span>
        <button
          style={styles.smallBtn}
          disabled={busy}
          data-testid="problems-recheck"
          title="Re-run the engine's build check and the strategy validator"
          onClick={onRecheck}
        >
          {busy ? "Checking…" : "Re-check"}
        </button>
        <button style={styles.smallBtn} aria-label="Close problems" onClick={onClose}>
          ✕
        </button>
      </div>

      <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: SPACE.sm }}>
        {groups.length === 0 && (
          <div style={{ padding: SPACE.lg, color: ME.text3, fontSize: FONT.sm }}>
            Nothing found by the checks below.
          </div>
        )}
        {groups.map((g) => {
          const tone = TONE[g.severity];
          return (
            <div key={g.code} style={{ marginBottom: SPACE.md }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: SPACE.sm,
                  padding: `${SPACE.xs}px ${SPACE.sm}px`,
                  fontSize: FONT.sm,
                  fontWeight: 600,
                  color: tone.fg,
                }}
              >
                <span aria-hidden="true" style={{ flexShrink: 0 }}>
                  {tone.glyph}
                </span>
                {/* minWidth:0 or a long title pushes the count out of the row —
                    and a group showing no count while its neighbours show one
                    reads as "this group is different" rather than "this title
                    is long". */}
                <span style={{ flex: 1, minWidth: 0 }}>{g.title}</span>
                <span style={{ ...TABULAR, color: ME.text3, fontWeight: 400, flexShrink: 0 }}>
                  {g.items.length}
                </span>
              </div>
              {g.items.map((p, i) => (
                <button
                  key={`${p.code}:${p.subject}:${i}`}
                  type="button"
                  data-testid="problem-row"
                  data-me-row=""
                  title={`${tone.label}: ${p.message}`}
                  onClick={() => onNavigate(p.section, p.selection)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    background: "transparent",
                    borderRadius: RADIUS.control,
                    padding: `${SPACE.xs}px ${SPACE.sm}px ${SPACE.xs}px ${SPACE.xl}px`,
                    cursor: "pointer",
                    font: "inherit",
                    color: ME.text,
                  }}
                >
                  <div style={{ fontSize: FONT.base }}>{p.subject}</div>
                  <div style={{ fontSize: FONT.sm, color: ME.text2 }}>{p.message}</div>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {/* Coverage, always. An empty list is only trustworthy next to a statement
          of what was actually checked. */}
      <div
        style={{
          flexShrink: 0,
          padding: `${SPACE.sm}px ${SPACE.lg}px`,
          borderTop: `1px solid ${ME.borderSubtle}`,
          color: ME.text3,
          fontSize: FONT.xs,
        }}
        data-testid="problems-coverage"
      >
        {describeCoverage(coverage)}
      </div>
    </aside>
  );
}

/** The top-bar chip. Absent when clean — a permanent "0" is furniture. */
export function ProblemsChip({
  problems,
  open,
  onClick,
}: {
  problems: Problem[];
  open: boolean;
  onClick: () => void;
}): React.ReactElement | null {
  if (problems.length === 0) return null;
  const errors = problems.filter((p) => p.severity === "error").length;
  const tone = errors > 0 ? TONE.error : TONE.warning;
  return (
    <button
      type="button"
      data-testid="problems-chip"
      aria-pressed={open}
      title={errors > 0 ? `${errors} error(s)` : `${problems.length} finding(s)`}
      onClick={onClick}
      style={{
        ...styles.smallBtn,
        display: "flex",
        alignItems: "center",
        gap: SPACE.xs,
        background: tone.bg,
        color: tone.fg,
        borderColor: tone.fg,
        ...TABULAR,
      }}
    >
      <span aria-hidden="true">{tone.glyph}</span>
      {errors > 0 ? errors : problems.length}
    </button>
  );
}
