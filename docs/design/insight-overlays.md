# Insight overlays — points of interest drawn on charts, pivots and sheets

Status: DESIGNED 2026-09-17; **IO-0 BUILT 2026-09-17** (§5a records what it found), IO-1..5 open.
A milestone of its own, built in its own session — the owner's decision. **Tier 0 throughout**: no
model computes, places or colours anything here.
Companion documents: `insights-strategy-layer.md` (the engine and the strategy this consumes; §14 is
the consumers), `ai-intent-router.md` (the chat's `analyze` route, which is how a sentence reaches
this), `open-items.md` 2.AI.13.

**Start here, next session.** Read §2 (what exists — the feature is two thirds built already, in
pieces that have never been joined), then §3 (the seven gaps, each a one-line check), then §7 (the
owner decisions; the IO-0 session took the doc's recommended answers without the owner live, so
confirm them before IO-2). IO-0 is BUILT — read §5a for what it found, including the correction
to §4.5 — so the next milestone is IO-1 (§5): indices on every fact kind and the strategy context
on the chart route, in Rust.

## 0. The ask, and the one-sentence answer

> A bunch of charts use a Calcula model, with a strategy. A tool superimposes, onto the charts,
> visual cues that highlight points of interest — the bar with the highest revenue encircled in
> red, or the pivot cell holding the highest revenue marked in yellow.

Everything in that sentence is state the product already holds. "The highest revenue" is a fact the
deterministic insights engine computes (`FactKind::Extremes`, `core/insights/src/types.rs:281`).
"In red" is the strategy's declared direction for the measure (`direction_provenance`,
`app/src-tauri/src/insights/model.rs:518`): for a Cost measure the tallest bar is the thing to worry
about. "Encircled" is a mark drawn at a datum whose pixel position the chart renderer already
computes for hit-testing (`dispatchComputeGeometry`,
`app/extensions/Charts/rendering/chartDispatch.ts:450`). The feature is a fact-to-position mapping
and a renderer. The programme's standing rule decides the tier
(`insights-strategy-layer.md:822`, §14.4): *the engine answers before a model is asked*, and the
lesson recorded from narration applies word for word — never give a 1–3B a job where being wrong is
invisible. An encircled wrong bar is the most invisible wrong answer there is.

## 1. Vocabulary

- **Overlay** — the transient set of cues drawn over a visual. A lens: on or off, never an edit,
  never in the undo stack, never dirtying the document. The transient-write pattern
  (`DocumentEffect::transient`, `app/src-tauri/src/document_effect.rs`; precedents
  `animation_commands.rs`, `scenario_manager.rs`).
- **Cue** — one drawn thing: a ring around a datum, an emphasised bar or cell, a band over a span of
  categories, a rule at a value, a callout carrying the fact's own sentence. A closed vocabulary
  (§4.2); every cue is anchored to DATA (a series, a category index, a value, a pivot member path),
  never to pixels.
- **Annotation** — a cue the user chose to KEEP: written into the chart spec as a `layers` entry or a
  `dataPointOverrides` entry through `updateChartSpec` (`app/extensions/Charts/lib/chartStore.ts:291`),
  which is a document mutation like any other spec edit.
- **Polarity** — good / bad / attention / neutral. Comes from the strategy's direction and the fact
  kind (§4.3), never from the number's sign.
- **Target** — what an overlay is drawn on: a chart, a pivot, or a sheet range.
- **Tier 0** — no model. Tier 1 is the bundled on-board model, Tier 2 the user's own larger model,
  Tier 3 a key. This milestone uses none of them (§4.9 says exactly where one could enter, and why
  it does not now).

## 2. What exists, and is most of the feature

