//! FILENAME: app/extensions/_shared/drillThrough/DrillThroughDefinitionEditor.tsx
// PURPOSE: The ONE editor of a drill-through definition, hosted by the chart's
//          "Drill-through behavior..." dialog and by the pivot's existing one
//          (its 4th radio, "Design query"): name, the shared design-query
//          Monaco editor, the presentation (Table | Chart + mark), the Keep
//          filters box, and the one-line note on what happens at run time.
// CONTEXT: docs/design/model-drillthrough.md 2.9. It does NO IPC of its own:
//          `_shared` has no `activate()` to bind a backend channel, so the
//          model comes in as `biModel` and the dry run goes out through the
//          CALLER's bound `invoke` -- exactly how the shared DesignQueryEditor
//          leaves the model fetch to its parent. The mark list is DERIVED from
//          `@api/chartMarks` (`listChartMarks()` + `getChartMarkMeta(m).label`):
//          a hand-written list would be a second source of truth that never
//          learns a new built-in or a consented custom mark. It offers only
//          the marks the Charts extension says a drill chart can be created
//          with -- asked through the chart store seam (the spec Charts builds
//          for that mark passes the validation `createChart` runs), never a
//          copy of Charts' mark-id rule here -- so a registered `sandbox:`
//          mark, which every run would refuse, is not offered. `readOnly` is a
//          subscriber's view of a publisher's definition (wave3 12.1: a not-code
//          artifact is transparent because it is LISTED): the query is shown as
//          text, every control is disabled, and nothing can be saved.

import React, { useCallback, useId, useMemo, useState } from "react";
import {
  getChartMarkMeta,
  getChartStoreService,
  listChartMarks,
  type DrillPresentation,
  type DrillThroughDefinition,
} from "@api";
import { Checkbox, Dropdown, Field, Input, LT, SegmentedChoice } from "@api/layout";
import { DesignQueryEditor } from "../dsl/pivotLayout/DesignQueryEditor";
import { buildControlHints } from "../dsl/pivotLayout/controlHints";
import type { DesignQueryRequest } from "../dsl/pivotLayout/designQuery";
import type { DryRunSummary } from "../dsl/pivotLayout/draft";
import { TOKENS } from "../lib/themeTokens";
import type { BiPivotModelInfo } from "../components/types";
import type { DrillInvoke } from "./runDrillThrough";

export interface DrillThroughDefinitionEditorProps {
  value: DrillThroughDefinition;
  onChange: (next: DrillThroughDefinition) => void;
  /** The source object's connection (the drill runs against it; the dry run too). */
  connectionId: string;
  /** The connection's model, fetched by the host over its own channel (null while loading or unavailable). */
  biModel: BiPivotModelInfo | null;
  /** The host's bound backend invoker, for the assist's dry run. */
  invoke: DrillInvoke;
  /** A subscriber's view: shown, never editable. */
  readOnly?: boolean;
  /** What the drill runs FROM, as a person would say it ("the chart \"Sales by Category\""). */
  sourceLabel: string;
}

/** The one-line explanation under the query. FILTERS values are member KEYS: the Design-tab wells produce keys too. */
export const DRILL_THROUGH_FILTERS_NOTE =
  "When it runs, the clicked members are added to the query as one FILTERS clause on their member keys " +
  "(FILTERS values are member keys, not labels), and the result opens on a temporary sheet.";

/**
 * The query, connection and title of the probe spec {@link isDrillChartMarkCreatable}
 * asks about: whether a mark can be created does not depend on them, so
 * neutral values stand in (the probe is never run, stored or shown).
 */
const MARK_PROBE = { dslText: "VALUES: [Measure]", connectionId: "drill-mark-probe", title: "Drill through" } as const;

/**
 * Whether a drill-through chart of `mark` can be created -- asked of the
 * Charts extension through the chart store seam: the spec Charts builds for a
 * design query of that mark passes the same validation `createChart` runs.
 * A registered `sandbox:` mark, which the ChartSpec mark pattern refuses,
 * answers false, as does a mark id the pattern cannot hold. No chart store
 * (Charts not loaded): no chart can be created at all.
 */
