// FILENAME: app/extensions/ModelEditor/components/sections/strategy/constants.ts
// PURPOSE: Every literal the Strategy tab's modules share. The LEAF of the
//          folder's import graph — it imports nothing from its siblings, so
//          nothing here can create a cycle.
// CONTEXT: This module exists because two of these are genuinely shared and
//          would otherwise force one. `MEASURE_HEADERS` is read by the folder
//          header row (which lives in the tree module) AND by the measures
//          grid; `TARGET_HINT` by the measures grid AND by the rule modal.
//          Putting either inside the grid that "owns" it makes the tree import
//          the grid and the modal import the grid — a cycle in one case and a
//          layering inversion in the other.
//
//          Implements part of properties (10) and (17); the numbered list they
//          belong to lives in ../StrategySection.tsx, which is the ONE place it
//          is written down.

// ---------------------------------------------------------------------------
// Status lines
// ---------------------------------------------------------------------------

export const DRAFT_STATUS =
  "No stored strategy — this is an inferred draft. Nothing is written until you press Save.";
export const RESUMED_STATUS =
  "Showing your unsaved draft — nothing is written until you press Save.";
export const NO_DRAFT_STATUS = "This model has no strategy yet — Infer proposes a draft.";

/** How long an edit rests before the preview is re-fetched. */
export const PREVIEW_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// The model block
// ---------------------------------------------------------------------------

export const FISCAL_YEAR_START_HINT =
  "MM-DD — 04-01 for an April fiscal year. Leave empty for the calendar year.";

/** Days per month, February at 29 — a fiscal year START recurs, so it has no
 *  year to be a leap year in, and 02-29 must be accepted. */
export const MONTH_DAY_MAX = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const NOT_YET_CONSULTED =
  "Saved with the strategy and carried with the model — but nothing reads it yet, so setting it changes no insight today.";

// ---------------------------------------------------------------------------
// The measures grid
// ---------------------------------------------------------------------------

/** Measure columns whose value is stored and read by nothing (property 10).
 *
 *  EMPTY, and deliberately kept rather than deleted: `unit` and `cadence` were
 *  here until their readers landed on 2026-09-09. The next inert field is a
 *  matter of time, and the machinery costs nothing while the list is empty. */
export const NOT_YET_CONSULTED_MEASURE_FIELDS: string[] = [];

export const MEASURE_HEADERS = [
  "measure",
  "direction",
  "aggregation",
  "unit",
  "target",
  "materiality",
  "cadence",
  "priority",
  "analysis dimensions",
  "never slice by",
  "reviewed",
];

/**
 * Column groups, so eleven columns stop needing a horizontal scrollbar.
 *
 * Eleven columns do not fit in this window and never will — it opens at
 * 1150px. Sideways scrolling in a grid you are working DOWN is the worst of
 * both directions, and it is what forced the `reviewed` column to be sticky in
 * the first place (property 17).
 *
 * Applied by CSS `nth-child` against `data-cols` on the table, NOT by making
 * eleven hand-written `<td>`s conditional: the header is a map and the body is
 * eleven literals, so a JSX split is eleven chances for the two to disagree
 * about which column is which. `measure` (1) and `reviewed` (11) are in every
 * group — one names the row, the other is the answer you are here to give.
 */
export type MeasureColumnGroup = "meaning" | "aggregation" | "slicing" | "all";

export const MEASURE_COLUMN_GROUPS: Array<{ id: MeasureColumnGroup; label: string }> = [
  { id: "meaning", label: "Meaning" },
  { id: "aggregation", label: "Aggregation" },
  { id: "slicing", label: "Slicing" },
  { id: "all", label: "All columns" },
];

/** 1-based column indices each group SHOWS (see MEASURE_HEADERS order). */
export const MEASURE_GROUP_COLUMNS: Record<MeasureColumnGroup, number[]> = {
  // What the measure MEANS: which way is good, in what unit, against what, and
  // how much it matters relative to the others.
  meaning: [1, 2, 4, 5, 8, 11],
  // How it adds up, and over what period.
  aggregation: [1, 3, 6, 7, 11],
  // What it may and may not be broken down by.
  slicing: [1, 9, 10, 11],
  all: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** Which rows the grid shows. Defaults to the unconfirmed ones, because the
 *  job this tab exists for is working DOWN a draft — landing on 12 rows to
 *  read beats landing on 300 of which 288 are already answered. */
export type MeasureRowFilter = "needsReview" | "all";

/** The accepted spellings for the two spec cells.
 *
 *  Constants because the placeholder is no longer always the hint: an empty
 *  cell shows what it INHERITS instead, and the format then has to reach the
 *  tooltip. Two spellings of one grammar drift. */
// The bracket spelling is in the hint because it is the only place the
// exclusive form is discoverable from a text field: the measures grid gives a
// band direction its own two-bound control, but a band on any OTHER direction,
// and every band in a rule, is still typed.
export const TARGET_HINT = "1000 | kpi | measure:Budget | band:0.8,1.2 | band:[0.8,1.2)";
export const MATERIALITY_HINT = "1000 | 2%";

export const NEVER_SLICE_TITLE =
  "Columns this measure must never be broken down by — a slice that is structurally valid but " +
  "semantically misleading (an average sliced by a key, a headcount sliced by an order line). " +
  "The engine cannot detect these, and inference deliberately proposes none, so this list only " +
  "ever comes from a person.";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * What a rule is FOR, in the terms of the thing a person came here to do.
 *
 * The old empty state said "A rule annotates facts in a scope; it never
 * generates one." — true, and unactionable: it names a category, not a job, and
 * a reader who does not already know what a scope is learns nothing from it.
 * The clause about not GENERATING facts survives because it is the one thing
 * people get wrong about rules, but it now comes after the job rather than
 * instead of it.
 */
export const RULE_INVITATION =
  "A rule scopes one answer to part of the model: a direction, a target, a materiality or a " +
  "cadence that applies only to certain members of a column, or only from a certain date — " +
  "leaving every other slice as it was. It annotates the facts inside that scope; it never " +
  "generates one.";