| piece | where | what it gives this milestone |
|---|---|---|
| Twenty fact kinds as NUMBERS, no prose in the fact | `core/insights/src/types.rs:238` | the points of interest: `Extremes`, `SmoothedPeak`, `Outliers`, `ChangePoint`, `Crossover`, `Leader`, `Dominance`, `Pareto`, `Trend`, `Change`, plus hygiene kinds (`Duplicates`, `BlankRows`, `Errors`, `MixedTypes`) |
| Positions inside facts | `types.rs:188` (`OutlierPoint.index`), `:301` (`ChangePoint.at_index`), `:354` (`Crossover.at_index`); labels only in `Extremes` `:281`, `SmoothedPeak` `:288`, `Dominance` `:323` | what a cue is anchored to — see gap 2 |
| A fact's subject: a measure by name, or a column with sheet + range | `types.rs:102` (`Subject`) | series name → which series; column range → which cells |
| Ranking with per-kind caps and dedupe | `core/insights/src/rank.rs:110` (`score`), `:121` (`rank`) | which cues survive when a chart has thirty facts |
| The deterministic narrator and the citation check | `core/insights/src/narrate/en.rs`, `cite.rs` | the callout text, already true by construction |
| "Explain this chart": a chart's RESOLVED series → Rust facts | `app/extensions/Insights/lib/chartExplain.ts:51`; `@api/chartData` `resolveChartSeries` (`app/src/api/chartData.ts:113`); command `insights_for_series` (`app/src-tauri/src/insights/commands.rs:172`) | the chart half of the pipeline, in the right direction: the facts are computed over the chart's OWN categories and series, so a fact's `label`/`index` IS a category index on that chart |
| The chart snapshot: categories in draw order, `categoryKind`, series with `null`-preserving values and per-series evidence | `app/src/api/chartData.ts:33` (`ChartSeriesSnapshot`) | the mapping table from fact to datum |
| The model-aware planner: materiality, direction, additivity, provenance with a "withheld" case | `app/src-tauri/src/insights/model.rs:1` (header), `:518` (`direction_provenance`) | polarity, and the honesty rule for it: a suppressed direction yields NO polarity, not a guess |
| Provenance on the wire: `{attr: "direction", value: "higherIsBetter" \| "lowerIsBetter" \| "withheld: …", source}` | `app/src/api/insightsService.ts:41`; `app/src-tauri/src/insights/wire.rs:297` (pinned field names) | the one field a cue's colour is allowed to read |
| The strategy summary the frontend already holds per connection | `app/src/api/designQueryAssist/types.ts:34` (`DesignMeasureHints.direction`, `analysisDimensions`, `neverSliceBy`), `:47` (`DesignStrategySummary`); cached per connection by `@api/biModelFields` | measure order for "which measure's cues first", `neverSliceBy` for "no cue on that breakdown" |
| Chart `layers`: a layer is a chart type, a `rule` (reference line) or a `text` annotation; text is anchored to `x: category index`, `y: data value` | `app/extensions/Charts/lib/chartSpecSchema.ts:120` (`layers`), `:736` (`TextMarkOptions`), `:751` (`LayerSpec`); painted at `chartDispatch.ts:128` | the persisted form of a kept callout or rule — data-anchored already |
| Hit geometry for every datum of every mark | `chartDispatch.ts:450` (`dispatchComputeGeometry` → `HitGeometry`: bar rects, composite groups, points) | the pixel position a ring is drawn at; also solves stacked, grouped and composed charts, because the painters already did |
| Per-datum visual overrides in AUTHORING space, with kept-index maps for filtered charts | `app/extensions/Charts/lib/dataPointOverrides.ts:16` (`toAuthoringIndices`), `:31` | the persisted form of a kept emphasis; and the warning that painter indices ≠ authoring indices when a filter ran |
| Chart data sources: `range`, `pivot`, `designQuery{dslText, connectionId}`, `concat` | `chartSpecSchema.ts:218`; `chartData.ts:30` | a design-query chart KNOWS its connection and its measures, so the strategy is reachable for it |
| Chart invalidation on data change | `app/extensions/Charts/lib/chartInvalidation.ts` | when an overlay must be dropped or recomputed |
| Pivot cells carry a member path: `groupPath: [fieldIndex, valueId][]` | `app/src/api/pivotTypes.ts:271` (`PivotCellData`), `:284` | the address of "the cell where West × Revenue is" |
| The pivot facade: `getView`, `getAtCell`, `getRegionsForSheet`, `getFieldUniqueValues`, … | `pivotTypes.ts:1113` (`PivotApi`) | member label → valueId, cell → coordinates; no highlight method yet (gap 5) |
| Grid overlay regions (pivots render inside one) and per-cell decorations with an "over-selection" anchor for indicator chrome | `app/src/api/gridOverlays.ts:22`; `app/src/api/cellDecorations.ts:15`, `:53` | the sheet-cell form of a cue, and the pivot's own paint surface |
| The Insights pane: cards with a "why" (provenance) and evidence clicks that select a range | `app/extensions/Insights/components/InsightCard.tsx:16`; `InsightsPane.tsx:183` (`revealEvidence`) | the list the overlay is the visual of — one bundle, two views |
| The chat's `analyze` route and Tier-0 pre-route | `ai-intent-router.md` §6; `AIChat/lib/tierZero.ts` | "show me where we lost money" reaches the same bundle |
| The seam rule and its precedents | `chartParams.ts`, `chartData.ts`, `chartContextMenu.ts`, `pivot.ts` | the shape of the two new seams (§4.6): Charts and Pivot implement, Insights consumes, nobody imports anybody |