export function isDrillChartMarkCreatable(mark: string): boolean {
  const store = getChartStoreService();
  if (!store) return false;
  try {
    return store.validateChartSpec(store.buildDesignQueryChartSpec({ ...MARK_PROBE, mark })).length === 0;
  } catch (e) {
    console.warn(`[drillThrough] The Charts seam could not check the mark "${mark}"; it is not offered:`, e);
    return false;
  }
}

/** The mark the Chart presentation starts on: "bar" when it can be created, else the first mark that can, else "bar". */
export function defaultDrillMark(): string {
  const marks = listChartMarks().filter(isDrillChartMarkCreatable);
  return marks.includes("bar") ? "bar" : marks[0] ?? "bar";
}

/** The hint beside a stored mark the Charts seam refuses (listed so it is shown, disabled so it is not picked again). */
export const DRILL_MARK_NOT_CREATABLE_HINT = "cannot be created";

/** One choice of the Chart presentation's mark list. */
export interface DrillMarkOption {
  value: string;
  label: string;
  disabled?: boolean;
  hint?: string;
}

/**
 * The Chart presentation's mark choices, DERIVED from the mark registry:
 * every registered mark a drill chart can be created with
 * ({@link isDrillChartMarkCreatable}), with its label. A `current` mark that
 * is not among them is still listed, so the stored choice is shown rather
 * than lost: under its id when it is not registered here (a custom mark whose
 * library is not loaded), and DISABLED with a hint when the Charts seam
 * refuses it (every run would fail on it).
 */
export function drillMarkOptions(current?: string): DrillMarkOption[] {
  const options: DrillMarkOption[] = listChartMarks()
    .filter(isDrillChartMarkCreatable)
    .map((m) => ({ value: m, label: getChartMarkMeta(m)?.label ?? m }));
  if (current && !options.some((o) => o.value === current)) {
    const label = getChartMarkMeta(current)?.label ?? current;
    options.push(
      isDrillChartMarkCreatable(current)
        ? { value: current, label }
        : { value: current, label, disabled: true, hint: DRILL_MARK_NOT_CREATABLE_HINT },
    );
  }
  return options;
}

type PresentationKind = DrillPresentation["kind"];

const PRESENTATION_OPTIONS: ReadonlyArray<{ value: PresentationKind; label: string; testId: string }> = [
  { value: "table", label: "Table", testId: "drill-through-presentation-table" },
  { value: "chart", label: "Chart", testId: "drill-through-presentation-chart" },
];

