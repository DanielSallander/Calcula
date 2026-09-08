# The strategy layer, and model-aware insights

Status: building (2026-09-07). Milestones M3a-M3d of the AI programme.
Companion documents: `docs/design/formula-assist.md` (M0/M1, the measurement discipline),
`model-engine-lib/CLAUDE.md` (the engine's own rules).

---

## 1. What this is, and the failure it exists to avoid

"Analyse this data" has shipped three times in this industry — Excel's Analyze Data, Power BI Quick
Insights, Google Sheets Explore — and landed the same way each time: the statistics were correct and
the findings were irrelevant. The reason is structural, not statistical. A tool looking at an
anonymous rectangle of numbers can tell you that column D rose 12% and correlates with column G. It
cannot tell you that D is *Churn*, that a rise in churn is *bad*, that a 12% move is *below the
threshold anyone acts on*, or that the rise is concentrated in one customer segment. So it says the
true, useless thing.

Calcula has something those three did not have at the point of analysis: a **semantic model**. A
measure knows its own definition. A relationship knows its cardinality. A date table is marked as
such. That already removes most of the guessing. What it still does not carry is **business
direction** — whether up is good, what counts as a material move, what to slice by, what to never
slice by. That is what the strategy layer adds, and it is the whole difference between a statistics
report and an answer.

## 2. The governing invariant

> **Structured fields may influence which facts are generated and how they are ranked.
> Prose may only influence wording.**
>
> **Rules annotate facts. They never generate them.**

This is not style guidance. It is the property that makes the feature trustworthy, and it is pinned
by tests rather than by review:

- `Rule` has no field that can carry a value or assert something about the data. Its `set` is an
  `AttributeSet` containing exactly the overridable attributes. This is enforced by the type, so a
  rule that says "revenue was up because of the new pricing" is not something the schema can express.
- A source-scan test asserts that no code path under `insights/` reads a `context` or `note` field
  except the narrator. Prose reaches the sentence. It never reaches fact selection.
- Every attribute that influenced a fact is recorded with its source, so "why does it think a rise
  here is bad?" always has a named answer.

The reason to be this strict: the moment a rule can assert a fact, the pane stops being a computed
answer and becomes a place where someone wrote down what they wanted the data to say. Once that is
possible anywhere, a reader has to distrust every card.

## 3. Layering, and why it is two crates

| Layer | Location | Knows about |
|---|---|---|
| Statistics and narration | `core/insights` | `f64` series, `Subject`s, thresholds. Nothing named. |
| Planner, strategy, report | `app/src-tauri/src/insights/` | `DataModel`, measures, the query engine. |

`core/` and `model-engine-lib/` are deliberately separate Cargo workspaces — the BI engine's
DataFusion dependency tree is kept out of `core/`. So the statistics live in `core/insights`
(depending only on `engine`) and everything that names a measure lives in the app crate, which
already depends on `bi-engine`.

The practical payoff is that the statistics are testable without a query engine in sight. A trend
test seeds a `Vec<f64>` and asserts a slope. That test runs in milliseconds and cannot be broken by
a DataFusion upgrade.

## 4. Two paths, one pane

A workbook with no semantic model still gets an answer. `analyze_range` profiles a rectangle of
cells: region detection, column kinds from the *style* rather than the value, trend, change points,
seasonality, outliers, correlations, dominance, hygiene. Hidden rows are excluded, large regions are
sampled, and "Nothing stands out in this range" is a permitted and correct answer.

A workbook with a model gets `analyze_model`, where the unit of analysis is a **measure** rather
than a column. That is the substantive difference, and it buys four things a column cannot give:

1. **Additivity is declared.** A share-of-total claim about a ratio is arithmetic nonsense. The
   strategy says which measures are additive, so the engine knows when it is allowed to attribute a
   delta across members and when it must say "moved from X to Y in member M" with no share claim.
2. **Definitional decomposition is exact.** `Margin = Revenue - Cost` is an AST, not a guess. When
   margin falls, the engine can attribute the fall to its own terms with zero residual, and say
   "Margin fell 4.1; Revenue rose 2.0 and Cost rose 6.1". For a ratio it does a first-order
   attribution and *states the residual* rather than hiding it.
3. **Dimensions are the slicing axes.** Related dimension tables give real attributes to decompose
   by, and their columns have roles, so a primary key is never offered as an analysis axis.
4. **Direction is known.** Churn rising is unfavourable. Retention rising is favourable. Headcount
   rising is neither, unless a rule says otherwise for one department.

The pane offers both when both apply.

## 5. What the verification against the repo changed

The plan was written against eight assumptions; all eight were checked against the code before any
of this was designed. Three came back partial, and each one changed the design rather than being
worked around.

**Multi-hop decomposition is out.** The query executor refuses relationship paths longer than one
hop, in three separate places. Making it traverse is a large, correctness-sensitive project — every
hop needs a fan-out guard. So v1 decomposes only by attributes of dimension tables *directly*
related to the measure's fact table, and a snowflaked attribute is reported as
`unreachable-in-v1` rather than silently skipped. A user who asks why their subcategory breakdown is
missing gets an answer instead of an absence.

**Column roles have to be inferred, and with less to go on than this document first claimed.**
There is no `is_key`, no table kind, and **no column statistics anywhere in the engine or the app**.
An earlier draft of this section described inference as using "a computed cardinality" with
host-side Arrow statistics and a grouped-query fallback. None of that was built, and it should not
be read as a description of the code: inference runs on every model open, and one grouped query per
column is not something it may do.

So roles come from declared metadata only — relationship participation, data type, `is_hidden`,
the marked date table, `sort_by_column`, `date_role` and name patterns — and everything it produces
is written `reviewed: false` for a person who *can* see the data to confirm.

The absence bites in a specific place, found by review on 2026-09-08. A real warehouse's
`dim_date` carries `year`, `quarter`, `month` and `day` as `Decimal`. They are unambiguously
analysis axes, and an inference that admits an axis only on a data-type allowlist discarded all
four — the calendar's entire decomposition axis, gone, with no statistic available to rescue it.
The fix is to read what the author already declared rather than to measure: a column with a
`date_role` is a calendar attribute, and on the **marked date table** any non-key, non-machinery
column is one whatever its storage type, because that is what a date table is. A numeric axis on
some *other* dimension — a `Decimal` size on `dim_product` — is still lost, and that one does need
statistics that do not exist.

**There is no per-object annotation slot.** `Measure` and `Column` drop unknown JSON fields on load
(hand-written `Deserialize`, no `flatten`, no `extra`). Adding one would be an engine format change.
`DataModel.extension_data` already exists, is documented to travel wherever the model travels, and
serialises deterministically for signatures. So the strategy is **one JSON document** under
`extension_data["calcula.strategy"]`, keyed by object names. It rides along in `.cala`, in `.calp`,
and through signing, for free, with no format bump.

That last one has a consequence worth stating plainly: because the document is keyed by *names*, a
measure rename must re-key it. That happens inside the same `apply_model_edit` as the rename, so it
is one undo step and cannot half-apply.

## 6. The document

One JSON document. JSON because it is the repo's only precedent for model-adjacent metadata —
there is no YAML anywhere in the tree, and inventing a second serialisation format for one feature
is how a codebase acquires two of everything.

It is written **only** by `bi_model_strategy`. The generic `bi_model_extension_data` command refuses
the `calcula.` prefix by design, which is the right refusal: built-in keys should not be writable by
whatever passes a string. Every struct carries `#[serde(deny_unknown_fields)]`, so a typo is an
error rather than a key that silently does nothing — the failure mode where someone writes
`materialty` and spends a week wondering why their threshold is ignored.

Shape (full schema in the plan, §7.2):

- `model` — the default time axis, fiscal year start, reporting currency, measure priority.
- `measures` — per measure: direction, aggregation (default plus per-dimension overrides), unit,
  target, materiality, cadence, priority, analysis dimensions, never-slice-by, context prose, and a
  `reviewed` flag.
- `tables` — table kind, label column, per-column role and priority, hierarchies.
- `rules` — scoped attribute overrides.
- `periods` — annotations that attach a note to facts whose window intersects them.
- `tests` — inline cases the document must satisfy, run at write time.

The 256 KB per-key cap works out to roughly 800 measure entries. The validator reports the size and
refuses an over-cap write *with the count*, so the limit is legible before it bites.

## 7. Resolution, and the four rules that make it predictable

An attribute is resolved for a measure at a **scope point** — the set of members the fact is fixed
to. A company-level fact has an empty scope point; a fact about department A has `{Department: A}`.

Layering is **base → strategy → rules**, attribute by attribute:

- **Base** is derived from the model itself. A KPI supplies the target and, from the ordering of its
  band **statuses**, the direction. `format_string` supplies the unit. The measure's AST supplies
  the aggregation. The date table supplies the axis.

  This paragraph used to say that KPI bands "can only express higher-is-better", and the code
  believed it: `KpiFacts` kept each band's threshold and threw its status away, then read goodness
  off the *threshold* ordering. But the engine validates that thresholds are strictly ascending, so
  that test was true for every KPI a valid model can hold. Every KPI said higher-is-better, a
  correctly authored churn KPI was **refused** as contradicting itself, and the lower-is-better
  branch was unreachable code. Goodness lives in the status sequence — `OffTrack → OnTrack` as the
  ratio grows is higher-is-better, `OnTrack → OffTrack` is lower-is-better, and anything else
  yields no direction rather than a guess.
- **Strategy** is the measure's own entry.
- **Rules** apply where their scope contains the fact's scope point.

Four rules govern the rest, and each exists because of a specific way this could go wrong:

1. **Most specific wins.** More constrained columns beats fewer.
2. **Ties cannot occur**, because the overlap checker refuses them at write time (§8).
3. **Resolution is attribute-level.** A rule that sets only `direction` leaves `materiality` and
   `aggregation` inherited. Without this, every rule would have to restate everything it did not
   mean to change, and the first person to forget would get a silently wrong threshold.
4. **Mixed direction under aggregation suppresses favourability; it never picks a side.** If a rule
   says growth is good in department A, and the fact aggregates over all departments, then "headcount
   rose" is favourable for A and neutral elsewhere. The honest answer is to report the change with no
   favourability, name the reason, and offer the per-department breakdown. Picking one — either one —
   would be the tool asserting something nobody told it.

## 8. The overlap checker

Rule scopes range over **finite declared members**, which is the reason the schema has no value
conditions in v1. That restriction is what makes conflict detection decidable by enumeration rather
than by hoping.

For every `(measure, attribute)` pair, collect the rules that set it. For every pair of *equal*
specificity, the scopes intersect when, for each column constrained by both, the member lists
intersect (or the date ranges overlap) — and a column constrained by only one side imposes no
restriction. So `{Dept: A}` and `{Region: Nordics}` **do** intersect: a fact at
`{Dept: A, Region: Nordics}` would be ambiguous. Any such intersection is refused at write time,
naming both rules and an example point, until a more specific rule disambiguates.

This is CSS with a linter that actually runs. The complexity is rules² × columns, and rules are few.

The alternative — arbitrary boolean conditions over values — was considered and rejected for v1. It
makes overlap undecidable, which means conflicts surface as a wrong number in a report six weeks
later instead of as an error at the moment someone writes the second rule. If a later version adds
them, the constraints it must satisfy are recorded in the plan: boolean return, declared refs only,
a timeout, an error means the rule does not fire, excluded from the checker but *visibly* flagged,
and provenance marked as unchecked.

## 9. Authoring: never a blank form

A strategy layer that nobody fills in is worth exactly nothing, and a blank form with thirty fields
per measure will not be filled in. So the product is **inference plus confirm-the-default**.

`infer` produces a complete document with every entry marked `reviewed: false`:

- **Direction** from a bilingual name lexicon. Cost, churn, defect, waste, lead time, *kostnad*,
  *avgång* → lower is better. Revenue, margin, profit, retention, *intäkt*, *marginal*, *vinst* →
  higher is better. Everything else neutral.
- **Aggregation from the AST.** Sum and count over a fact column, and `+`/`-` chains of additive
  measures, are additive. Distinct count, average, median, min, max, and any division are not.
  A semi-additive balance becomes last-value on the date dimension. Unknown defaults to
  **non-additive**, deliberately: a wrong "additive" produces a wrong share claim, while a wrong
  "non-additive" merely withholds one. The safe default is the one that says less.
- **Unit** from `format_string`.
- **Table kind and column roles** from relationship participation and declared metadata — not from
  cardinality, which does not exist. Keys are detected from join conditions; a `sort_by_column`
  target such as the `MonthNumber` behind `MonthName` is marked `ignore`, because it is machinery
  rather than an analysis axis; a column on the marked date table is a calendar attribute.
- **Analysis dimensions** ranked by how the workbook actually uses them (§10), then by declaration
  order.

The Strategy tab shows inferred values in an unreviewed style with per-row Confirm and Confirm-all,
the validator's findings inline, and the inline tests with pass/fail. The CLI covers the same ground
for people who prefer typing.

## 10. Usage mining

v1 is **local-only and needs no consent**, because it reads nothing that is not already in the
workbook the user has open: BI pivot definitions, ribbon filters, slicers, saved layouts and charts,
folded into counts of measure × attribute pairs. Saved objects weigh more than transient state.

It is used two ways. It ranks analysis dimensions during inference. And it produces suggestions with
a shape a person can act on: "This workbook slices Gross Margin % by Product[Category] in 3 pivots;
it is not in its analysis dimensions. Add / dismiss / never ask." Dismissals persist in the document
and nothing is ever auto-applied.

Sending aggregates back to an application's author is a separate, later milestone with its own
declaration in the signed manifest, its own consent sentence, and small-count suppression — because
it is the one telemetry-shaped thing in a product that is otherwise local by construction, and it
should be designed as such rather than slipped in.

## 11. Audience overlays — designed, deliberately not built

Different readers want different reports from the same model. The shape this takes is **one base
strategy plus audience overlays**, never N independent strategy documents, and the split is the
whole design.

**Invariant, never audience-scoped:** `direction`, `aggregation`, `unit`, `neverSliceBy`. These are
facts about the measure, not about the reader. Churn is lower-is-better for everyone. If direction
could vary by audience, the same number would be favourable in one person's report and unfavourable
in another's, and when those two people meet, the product has manufactured a disagreement — a
serious failure for a tool whose pitch is a verifiable single source of truth. A case that seems to
need direction to vary by audience is one measure where there should be two.

**Legitimately audience-scoped:** `priority`, measure inclusion, `analysisDimensions` ordering,
`materiality`, `cadence`, and `context` prose. A regional manager wants Region first; a CFO cares
about 100k and a team lead about 5k.

### Why this does not reuse `Scope`, and does reuse perspectives

The obvious implementation — `scope: { audience: "Sales" }` — **cannot be spelled**. A `Scope` key
is a `QualifiedColumn` validated to name a real model column, so an audience key is rejected by the
validator before it reaches the resolver, and forcing it through a synthetic table would also
mis-rank it in the overlap checker, where specificity counts constrained columns.

So audience is a **sibling of scope on `Rule`, one rung above it** — still one document, one
validator, one write gate, one `AttributeSet` payload, so an overlay still structurally cannot
introduce a number. `check_overlaps` buckets by `(measure, attribute, audience)`, so two audiences
never collide with each other, and an audience-tagged rule beats an untagged one at equal
specificity. `AttrSource` grows an audience arm so the resolved output can still answer "who
decided this, and for whom".

**The audience names come from the model's perspectives.** A `Perspective` is `{ name, tables,
columns, measures, description }` — a finite, declared, named subset of model objects, authored
through a real command, a CLI verb and a Model Editor section. That is exactly the enumerable list
the overlap checker needs, it already means "who is this for", and it already answers one of the
audience-scoped attributes outright: *measure inclusion* is what a perspective is. Two parallel
taxonomies for "who is this for" would diverge, so there will be one.

Three things must be true before this is built, and all three are why it is not built yet:

1. **Perspectives fail OPEN.** An unknown or renamed perspective name currently filters nothing —
   correct for hiding fields, and wrong for judging favourability, because an overlay that silently
   vanishes leaves the report rendering and saying the opposite of what its audience agreed. An
   audience name validated against perspectives must therefore be a hard error, and a perspective
   rename must **re-key** the strategy document rather than fall back.
2. **A rule that sets an invariant attribute inside an audience must be refused** by the overlap
   checker — a load-bearing guard, not a lint, proved by a sabotage that reds that one assertion.
3. **Nothing selects an audience today.** There is no "view as" anywhere in the product, so an
   overlay would have no way to apply.

**And the sequencing is the real reason.** Overlays on top of a base strategy nobody has authored
are worth nothing; authoring effort was always the binding constraint on this layer. §9 exists to
make the base fillable. That comes first.

## 12. Honest limits

- **Snowflaked attributes are unreachable** in v1 and say so. The fix is an engine project.
- **Statistics on DirectQuery models** cost one query per column. They are lazy, cached, and
  visibly "computing" rather than silently slow.
- **Queries serialise per connection**, so a long DirectQuery run blocks other BI work on the same
  model. The planner is bounded and cancellable.
- **A KPI's direction is inferred from its band statuses, which nothing validates.** The engine does
  not compute status at all, and it constrains only the thresholds, so a KPI whose statuses run
  `OnTrack → AtRisk → OffTrack` is legal, authorable in the KPIs tab today, and means lower is
  better. The strategy layer reads that sequence; a non-monotonic one yields no direction. A
  strategy `direction` that contradicts the sequence is a validation error naming both.
- **A numeric axis on a non-calendar dimension is still lost.** Declared metadata rescues the date
  table; a `Decimal` column that is really an axis on some other dimension needs the column
  statistics this codebase does not have. It falls to `ignore`, and a person has to say otherwise.
- **Narration stays deterministic until M6.** A model writes no sentence in this feature. When one
  does, it will be structurally checked: every sentence tagged with the fact ids it covers, and a
  sentence citing a number that is not in its cited facts is dropped.
- **The layer is worth zero if nobody fills it in.** Inference plus confirm-the-default is the
  mitigation, and rule expressiveness is deliberately limited to keep the checker honest.