## 3. The gaps, found by reading rather than running — each a one-line check

1. **The chart path is strategy-blind.** `insights_for_series` builds a dataset and runs the plain
   analyser (`commands.rs:186-190`): no direction, no materiality, no provenance. A Cost chart's
   peak is reported as a peak, never as the worst month. The model route has all three gates
   (`model.rs:17-33`); the chart route has none. For a design-query chart the connection and the
   measures are in the spec, so the strategy is reachable — it is simply not asked.
2. **Most facts point by LABEL, not index.** `Extremes` carries `best_label`/`worst_label`,
   `SmoothedPeak` `peak_label`/`trough_label`, `Dominance` `top_category`; only `ChangePoint`,
   `Outliers` and `Crossover` carry an index. A chart whose categories repeat (`Jan … Dec` over two
   years) makes a label ambiguous. Check: `grep -n "_label: String" core/insights/src/types.rs`
   against `grep -n "_index: usize"`.
3. **There is no datum-anchored point mark.** Layers are a chart type, `rule` or `text`
   (`chartSpecSchema.ts:758`). Nothing draws a ring around one bar or one point. Text is anchored
   the right way (category index + value), so the primitive is missing, not the anchoring.
4. **A series fact has no click target.** The command's own comment: "every fact's evidence is the
   series itself" (`commands.rs:188-189`); a `query` evidence renders as text because the pane has
   "no pivot-opening path" (`InsightCard.tsx:16-18`); only `range` evidence selects anything
   (`InsightsPane.tsx:183`). The pane can SAY "peaks in March" and cannot point at March.
5. **A pivot cell can be addressed and cannot be emphasised.** `groupPath` names the cell;
   `PivotApi` (`pivotTypes.ts:1113-1152`) has no method that marks one. The pivot paints its own
   cells inside a grid overlay region, so the grid's `cellDecorations` do not reach them.
6. **Every chart visual state is persisted state.** `dataPointOverrides` and `layers` live in the
   spec; `updateChartSpec` is a document mutation. There is no transient visual channel for a chart
   the way a `TransientScope` gives one to a simulation. An overlay written through the spec would
   dirty the document and enter undo — the thing the transient-write pattern exists to forbid.
7. **Member labels are not member ids.** A model fact says "West"; the pivot cell says
   `[fieldIndex, valueId]`. Resolving one to the other needs `getFieldUniqueValues` per field, and
   a label that occurs in two fields (a "Total" member, a region and a country both called
   "Georgia") needs the fact's dimension, which `Dominance`/`Pareto` carry as `category` and
   `Leader` does not.

## 4. The design

### 4.1 The pipeline, and where each stage already lives