export function DrillThroughDefinitionEditor({
  value,
  onChange,
  connectionId,
  biModel,
  invoke,
  readOnly = false,
  sourceLabel,
}: DrillThroughDefinitionEditorProps): React.ReactElement {
  const nameId = useId();
  const [controlHints] = useState(() => buildControlHints());
  // The last chart choice, so Table -> Chart -> Table -> Chart keeps the mark.
  const [lastChart, setLastChart] = useState<Extract<DrillPresentation, { kind: "chart" }> | null>(
    value.presentation.kind === "chart" ? value.presentation : null,
  );

  const update = useCallback(
    (patch: Partial<DrillThroughDefinition>) => {
      if (readOnly) return;
      onChange({ ...value, ...patch });
    },
    [onChange, readOnly, value],
  );

  const setPresentation = useCallback(
    (kind: PresentationKind) => {
      if (kind === value.presentation.kind) return;
      if (kind === "table") {
        if (value.presentation.kind === "chart") setLastChart(value.presentation);
        update({ presentation: { kind: "table" } });
      } else {
        update({ presentation: lastChart ?? { kind: "chart", mark: defaultDrillMark() } });
      }
    },
    [lastChart, update, value.presentation],
  );

  const setMark = useCallback(
    (mark: string) => {
      if (value.presentation.kind !== "chart") return;
      // A new mark drops the old mark's options: they belong to the mark they
      // were written for (the chart dialog's Change Chart Type does the same).
      const next: DrillPresentation = { kind: "chart", mark };
      setLastChart(next);
      update({ presentation: next });
    },
    [update, value.presentation],
  );

  const dryRun = useCallback(
    async (request: DesignQueryRequest): Promise<DryRunSummary> => {
      const view = await invoke<{ rowCount: number; colCount: number } | null>("run_design_query", { request });
      return { rowCount: view?.rowCount ?? 0, colCount: view?.colCount ?? 0 };
    },
    [invoke],
  );

  const currentMark = value.presentation.kind === "chart" ? value.presentation.mark : undefined;
  const markOptions = useMemo(() => drillMarkOptions(currentMark), [currentMark]);
  // A stored mark the Charts seam refuses: shown, greyed, and said in words.
  const refusedMark = markOptions.find((o) => o.value === currentMark && o.disabled === true);

  const presentationOptions = useMemo(
    () => PRESENTATION_OPTIONS.map((o) => ({ ...o, disabled: readOnly })),
    [readOnly],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }} data-testid="drill-through-editor">
      <div style={{ fontSize: 11, color: LT.textSecondary }} data-testid="drill-through-source">
        {readOnly ? `Drill-through from ${sourceLabel} (view only: this definition came with the application).` : `Drill-through from ${sourceLabel}.`}
      </div>

      <Field label="Name" htmlFor={nameId}>
        <Input
          id={nameId}
          value={value.name ?? ""}
          placeholder="Drillthrough"
          disabled={readOnly}
          maxLength={80}
          onChange={(e) => update({ name: e.target.value })}
          data-testid="drill-through-name"
        />
      </Field>

      <Field label="Design query">
        {readOnly ? (
          <pre
            data-testid="drill-through-dsl-readonly"
            style={{
              margin: 0,
              padding: 8,
              minHeight: 60,
              maxHeight: 320,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              fontFamily: TOKENS.monoFont,
              fontSize: 12,
              lineHeight: "18px",
              color: LT.text,
              border: `1px solid ${LT.controlBorder}`,
              borderRadius: LT.radiusControl,
              background: LT.inputBg,
            }}
          >
            {value.dslText}
          </pre>
        ) : (
          <div style={{ minWidth: 0, flex: 1 }}>
            <DesignQueryEditor
              value={value.dslText}
              onChange={(dslText) => update({ dslText })}
              biModel={biModel}
              controlHints={controlHints}
              autoHeight={{ min: 120, max: 320 }}
              assist={{ connectionId, dryRun }}
              assistPlacement="inline"
            />
          </div>
        )}
      </Field>

      <div style={{ fontSize: 11, color: LT.textSecondary }} data-testid="drill-through-note">
        {DRILL_THROUGH_FILTERS_NOTE}
      </div>

      <Field label="Show the result as">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SegmentedChoice<PresentationKind>
            value={value.presentation.kind}
            onChange={setPresentation}
            options={presentationOptions}
            ariaLabel="Presentation"
            testId="drill-through-presentation"
          />
          {value.presentation.kind === "chart" ? (
            <Dropdown<string>
              value={value.presentation.mark}
              options={markOptions}
              onChange={setMark}
              disabled={readOnly}
              ariaLabel="Chart type"
              width={180}
              testId="drill-through-mark"
              optionTestIdPrefix="drill-through-mark-"
            />
          ) : null}
        </div>
        {refusedMark ? (
          <div style={{ fontSize: 11, color: LT.warnFg }} data-testid="drill-through-mark-refused">
            {`The chart type "${refusedMark.label}" cannot be created for a drill-through result: choose another.`}
          </div>
        ) : null}
      </Field>

      <Checkbox
        checked={value.keepFilters !== false}
        onChange={(checked) => update({ keepFilters: checked ? undefined : false })}
        disabled={readOnly}
        label="Keep filters"
        tooltip="Carry the page's filters that reach this visual into the drill-through, beside the clicked members (Power BI's Keep all filters)."
        testId="drill-through-keep-filters"
      />
    </div>
  );
}