```
target (chart | pivot | range)
  → facts        existing routes: insights_for_series / insights_analyze_model / insights_analyze_range
                 + IO-1: strategy context on the series route for design-query charts
  → cues         IO-2: pure @api module: (bundle, snapshot | pivot view) -> Cue[]; ranking, caps, polarity
  → placement    IO-2/3/4: fact anchor -> datum (series, category index) | pivot cell | sheet cell
  → render       IO-3/4: transient store per target; Charts / Pivot / grid paint it; never the spec
  → keep         IO-3: "Keep as annotation" writes layers + overrides through updateChartSpec
```

One bundle feeds both the pane's cards and the overlay's cues; the overlay is a second VIEW of the
same facts, never a second computation. That is the invariant every test in §6 leans on: a cue that
cannot be traced to a fact id in the bundle is a defect.

### 4.2 The cue vocabulary — closed, data-anchored

```ts
interface Cue {
  factId: string;                     // always; the traceability invariant
  kind: "ring" | "emphasis" | "band" | "rule" | "callout";
  polarity: "good" | "bad" | "attention" | "neutral";
  anchor:
    | { type: "datum"; series: string; categoryIndex: number }          // ring, emphasis, callout
    | { type: "span"; series?: string; from: number; to: number }        // band (category indices)
    | { type: "level"; series?: string; value: number }                 // rule (a data value)
    | { type: "pivotCell"; groupPath: [number, number][]; valueField: string }
    | { type: "cell"; sheetIndex: number; row: number; col: number };
  label?: string;                      // the fact's own deterministic sentence, or a short form of it
  rank: number;                        // the engine's score; decides which survive the cap
}
```

Five kinds, and no sixth without a measured reason. Pixels never appear: the renderer turns a
datum into a rect or a point through the mark's own geometry, so a ring on a stacked bar, a grouped
bar, a line point or a pie slice is the mark's problem, already solved for hit-testing.

### 4.3 Which facts become which cues, and their polarity

| fact | cue(s) | polarity |
|---|---|---|
| `Extremes` | `ring` on best, `ring` on worst | best → good, worst → bad **when a direction is declared**; both → neutral otherwise |
| `SmoothedPeak` | `ring` on peak and trough | as above |
| `Outliers` | `ring` on each point (≤ 5), optional `rule` at each fence | attention |
| `ChangePoint` | `rule` at `at_index` + `band` from `at_index` to the end | attention |
| `Crossover` | `ring` at `at_index` on both series | neutral |
| `Leader`, `Dominance` | `emphasis` on the top category | good when direction is higherIsBetter, else neutral |
| `Pareto` | `band` over the top-k categories | neutral |
| `Trend` | `callout` at the last point | rising/falling × direction → good/bad; flat → neutral |
| `Change` | `callout` at the last point | pct × direction, materiality already gated in `model.rs` |
| `Correlation`, `Seasonality`, `Shape`, `*Summary` | no cue on a visual (nothing to point at) | — |
| `Duplicates`, `BlankRows`, `Errors`, `MixedTypes` | `emphasis` on the cells, sheet target only | attention |

**The polarity rule is the honesty rule from `model.rs`, restated for colour:** a fact whose
provenance carries `direction: withheld: …` gets a NEUTRAL cue and a label that says the direction
was withheld. A chart with no strategy at all (a range chart, a pivot chart with no connection) gets
neutral cues and a one-line notice saying so. Red is never inferred from a falling number.

**Colour and shape together.** Good = green solid ring, bad = red solid ring, attention = amber
dashed ring, neutral = the theme's accent, dotted. Shape carries the meaning where colour cannot
(the colour-blind reader), and the label always names it. Palette from the theme tokens, never
literals — the appearance policy applies.

**Caps.** At most three cues per chart by default, taken in the engine's rank order; the pane shows
the rest with a "show" toggle per fact. Clutter is how a reader learns to ignore the whole overlay
— the same lesson as the next-edit row nagging 49 of 49 times.

### 4.4 The strategy on the chart path (gap 1)

`insights_for_series` gains an OPTIONAL strategy context: `{ connectionId, measures: [{ series,
measure }] }`, filled by the Charts provider for a `designQuery` source from the compiled DSL (it
already knows which series is which measure). With it, the command resolves each named measure the
way `model.rs` does — direction, materiality, additivity, suppression — and attaches the same
provenance the model route attaches; without it, the route behaves exactly as today. Facts about a
Cost series then carry `direction: lowerIsBetter`, and the polarity table above does the rest. This
is not a second planner: `ResolvedMeasure` and `direction_provenance` are reused; the only new code
is the lookup from series name to measure and the plumbing of the optional field across the wire
(`wire.rs`'s field-name test is the guard).

### 4.5 Placement — the mapper (gaps 2, 4, 7)

- **Chart.** Series by NAME (indices shift when a series is hidden; names do not). Category by
  painter-space INDEX — **corrected by IO-0**: the snapshot `resolveChartSeries` returns is built
  from the reader's RESOLVED data, i.e. painter space after filters, so an index taken from it is
  already the painter's index and the kept-index maps are NOT walked for drawing (they are walked
  only in reverse for keep-as-annotation, IO-3, because `dataPointOverrides` are authoring-space).
  The case that bites on a filtered chart is the opposite mistake — an authoring-space index — and
  the label check catches it (`cuePlacement.test.ts`, "an authoring-space index would land on
  Apr"). Category by INDEX where the fact carries one; by label otherwise, and IO-1 adds an index
  to every kind that lacks one so label lookup becomes a check, not the mechanism. A cue is
  VALIDATED before it is drawn: the label at the resolved index must equal the fact's label, or the
  cue is dropped and the pane says the chart changed. The overlay is recomputed on the chart's
  invalidation event and cleared when the chart's series set changes shape.
- **Pivot.** Fact dimension + member label → `[fieldIndex, valueId]` through `getFieldUniqueValues`;
  measure → the value column; the pair → the cell's `groupPath`, found in the current view
  (`getView`). A label the field does not contain, or one that resolves in two fields, produces NO
  cue and a note — never a guess.
- **Sheet.** A column subject's `RangeRef` plus a row offset (outlier `index` is a position within
  the analysed series, `types.rs:189`, so the header offset is applied once, in one function, with a
  test on a header-less range).

### 4.6 Rendering, and the two seams (gaps 3, 5, 6)

- **`@api/chartCues.ts` (new seam, the `chartParams` shape).** `setChartCues(chartId, cues)`,
  `clearChartCues(chartId)`, `getChartCues(chartId)`, `onChartCuesChanged(cb)`. A TRANSIENT store —
  keyed by chart id, never written into the spec, cleared on document open/new like every
  document-scoped store (the §2w lesson). Charts implements a "cues" paint stage after `layers`
  (`chartDispatch.ts:128-147` is the insertion point) that resolves each anchor through
  `dispatchComputeGeometry` and draws rings, emphasis, bands, rules and callouts. Charts owns HOW a
  ring looks on a pie slice; Insights says WHAT.
- **`@api/pivot` gains `setCellEmphasis(pivotId, emphases: PivotCellEmphasis[])` and
  `clearCellEmphasis(pivotId)`**, transient, implemented by the Pivot extension's own grid painter.
  Same discipline: Insights hands over `groupPath` + polarity + label, Pivot decides the fill.
- **Sheet cells** use the existing `cellDecorations` pipeline with the `"over-selection"` anchor,
  registered by the Insights extension for range facts — no new seam.
- **Keep as annotation.** A ring becomes a new `marker` layer (`mark: "marker"`, `markOptions: {
  series, x: categoryIndex, shape: "ring", color }`) — the one addition to `LayerSpec`, anchored
  exactly as `text` is; an emphasis becomes a `dataPointOverrides` entry (authoring-space indices);
  a callout becomes a `text` layer; a rule becomes a `rule` layer. Written once through
  `updateChartSpec`, so undo, dirty flag and persistence are the spec's own. Pivot keep is out of
  scope for the first milestone (§7, D-IO-4).

### 4.7 Where it starts, and what it says

- Chart context menu: **"Show points of interest"** beside "Explain this chart"
  (`chartExplain.ts:104` is the registration to mirror). Pivot context menu: the same. The
  Insights pane: every card gets **"Show on chart / pivot / sheet"** — which replaces the dead
  `query` evidence text — and the pane header gets a master toggle for the overlay.
- The overlay carries a one-line notice, per §14.4's "the app says which tier it used":
  *"3 points of interest, computed from the model's strategy — not guessed."* With no strategy:
  *"… computed from the numbers; no strategy declares which way is good."*
- Cues clear on toggle, on data change, and on document open/new. They are never saved unless kept.

### 4.8 The chat

The `analyze` route already computes the Tier-0 bundle before the model sees the message
(`ChatView` pre-route). A tool `show_points_of_interest({ chartId | pivotId })` in the `analyze` and
`chart` specialists lets "show me where we lost money on this chart" end in an overlay rather than a
paragraph. Read-only, auto-run, no confirmation: it changes nothing in the document. Last milestone
(IO-5), because it is wiring, not the feature.

### 4.9 Tier, stated once

Tier 0 for facts, polarity, placement, rendering and the callout text. Two places a model could
enter, and why not now: (a) rewording the callout — that is M6 narration, measured on the 1.5B at
56 % invented numbers, so the callout stays the narrator's sentence; a Tier 2/3 model may reword it
behind `cite.rs` later without touching this design; (b) the request in words — the router is Tier
0 and the model is the conversational wrapper, never the judge of which bar. If a later fact kind
seems to need judgement ("is this interesting?"), the answer is a new deterministic threshold in
`core/insights`, with a test, not a model.

## 5. Milestones — each measured before the next, in this order

- **IO-0 — the placement spike (1 day).** A hidden developer command draws a ring around
  `Extremes.best` on the selected chart from an existing bundle, through the geometry hook, on a
  bar, a stacked bar, a grouped bar, a line and a pie. Exit: the ring lands on the right datum in
  the chart fixtures the determinism suite already renders (`chart-determinism.test.ts`,
  `chart-edge-cases.test.ts`), including a FILTERED chart (the kept-index case). This is the only
  genuinely new thing in the milestone; if it fights back, everything after it is redesigned first.
- **IO-1 — facts with positions, and the strategy on the chart path (Rust).** Indices on
  `Extremes`, `SmoothedPeak`, `Dominance` (and a `category` on `Leader`); the optional strategy
  context on `insights_for_series` (§4.4); the `wire.rs` field-name test extended; `core/insights`
  unit tests for every changed kind; the narration fixtures still narrate every kind
  (`every_fact_kind_has_a_fixture`).
- **IO-2 — cues (pure TypeScript, `@api/insightCues.ts`).** `cuesFor(bundle, target) -> Cue[]`,
  the table in §4.3 as data, polarity from provenance, ranking and caps, the validation rule from
  §4.5. Tests: every fact kind in the insights fixtures maps to the expected cue kind; the
  **harmful-cue gate** — no cue may anchor to a datum the fact does not name; determinism; the
  withheld-direction case yields neutral.
- **IO-3 — chart overlay.** The `@api/chartCues` seam, the Charts paint stage, the transient store
  with document-scope reset, invalidation, the context-menu entry, the pane's "Show on chart", the
  notice, and keep-as-annotation with the new `marker` layer. Visual E2E snapshots of a chart with
  and without its overlay (comparator at 0.02 — the retuned threshold, never 0.2).
- **IO-4 — pivot and sheet targets.** `setCellEmphasis` on the pivot seam and its painter, member
  resolution through `getFieldUniqueValues`, the sheet decoration for range facts, the pivot
  context-menu entry, the pane's "Show on pivot / sheet". E2E on the sales-star fixture.
- **IO-5 — the chat tool, the records.** `show_points_of_interest` in the `analyze` and `chart`
  specialists (with the specialists test's reachability rule), `insights-strategy-layer.md` §14.8,
  `open-items.md` 2.AI.13 closed, memory.

## 5a. IO-0 — what was built, and what the spike found (2026-09-17)

The ring lands on the right datum, and nothing after IO-0 needs redesign. What exists now:

- **`@api/chartCues.ts`** — the seam, ahead of IO-3's schedule because the spike needed a channel
  the spec never sees: `setChartCues` / `clearChartCues` / `clearAllChartCues` / `getChartCues` /
  `listChartsWithCues` / `onChartCuesChanged`. A frozen-copy store keyed by chart id. `ChartCue` is
  `{ factId, kind: "ring", polarity, anchor: { type: "datum", series, categoryIndex, categoryLabel },
  label? }` — the §4.2 shape narrowed to what IO-0 draws, plus `categoryLabel` on the anchor so the
  painter can validate. Cleared by Charts on `AFTER_OPEN` / `AFTER_NEW` (`reloadCharts`), on chart
  delete (`removeChartFromCache`) and on deactivate. Test: `app/src/api/__tests__/chartCues.test.ts`.
- **`Charts/rendering/cuePainter.ts`** — `resolveCueTarget(geometry, anchor, ctx)` is PURE:
  (series name, painter category index) → the `BarRect` / `PointMarker` / `SliceArc` from the hit
  geometry, refused with a reason (`no-such-datum` | `label-mismatch` | `series-not-drawn`) when
  the datum's own label differs from the fact's or when a pie is asked about a series it does not
  draw. Composite geometry (combo, pareto, repeat, facet) is searched group by group, so small
  multiples work with no special case. `paintChartCues` draws an ellipse round a bar, a circle round
  a point, an arc along a slice's outer edge; colour AND dash per polarity (`CUE_STYLES` — literals
  for now, IO-3 binds them to skin tokens).
- **The paint stage is at COMPOSITE time**, in `chartRenderer.ts` `renderChart` step 3a, over the
  cached raster through `chartDataCache.hitGeometry` — where selection highlights and tooltips are
  drawn — and NOT inside `dispatchPaint` as §4.6 first suggested. Reasons: a cue change is then a
  `requestOverlayRedraw`, not a raster re-render; the lens never reaches `chartExport` or the
  capture surface, which is what "never an edit" means for a PNG; and `dispatchPaint` has no chart
  id. IO-3 keeps this unless export of the overlay is asked for.
- **`Insights/lib/cuePlacement.ts`** — `ringsOnBest(bundle, snapshot)`: reads `factsJson` (the
  numbers Rust kept, keyed by the pane's own ids) for `extremes` facts and anchors each at its
  `bestLabel`. Three refusals before a cue exists: the series must be in the snapshot, the label
  must occur EXACTLY once among the categories (the Jan..Dec-over-two-years case, gap 2), and the
  snapshot value at that index must equal the fact's `best`. Every refusal is returned with the
  fact id and a reason; nothing is guessed. IO-2 grows this into `@api/insightCues` with the §4.3
  table.
- **The hidden command** `insights.dev.ringBestOnSelectedChart` (`Insights/lib/chartCueSpike.ts`):
  resolves the selected chart, runs the SAME request "Explain this chart" runs
  (`seriesRequestFrom`, now shared), maps, sets the cues; a second invocation clears them. No menu,
  no button, by design — the user surfaces are IO-3's.
- **Tests** — `Charts/rendering/__tests__/cuePlacement.test.ts` (20): grouped bar, stacked bar (the
  Cost SEGMENT of the Mar stack, not the Sales one), horizontal bar, line (smallest `cy`), pie
  (largest `percent`), small multiples (the Cost panel's cell), the FILTERED chart in both
  directions, refusals, determinism, and the stroke coordinates translated by the chart's canvas
  origin. `Insights/__tests__/cuePlacement.test.ts` (10): the mapper and each refusal. Both guards
  were SABOTAGED (label check removed; ambiguity check disabled) and each reddened exactly its own
  assertions — 4 of 30 — and nothing else.

Found on the way, and worth the record:

- **The determinism suite's `stacking: "stacked"` is a no-op.** The bar painter reads
  `markOptions.stackMode`; the top-level `stacking` field in `chart-determinism.test.ts`'s
  `makeSpec` stacks nothing, so that suite has been pinning GROUPED geometry under a "stacked"
  name. Harmless for determinism, misleading as a fixture; the cue test sets `markOptions`.
- **Sampled snapshots are a known hole.** Above `CHART_SERIES_MAX_POINTS` the snapshot is
  stride-sampled, so a snapshot index is no longer a painter index; the label check will refuse
  every such cue rather than misplace one. IO-2 should have the snapshot carry its sample indices
  (one optional field on `ChartSeriesSnapshot`) so the mapper can translate instead of refuse.
- **A pie's `SliceArc.seriesIndex` is the slice (category) index**, and the pie draws only
  `series[0]`; the resolver takes the painter's series names as context for exactly that reason.

## 6. Verification — the standard this repository holds a milestone to

- Every rule in §4.3 is a unit test; the harmful-cue gate and determinism are CI tests over the
  insights fixtures; every new guard is SABOTAGED and the sabotage shown to red the right assertion.
- `cargo test -p insights` and the app crate's insights tests for IO-1; full vitest, `check-types`,
  `lint:boundaries`, `check:line-endings` on every milestone; the seams pass `lint:boundaries`
  because Charts and Pivot implement and Insights consumes.
- Visual E2E for IO-3 and IO-4; then a LIVE proof on a real model-backed chart and pivot — the
  router milestone's lesson holds: the defects that matter came from the live proof and the salvage
  harness, not from the build.
- A cue that appears with no fact behind it, on a datum the fact did not name, with a polarity no
  provenance justifies, or after the chart's data changed underneath it, is a defect of the first
  order — it is the encircled wrong bar.

## 7. Owner decisions to take at the start of the session

- **D-IO-1 — the cue vocabulary and its look.** Five kinds as in §4.2, colour + shape as in §4.3?
  Or fewer for the first milestone (ring + callout only)?
- **D-IO-2 — the cap.** Three cues per visual by default, the rest behind per-fact toggles?
- **D-IO-3 — charts without a strategy.** Neutral cues plus the notice (the design's answer), or no
  overlay at all until a strategy exists?
- **D-IO-4 — keeping a pivot cue.** Out of scope for the first milestone (a kept pivot emphasis is a
  persisted cell style with a new backing store); charts only until asked.
- **D-IO-5 — the entry points.** Context menu + pane (the design), plus a ribbon toggle?
- **D-IO-6 — outlier fences.** Draw the two `rule`s, or rings only?
- **D-IO-7 — the chat tool.** Auto-run and unconfirmed (it is read-only), as designed?

## 8. Risks, and what answers each

- **Clutter** → the cap and the rank order; the pane keeps the long list.
- **Stale cues after the data changed** → validation before drawing, recompute on invalidation,
  clear on shape change; a stale ring is a lie.
- **Ambiguous labels** → indices on every kind (IO-1); label equality as a check.
- **Stacked, grouped, percent, composed charts** → the mark's own geometry, proved in IO-0 before
  anything else is built.
- **Pie, donut, treemap, sunburst** → a ring is meaningless; emphasis on the slice is the cue, and
  Charts decides that per mark.
- **10,000-point charts** → the snapshot cap already samples (`CHART_SERIES_MAX_POINTS`); a cue on a
  sampled index is validated by label or dropped.
- **Colour-blind readers** → shape carries polarity; the label names it.
- **Two views disagreeing** → one bundle, one id per fact, the traceability invariant.

## 9. What this is not

Not anomaly detection by a model — every point of interest is a thresholded deterministic fact with
a test behind it. Not Power BI's "explain the increase" — that is decomposition, which `model.rs`'s
contributions already compute for a measure and could become a cue kind later, deterministically.
Not narration — the callout is the narrator's own sentence, already checked. No model, no tier
above zero, by design and by the evidence.
