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
- Prose reaches the sentence and never fact selection. **This one is currently true by absence
  rather than by guard, and the distinction matters.** `MeasureStrategy.context` is copied into
  `ResolvedMeasure.context` (`strategy/resolve.rs`) and read by *nothing* — its consumer is M6's
  narrator, which is deferred. So there is no source-scan test, because there is as yet no reader to
  constrain. Earlier revisions of this section claimed such a test existed; it did not. Write it
  when M6 gives prose a reader — a guard over a field nothing reads is the same inert-surface defect
  one level up.
- Every attribute that influenced a fact is recorded with its source, so "why does it think a rise
  here is bad?" always has a named answer.

The reason to be this strict: the moment a rule can assert a fact, the pane stops being a computed
answer and becomes a place where someone wrote down what they wanted the data to say. Once that is
possible anywhere, a reader has to distrust every card.

### The second rule: nothing becomes authorable until it has a reader

> **A field is not shipped when it round-trips. It is shipped when something READS it.**

Added 2026-09-08, after a review found five attributes — `unit`, `cadence`, `fiscalYearStart`,
`reportingCurrency` and `TableStrategy.kind` — that were authored, inferred, validated, resolved,
and consumed by nothing. `kind` was the expensive one: it renders as an editable dropdown on every
table row and gates the entire time-series cascade, so a user who saw calendar detection get it
wrong and *corrected it* changed nothing, silently.

The cost is not the dead code. **Authoring effort has been the binding constraint on this layer
from the start** (§9 exists for that reason alone), and an unread field spends that budget for
nothing while looking exactly like a field that works. The layer was growing faster than the engine
consuming it, and that gap — not the count of unread fields — is the thing to watch.

Practically: a new attribute lands with its consumer in the same change, or it does not land. When
a reader genuinely has to come later, the surface says so where the person is *typing* — the
"not yet consulted" label on `fiscalYearStart`, and the marked column headers on `unit` and
`cadence` — rather than being recorded only in a design document the author will never read.

**The rule has three branches, not two.** `reportingCurrency` was DELETED under it, and that was
right: no consumer, none coming, and typing it had only made it a stricter decoration. But "wire it
or delete it" is too narrow for a field with no *engine* consumer that a user's own tooling might
read. §13 adds the third branch — **move it to the extension namespace** — whose guarantee is
round-trip fidelity rather than consumption. That is a deliberate, narrow carve-out from this rule,
and it applies only inside the namespace.

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
- **Unit** from `format_string` first, then the name. An integer-only format like `#,##0` is what a
  currency measure wears about as often as a tally does, so reading it as a count made a measure
  named *Revenue* infer as `Count`. An explicit signal — a `%`, a currency bracket — still wins
  outright; the name only breaks the tie the format left. It is decided in **one** place,
  `facts.rs`, because `MeasureFacts.unit` is also the resolver's base layer: a second lexicon in
  `infer` would have fixed the drafted document and not the model that has no document at all.
- **Table kind and column roles** from relationship participation and declared metadata — not from
  cardinality, which does not exist. Keys are detected from join conditions; a `sort_by_column`
  target such as the `MonthNumber` behind `MonthName` is marked `ignore`, because it is machinery
  rather than an analysis axis; a column on the marked date table is a calendar attribute.
- **Analysis dimensions** ranked by how the workbook actually uses them (§10), then by declaration
  order.

The Strategy tab shows inferred values in an unreviewed style with per-row Confirm and Confirm-all,
the validator's findings inline, and the inline tests with pass/fail. The CLI covers the same ground
for people who prefer typing.

### What a name heuristic can and cannot carry

Several of the rules above are name lexicons, and it is worth being explicit about the ceiling they
share, because it is not obvious from any one of them.

**A name heuristic generalises exactly as far as its naming conventions do.** They are written and
tested against one spelling — `PascalCase`, usually, because that is how a hand-built fixture reads
— and an imported SQL schema arrives in another. The word splitter cannot break an all-lowercase
run, so `emailaddress` is one token: `email` does not match it, and neither does `name` match
`fullname`. Two independent rules fail together on the same input, and the symptom is not an error
but a plausible-looking draft in which a customer's address is offered as a breakdown axis and the
table has no display label at all. Add a fixture per convention before trusting any of them, and
keep the lexicons bilingual because a Swedish model is the normal case here.

**A RANKING IS NOT A CLASSIFIER, and using one as the other cost a whole family of columns.** The
label score answers "which column does a reader recognise a row by" — a comparison. The role ladder
read it as "is this column a label" — a judgement — by testing whether a column had WON the
election, and every runner-up fell through to `analysis`. On any customer, employee or contact
dimension that made `FirstName` and `LastName` grouping axes: revenue by first name is one fact per
person wearing the clothes of a segmentation. Cardinality would not have rescued it — a few hundred
first names across ten thousand customers is exactly what an axis looks like to a distinct count —
which is why this one is a lexicon problem all the way down. The two questions are now asked
separately: every name-like column is `Label`, and the election decides only which of them the
report names a row by. That second question needed a lexicon of its own
(`NAME_PART_QUALIFIERS`), because all four of `First`/`Middle`/`Last`/`Full` `Name` score alike and
the tie broke on DECLARATION ORDER — reliably electing a fragment, since tables are written in that
order.

**And a name is a proxy for the thing that actually decides.** Whether a column is an axis is a
question about CARDINALITY: `Country` and `Segment` are both strings on a dimension, and only the
distinct count separates them in general. The lexicons are a stopgap for a signal this codebase does
not keep — see `INFER_ANALYSIS_DIMENSIONS` and `docs/design/open-items.md` §2.AI.6. Cardinality is
the one signal that is independent of both naming convention and language, which is why every
lexicon here carries a comment pointing at it rather than pretending to be the answer.

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

   Only two of the four invariants can even be written today, and that is worth knowing before the
   guard is built. `AttributeSet` carries `direction`, `target`, `materiality`, `cadence`,
   `aggregation`, `suppress` and `rankWeight` — so `unit` and `neverSliceBy` are **structurally
   unsettable by any rule**, and no guard is needed for them in either kind of scope. `direction`
   and `aggregation` ARE settable, deliberately: a scoped direction override is what the rules
   layer is *for* (headcount rising is the plan in the department that is building out). The guard
   must therefore distinguish the two kinds of scope rather than the two attributes — the same
   `direction` override that is correct inside a COLUMN scope is the one thing an AUDIENCE scope
   may never carry, because a column scope narrows *which facts*, and an audience scope would
   change *what the same fact means to different readers*.
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
- **`fiscalYearStart` is settable and read by nothing, and says so on screen.** `unit` and `cadence`
  were beside it until 2026-09-09 and now have readers (§13.6a); `reportingCurrency` was deleted
  rather than labelled, because unlike them it had no designed reader coming. `cadence`'s OTHER
  designed consumer — period bucketing, which decides the grain a series is fetched at — is still
  unbuilt, and is deliberately not plugin-shaped: query planning is engine business (§13.8).
- **`MeasureStrategy.context` is the last one, and it is the prose one.** It is copied into
  `ResolvedMeasure` and read by nothing, because its consumer is M6's narrator. So the prose
  boundary §2 rests on is currently *vacuous rather than fragile* — nobody can smuggle structured
  data into a field that influences nothing. This is why §13's Tier A is worth building on its own
  merits rather than as a pressure valve: the valve protects a boundary that does not yet exist.
- **A `targetBand` direction decides favourability but produces no variance ROW.** The band reads
  where the value landed, each bound's inclusivity included, so it is no longer inert. But
  `Observation.target_value` is one number and a band is two, so a report says "inside the band"
  through favourability and never prints "inside 90k–140k". Per-side band severity is blocked
  behind that, and was left out rather than shipped as a field that reorders nothing.
- **A name heuristic cannot tell a fragment from a whole name without a lexicon.** `FirstName`,
  `MiddleName`, `LastName` and `FullName` score identically as "a trailing name that does not
  restate the table", so the label election broke on DECLARATION ORDER and handed the label to
  `FirstName` — a column that names three rows "Anna". `NAME_PART_QUALIFIERS` fixes the ordering
  for two languages; a third language, or a schema that spells the whole name some other way, is
  another lexicon entry and not a general solution. The general solution is the same missing
  signal as everywhere else in §9.
- **The layer is worth zero if nobody fills it in.** Inference plus confirm-the-default is the
  mitigation, and rule expressiveness is deliberately limited to keep the checker honest.

## 13. Extension seams — designed 2026-09-09, not built

Openness is the project's prime directive, and this layer is closed twice over: the **attribute set**
is fixed, and the **fact catalogue** is fixed. Neither was a decision — the layer was simply never
designed for extension. This section designs the seams before they harden, and says what must be
consumed and shipping before each is safe to freeze.

**None of the strictness work is rolled back, and the reason is that the two concerns are
orthogonal.** Every case closed in the September rounds was a *misspelling of a key the schema
defines* — `too` for `to`, `outlier` for `outliers`, version 99 read as v1. Extensibility means a
user can define a *new* key; it has never meant a typo in a built-in key should be swallowed.
`deny_unknown_fields` stays, the `RawScopeValue` visitor stays, `is_readable_doc_version` matters
more rather than less, and `kind` stays restricted to what the engine consumes. The extension
namespace is the one place strictness differs, and **it differs by severity, never by silence**.

### 13.1 The namespace is a bag, not a prefix

The forward-compatibility hazard is real: a user adds `confidence` today, a built-in `confidence`
ships next year, and every model using it collides silently. That hazard dissolves if the two never
share a key space.

> **Built-in attributes are struct FIELDS. User attributes are MAP KEYS inside one named bag.**

```jsonc
"measures": {
  "GrossMarginPct": {
    "direction": "higherIsBetter",     // built-in: a field
    "x": { "acme.slaTier": "gold" }    // user: a key in the one open door
  }
}
```

A future built-in `confidence` is `MeasureStrategy.confidence`, never `x["confidence"]`. Collision
is **structurally impossible** rather than conventionally avoided — the same move
`SuppressibleFactKind` made when it stopped being a `Vec<String>`.

`deny_unknown_fields` stays on every container, because `x` is one *known* field. Strict outside,
open inside one named door.

Keys are an `ExtKey` newtype validated at parse time, following `IsoDate`/`MonthDay`: `vendor.feature`
shape, no whitespace, capped length, and **not** `calcula.` **case-insensitively**. One predicate,
shared with `validate_extension_data_key` so the model-level and document-level reservations cannot
drift — and pinned by a test, which today's reservation has none of (§13.6).

A doc-root `extensions` block declares each key's shape, so `acme.slaTeir` is still caught. A
declared key that violates its schema is an **error**; an *undeclared* key is a **warning** that
still saves. That asymmetry is the whole design: a hand-edited `x` on a model whose author never
wrote a schema must not be fatal, or the namespace is useless for the tinkering it exists to enable.

Findings anchor for free. `findingsAtPath` matches by prefix, so a finding at
`measures['Revenue'].x['acme.slaTier']` lands on the Revenue row with **no UI change**. Rooting
extension findings at a new top-level container would anchor nowhere, exactly like the empty path.

### 13.2 The four tiers

| Tier | What | Can | Cannot |
|---|---|---|---|
| **A** | Namespaced free metadata | Carry arbitrary JSON per object; travel with the model; be read by external tooling | Influence which facts exist, how they rank, or their wording |
| **B** | Custom vocabularies for existing attributes | Extend the value space of `unit`, status bands, materiality shapes | Add a consumer |
| **C** | Custom fact generators | Emit facts from an observation the engine fetched | Issue a query; introduce data |
| **D** | Ranking and suppression policy | Reorder, withhold, reweight | Emit |

**Tier A partly exists.** Model-level free metadata is `bi_model_extension_data` with `vendor.feature`
keys, today. What is missing is per-object metadata inside the strategy document — §13.1.

**Tier B is blocked on its own consumers, and that is the finding.** Extending the value space of
`unit` is meaningless while `unit` has no reader. B is not a seam to design; it is what falls out
once each consumer is written **with an explicit unknown-value arm**. That rule is the one to carry
forward: a consumer of a closed vocabulary must degrade deliberately, never fall through to a
neutral default. An unhandled unknown value produces exactly the vacuous-green failure — an answer
that looks like a judgement and rests on nothing.

**Tier D ships before C.** It answers the commonest complaint about this whole feature category —
"it keeps telling me things I don't care about" — without letting anyone introduce a claim. The
enabling work is to hoist suppression, scoring and narration out of `facts_for_measure`, where they
are currently one loop doing four jobs. The seam takes `Vec<ModelFact>` and returns a **permutation
of a subset**, enforced by checking returned ids against input ids rather than by trusting the
policy.

### 13.3 Tier C, and the verifier boundary

**The obvious design cannot be built.** "Plugins emit facts with evidence, which the engine
re-evaluates" presumes re-derivable evidence, and there is none: `WireEvidence` carries `measures`
and `group_by` and no filters, while the real query carries a time axis, a grain and a scoped filter
pinning the compared periods. That is deliberate — inventing a grouping a fact was never computed
with would open a pivot showing different numbers from the sentence beside it. **And nothing
re-verifies a built-in fact either**, so "graded like ours" would have been graded like nothing.

The invariant that *is* buildable, and is a stronger claim because it is true:

> **A producer is a pure function from an observation the engine fetched to a set of facts.**
> It cannot issue a query, so it cannot introduce data.
> The engine re-runs it and requires identical output.
> Every fact it emits is marked `AttrSource::Plugin(id)` and is visible as such.

This works because `facts_for_measure` is already pure over inputs that already round-trip through
serde. The producer is a script on a surface shaped exactly like `writeback-validator` — no model
provider, no capability, host globals deleted — and *that choice is the security design, not a
performance one*: a producer that cannot query cannot invent data. It also keeps user JavaScript off
the engine lock entirely, and keeps true the existing assertion that the QuickJS interpreter may
demand only `bi.query` or `bi.sql` — a producer demands nothing.

Facts enter through `build_run`, which already accepts pre-built facts and needs no signature
change, and compete in the same ranked list carrying a visible badge. The one genuinely new piece of
plumbing is a **structured return channel**: today a script returns text or a table of strings, and
the eval result is discarded. Whatever replaces that must be registered in `OP_MANIFEST` or the test
that boots a real QuickJS runtime fails the build — a guard that makes the new surface impossible to
add quietly.

**How a user extension is graded — not by `tests:`.** Extending the inline-test harness would make
its reachability analysis *unsound*: the value, baseline and delta probes derive candidate verdicts
from band bounds and materiality, a foreign attribute contributes no probes, and the `possible` set
would systematically exclude verdicts the producer can reach. Spurious refusals or vacuous passes —
precisely the family §7 was rewritten to eliminate. The mechanism is instead a **golden-observation
harness**: a producer ships cases of `(observation, resolved)` to expected facts, and the engine runs
it and requires exact output. **Built-ins get the same harness**, which is what makes "the engine
grades your rules the way it grades ours" literally true rather than aspirational.

A prerequisite nobody had noticed: **`tests:` has no authoring surface at all.** No Tests grid, no
`add test` verb, and `infer` emits none by design. Tests reach a document only as hand-written JSON.
That has to change before "held to the same standard" means anything to a user.

### 13.4 The amendment to §2

Tier C is the capability §2's invariant exists to deny, and `AttributeSet::touched()` is a
destructuring match specifically so nobody widens it by accident. So the amendment is argued here
rather than added quietly beside it:

> **Rules still never generate facts.** A **producer** may, under four conditions a rule can never
> meet: it is code rather than data, it runs sandboxed with no data access, it is reproducible, and
> its output is marked as its own. The invariant's purpose — *nothing a consultant writes in a
> strategy file can put a number in front of a reader that the model did not compute* — survives
> intact, because a producer computes only over numbers the model did compute.

### 13.5 Distribution and consent

A producer travelling in a `.calp` is distributed code and inherits the existing path: a new
surface-namespaced consent key, consent bound to the triple *(package key, artifact id,
sha256(source))* so a changed producer re-prompts with a diff, and a mount refusal that fails closed
on every uncertainty. Because the surface declares no capability, the dialog has no capability list
to show — the question is purely *"do you trust this code to describe your data?"*, which is the
honest one.

A subscriber cannot author: model writes are refused on a package-subscribed connection. They can
**refuse** a producer, and refusing must degrade to *no facts from that producer* — never to a broken
run. A producer is additive by construction, so this falls out; it is stated because the equivalent
question for the strategy document is what the publish gate got wrong until 2026-09-09.

### 13.6 Two defects this design work uncovered

- **`calp_publish_model` bypassed the strategy publish gate.** `validate_published_strategies` had
  one call site, inside `assemble_publish_workbook`, and a model-only push never assembles a
  workbook — so the one package kind whose entire content *is* a model was the one kind shipping an
  ungraded strategy to a subscriber who cannot repair it. **Fixed 2026-09-09**, and the guard that
  should have caught it was replaced: it asserted the call appeared at least once anywhere in the
  file, which proves existence and not coverage. It now enumerates the publish entry points and asks
  the question per path, with a positive control proving the scan can tell a reached path from an
  unreached one.
- **The `calcula.` reservation has a casing hole and no test.** The prefix check is case-sensitive,
  so `Calcula.strategy` passes the generic writer; and `validate_extension_data_key` has no test at
  all, so the key shape, the 256 KB cap and the reservation are unpinned. This is the single most
  load-bearing gap for §13.1, since the namespace rests on that reservation. Tracked in
  `open-items.md`.

### 13.6a What shipped 2026-09-09, and what each step actually cost

Steps 1–5 of the order below are **built**. What they taught:

* **The reservation is one predicate now.** `extension_namespace_refusal`
  (`strategy/types.rs`) is what both the model bag and the document bag ask, so they cannot answer
  differently. The casing hole is closed, and the length message says **bytes** because the check
  always counted bytes while the sentence said "chars".
* **Tier A is the `x` bag plus an `extensions` declaration block.** `deny_unknown_fields` survived
  untouched, exactly as designed — a typo in a built-in key is still a parse error, and the only
  softening is inside one named field.
* **The round-trip guarantee is VALUE fidelity, not BYTE fidelity.** `serde_json` here has no
  `preserve_order`, so an object's keys come back sorted. That is what the model bytes need —
  `extension_data` is a `BTreeMap` precisely so `.calp` checksums and signatures are deterministic —
  but it is not what "round-trips unchanged" sounds like, so the test asserts a **fixed point**
  rather than string equality.
* **The hoist was the enabling work and was worth doing alone.** `finish_facts` now does the
  suppress/score/narrate stage that used to be a loop inside generation; `apply_fact_policy` is
  Tier D, and its guard is a **subset check on the answer** rather than trust in the policy.
* **`unit`'s designed consumer was weaker than the plan assumed, and the honest one is narrower.**
  The plan had `unit` driving number formatting — but `format_string` already does that and carries
  strictly more information, because `0.0%` scales by a hundred and `0.0"%"` does not. `unit` cannot
  know the scale. What it *can* decide is which SENTENCE is correct: for a `percent` or `ratio`
  measure the relative-change clause is withheld, because "rose 0.02 … (+20.0%)" invites the reader
  to take twenty per cent as the movement when the movement is two points.
* **`cadence` earns its place in the seasonality scan.** A scan has no idea what a month is, so on a
  short window a noisier four-point correlation can beat the real twelve-point year.
  `Cadence::expected_cycle` passes `core/insights` a plain `usize` — no calendar, no measure, no
  vocabulary — and a preference the data does not support is ignored rather than asserted.

### 13.7 Build order, and why C is last

The rule that binds hardest here is the layer's own: **nothing becomes authorable until it has a
reader** — applied to the extension mechanism itself. Four strategy fields are still unread.

1. ~~Test the reservation; fix the casing hole; share one predicate with `ExtKey`.~~ **DONE.**
2. ~~**Tier A** — the `x` bag, `ExtKey`, the `extensions` schema block.~~ **DONE**, Rust and the
   TypeScript mirror, with the closed-set drift guard extended to `ExtValueType`.
3. ~~Hoist suppression/scoring/narration out of `facts_for_measure`.~~ **DONE** — `finish_facts`.
4. ~~**Tier D** — reorder and withhold, subset-checked.~~ **DONE** — `apply_fact_policy`. The
   ENGINE seam exists and is guarded; no authoring surface points at it yet, which is the next step
   whenever a policy is worth writing.
5. ~~Wire the `unit` and `cadence` consumers, hardcoded.~~ **DONE**, and both are narrower than
   the plan expected — see §13.6a.
6. An authoring surface for `tests:`, then the golden-observation harness — **applied to built-ins
   first**.
7. **Tier C**, once the fact catalogue is consumed end to end.
8. **Tier B**, once its consumers exist to have vocabularies.

**Tier C is last not because it is hardest, but because it is the only one that cannot be revised.**
A and D are internal until a model in the wild uses them. C defines a contract that user code
compiles against, and unlike an internal field you cannot quietly change it afterwards.

### 13.8 Two decisions taken here

**`cadence`'s consumer should be hardcoded, not plugin-shaped** — the opposite of the intuition that
an unwritten consumer is the natural place to answer "could a user have written this?". Both of
`cadence`'s consumers sit on the wrong side of the plugin boundary. Period bucketing is *query
planning*: it decides how the series is fetched, before any fact exists, inside the engine-lock and
budget window — and Tier C's central constraint is that a producer never influences a query. Making
the first instance of the pattern the one thing the pattern forbids would set exactly the wrong
precedent. Seasonality lag selection is the other consumer, and it lives in `core/insights`, the
crate that deliberately has no names and no registry.

`unit` is the better first Tier B case and should also be written hardcoded — but its consumer is
narration formatting, where an unknown value must degrade rather than fall through. Write it with an
explicit unknown-unit arm producing unit-less wording, and **that arm is where Tier B plugs in**.

**Freeze the authorable attribute surface** until the extension seam exists. The freeze covers
`MeasureStrategy`/`TableStrategy`/`ColumnStrategy`/`ModelStrategy` fields and `AttributeSet` members.
It does *not* cover findings, validation, inference or fact kinds — none of those is a surface a user
authors against, and all must stay free to improve. What it blocks, concretely: audience overlays
(§11) and per-side band severity. Both are additive, and both would want the extension mechanism's
answer to "is this a built-in or a vocabulary?" — so blocking them is the point rather than a cost.

## 14. Consumers outside the engine — 2026-09-10

Until this date the insights engine was the strategy's only reader, and the only way a language
model ever saw the strategy was through the external MCP server's `analyze_model` or the Insights
pane's "Send to chat" prefill. The in-app chat had neither: its 24 tools carried no analysis tool,
and the model description it reads before writing a query carried no strategy attribute. Two more
readers exist now, both through the same resolver at company scope, and each is held to §2 the same
way the engine is.

### 14.1 The model description a chat reads before it queries

`describe_bi_model` — the tool every MCP client and the in-app chat call before composing a
`run_bi_query` — printed tables, measures, KPIs and relationships. A model composing a query from
the schema alone grouped Revenue by invoice id as readily as by region and could not tell a rise in
Churn from a rise in Margin. It now ends with the block `insights/describe.rs` renders: one line per
measure (direction, unit, target, materiality, non-additive aggregation, cadence, priority, analysis
dimensions, never-slice-by, suppressed fact kinds), the tables the document says something about
(kind, analysis-role columns, label column), the declared priority order, the time axis and the
calendar with its provenance. The measures are listed in `choose_measures`' order — declared
priority, then the measures carrying a KPI, then the rest by name — so a model that reads the
description and then an analysis sees one ranking. Past forty measures the block says how many it
left out rather than trailing off.

**Prose stays out.** `MeasureStrategy.context` reaches wording and never selection (§2), and a chat
model choosing which query to run *is* selection. The block never prints it, and the fixture's own
two `context` sentences are asserted absent, so an "include the first context" shortcut cannot pass
by omitting one. A direction that Rule 4 withholds at company scope is printed as withheld — the
fixture's `Cost`, whose entry says lower is better and whose rule flips it for some members, is the
example — because "lower is better" told to a model that then calls a rise bad in the region where
the rule says the opposite is exactly the confident wrong sentence this layer exists to prevent.

### 14.2 The chat's two analysis tools and the Tier-0 pre-route

The in-app chat gained `analyze_range` and `analyze_model`: the MCP server's own arms, so an external
client and the chat get byte-identical facts. Both auto-run — read-only, no `DocumentEffect`, the
same class as `run_bi_query`. Neither is in the ten-tool core set a small model falls back to,
because that set was measured (4 of 4 real names at twelve tools, 0 of 4 at twenty-four) and a
change to it is a measurement, not an edit.

Separately, a message that reads as a question about the data — "what is going on", "trend",
"outliers", "anything interesting", and the Swedish equivalents — is answered by the engine BEFORE
the model sees it. A multi-cell selection is analysed as selected; otherwise the workbook's single
model connection, top-ranked measures; otherwise the block around the selected cell, the way the
pane's own button does it. The bundle rides inside the user's own message in the seam's wording
(`describeBundleForModel`: the facts verbatim, the notes, the dropped count, the ban on causes), so
the model's job is wording and a follow-up turn still has the facts. Two connections is a question
for the person, not a guess. A refusal from the engine is not a refusal of the message: the text
goes as typed and the model keeps its tools. The detector is a word list, not a classifier, for the
reason `scriptIntent.ts` gives: a false positive costs one cheap read-only computation, a false
negative costs nothing new.

### 14.3 The design-query assistant — "describe the report in words"

The same afternoon, the third consumer, and the first one where the strategy decides what a model
is SHOWN rather than what it is told. Model > Report from Design Query…, the chart data tab and the
model pivot's Design tab share one editor (`_shared/dsl/pivotLayout/DesignQueryEditor.tsx`, the
pivot mounts the row on its own editor); a row above it takes a sentence and drafts the query.

The pipeline is the formula assistant's, transposed. Pure pieces in `@api/designQueryAssist/`
(candidates, prompt, schema, grammar, extraction) so the offline runner measures the product's
own code; the loop in `_shared/dsl/pivotLayout/draft.ts` with the compiler and the dry run
injected, because `@api` may not import the DSL. One generation, `compileDesignQuery` as the
verifier, ONE stall-checked repair carrying the compiler's own line-numbered findings, then the
host's headless `run_design_query` as a second check that the engine can answer it. The query
lands in the editor; Create, Save or Apply is still the person's click, and a declined reply
puts nothing anywhere.

**Where the strategy acts.** `chooseCandidates` (`candidates.ts`) decides which names the model
sees and in what order: the measures the request names, then the declared `priority` order, then
the rest; the lead measures' `analysisDimensions` ahead of columns in the `analysis`, `hierarchy`
and `filter` roles, label columns, calendar columns; `neverSliceBy` and `ignore`-role columns and
keys never offered at all. Both lists are capped and the cap is stated. The summary the frontend
reads (`DesignStrategySummary`, built in `insights/describe.rs`, riding on `BiPivotModelInfo` from
`get_connection_bi_model`) carries only structured attributes; `context` prose is not in it. A
pivot's cached metadata carries no summary, because the cache holds no model to read one from.

**Two things the language taught the assistant, both found by the tests rather than by reading.**
`SORT` orders row and column LABELS; the DSL ranks by a measure's value only through `TOP` and
`BOTTOM N BY [Measure]`, and the compiler refuses `SORT: [Revenue]`. The first cheat-sheet taught
the refused form and four corpus tasks expected it; the grammar-sampling test caught the grammar
and Layer A caught the corpus. And inference marks a fact table's amount columns `ignore` because
they are not slicing axes — the first candidate chooser dropped them entirely, so `sum(Sales.Amount)`
could never be offered; the corpus recall check caught it. `ignore` now excludes a column as an
axis and nothing more.

**The grammar in both directions.** `buildDesignQueryGrammar` renders a GBNF grammar per request
from the candidate names, so a runtime that honours one (llama.cpp's server and, since Step 3, the
bundled copy of it; the seam's `honorsGrammar()` answers from the probe's measurement first and
from identity only when unmeasured) cannot emit a name it was not shown. A mini GBNF engine in `gbnfTestKit.ts` samples the grammar three hundred times per
intent and compiles every sample, and matches every corpus reference against the grammar built
from its own intent — so the grammar can neither produce a query the compiler refuses nor forbid
one the corpus calls right. The seam gained `grammar`, forwarded only to llama.cpp; a grammar
never leaves for a vendor that rejects unknown request fields.

**Measured before polished.** `tests/eval/design-queries.json` (40 tasks, 10 Swedish, each with a
distractor, some with `alternatives` where two columns answer equally), Layer A in
`designQueryCorpus.test.ts`, Layer B in `tests/eval/run-design-query-eval.mjs`, which drives the
real loop with a provider over a bare endpoint and grades by `canonical.ts` (names
case-insensitive, layout compared as the pivot would draw it with defaults dropped, SORT and TOP
included — the compiled request would lose the last two). The numbers are in `open-items.md`
2.AI.10.

**What the first measurement changed in the LANGUAGE, not the model.** Of a 1.5B coder model's
thirty-three failures, twenty-four did not compile, and most of those were shapes a person types
too: `= ('Consumer')`, `= 2024`, `TOP 3 BY [Margin] DESC`. The parser now reads a single-quoted
value and a bare number as the value they can only be, and accepts a redundant direction after
`TOP`/`BOTTOM` while refusing a contradictory one by naming the clause the person wanted
(`dsl-lenient-values.test.ts`). Double quotes remain the canonical form the serializer writes.
What stays refused is what would be a guess: `!=`, an aggregation inside brackets, a
show-values-as label in a measure's place. Those are the grammar's job on a runtime that honours
one, and the repair round's job elsewhere. The canonical form also surfaced a gap in the language
itself: the `subtotals-*` directives and the `(no-subtotals)` field option are validated and
offered by the editor and dropped by the compiler, which has no case for them. Filed in
`open-items.md` 2.AI.10; the canonical form carries them so that asking for them still counts as
asking.

**What the second measurement changed in the PROMPT.** The compile rate rose (1.5B 16 → 23 of
40, 3B 25 → 33) and the pass rate did not, and the failure buckets said why: the prompt's own
second worked example sorted by a measure — the shape the compiler refuses — and both models
copied it into a quarter of their answers; the share example carried a `TOP 10` nobody asked for
and that was copied too; the cheat-sheet's LAYOUT line read as a template and the 3B pasted it
whole. A worked example is the strongest instruction a small model receives, so every example
now shows exactly one thing, and a test compiles every example and matches it against the grammar
(`designQueryGrammar.test.ts`) — the guard that would have caught the first version. One repair
round bought one task on the 1.5B and none on the 3B, the formula assistant's finding again, and
the shaped examples bought the 3B nothing for 247 tokens. With four general rules added (no unasked
layout, a share label only when a share is asked, a filtered column not repeated as COLUMNS, a
measure never aggregated) the final numbers are **1.5B 21/40 at 5.5 s, 3B 27/40 at 11.5 s**, both
compiling 36 and 38 of 40; the rest is judgement and SQL habit, which is the grammar's territory.

**Step 3 measured the grammar's territory (2026-09-10).** On the bundled runtime — the same 1.5B,
now on llama.cpp with the grammar honoured — every one of the forty drafts compiles (40/40 against
34/40 for the schema on the same runtime) and the median halves (1.0 s against 2.1 s); 17/40 pass
against 15/40, McNemar p = 0.77, so the pass rate is the same within noise. What the grammar removed
is the whole compile-failure class; what it left is judgement — an unasked share label, an unasked
TOP, an extra name — which no grammar decides. Two things the runtime taught the assistant: under a
grammar the prompt has to ask for what the grammar allows (`DESIGN_QUERY_SYSTEM_PROMPT_BARE` and
bare examples), or the reply opens with the most probable legal token, which was an unasked LAYOUT
line three times out of three; and the grammar now holds the clauses to the serializer's order,
each at most once, because the free-order version let a reply write VALUES twice. The numbers are
in `open-items.md` 2.AI.10.

### 14.4 The tier rule this establishes

Tier 0 first, always: the engine answers before a model is asked. A model is used for exactly three
things — putting computed facts into words, turning words into a structured artifact the engine
verifies before anyone sees it (a formula, a design query, a script), and nothing else. The app
decides the tier per task and says which it used: the notice above a Tier-0 answer names the facts
as computed and the model that words them. The user decides the model, in one place. The vocabulary
itself, restated because it was being used the other way round: **Tier 0 is no model**; **Tier 1 is
the bundled on-board model** (M2 + M6, unbuilt); Tier 2 is a larger optional model the picker
already covers; Tier 3 is a bring-your-own key.

### 14.5 Next-edit suggestions — the strategy as an editor, 2026-09-11

The fourth consumer, and the first that is Tier 0 end to end: no model, no latency, and a sentence
under every suggestion naming the field it read. The owner asked whether Calcula would behave like
Copilot's Next Edit Suggestions for the design query; most of what such a surface does for a
six-line language turns out to be deterministic, because the document already says which measures
matter, which way is good, what a measure is analysed by, what it must never be sliced by, which
column a table's rows are recognised by, and which table is the calendar.

Seven rules, each one function in a list so the owner's later ideas are one more entry each: a
missing VALUES gets the strategy's first measure; a measure with no breakdown gets its first
analysis dimension; a column in a measure's `neverSliceBy` is offered for removal, naming the
measure; `TOP N BY` a lower-is-better measure is offered as `BOTTOM`; a month or quarter with no
year anywhere gets the year; a column FILTERS pins to one value is offered for removal from the
axis; and a key column is offered its table's label column. The chips sit under the editor at every
DSL mount and accepting one edits the TEXT — never a re-serialisation, so the person's own spacing
and ordering survive — while Create, Save and Apply stay their click.

**Two invariants, and the first is a gate.** A rule may never fire on a complete, correct query: a
suggestion that fights a right answer is a defect, and `nextEditCorpus.test.ts` runs every rule over
all 44 references and alternatives of the drafting corpus and fails on any chip at all. The gate
earned its keep immediately — a first draft had an "also analyse by the next dimension" rule that
fired on 44 of 44. The second invariant is that every reason names its source; a rule that cannot
say why is not a rule this engine wants.

**What the rules cannot do, measured.** Prefix recall over the corpus's own references is 21 of 86,
and every hit is the missing-VALUES rule. Rules supply the measure the strategy ranks first and can
never guess which dimension the person wanted — the gap §14.6 then asked a model to fill, and
measured it not filling.

**The strategy's reach changed twice here.** A pivot's cached metadata carries no strategy at all —
the cache holds no model to read one from — so the pivot's Design tab had been drafting without the
strategy's ranking since §14.3. It now arrives on `PivotEditor`'s existing connection-level fetch,
which already cleared stale state and already re-fetched on `bi:model-changed`; giving the Design
tab its own fetch instead (the first attempt) was a second round trip, went stale, and could hand
one connection's strategy to another connection's pivot. Separately, `strategy` had reached only one
of the two TypeScript mirrors of the Rust `BiPivotModelInfo`, so the facade's own type could not see
it; the two are now diffed by a test.

### 14.6 The model's chip — built, measured, and off, 2026-09-11

Milestone B asked the built-in model for the one clause the rules could not guess. Everything about
the plumbing worked. The answer was still no, and the number is the point of writing this section.

**The shape.** No new backend command and no new endpoint: the existing completion seam, a grammar
of the single clause that may legally come next, and the bare next-clause prompt.
`buildNextClauseRequest` assembles prompt, names and grammar in ONE place, `nextClauseSuggestion`
turns a reply into a suggestion in one place, and `rulesChips` — the row's own Tier-0 loop, moved
out of the component — is what the row, the corpus gate and the offline runner all call. That is
deliberate: `tests/eval/run-next-edit-eval.mjs` measures the pipeline the product runs, and a
runner that rebuilt any of those three steps would have measured its own copy. The chip is asked
for only after the rules, only where the rules left room on the row, and only where
`honorsGrammar()` is a measured yes.

**Measured on the built-in runtime** (llama.cpp b10897 + qwen2.5-coder-1.5b-instruct Q4_K_M,
grammar honoured, prefix warm), over every prefix of the 52 correct queries in the drafting corpus:

| | |
|---|---|
| exact next clause | **0 of 80** (a perfect model scores 79; see below) |
| the same prefixes, rules alone | 19 of 80 |
| what the model added over the rules | **0** |
| quiet on a query that was already finished | **0 of 52** |
| median latency | **686 ms** (the milestone's gate was 400 ms) |
| p90 latency | 848 ms |

Not one right answer, a chip on every finished query, and twice the latency budget. So
`MODEL_CHIP_DEFAULT` is false: the chip stays built, wired and off, and the runner is what decides
when a better model earns it. Owner decision D10 puts the interesting models between the small
local ones and the cloud, and this is the harness that will judge them — one command, three numbers.

**A zero is a claim about the harness until proven otherwise.** The runner refuses to run at all
unless it can score its own oracle: each reference's own next line is fed through the same
`nextClauseSuggestion` → `applyEditOp` → `sameDesignQuery` path the model's reply takes, and a
single failure exits 3 with "the harness cannot score its own oracle" rather than reporting a
flawless zero. It also runs the oracle through the row's compile VETO, which is where it found
that one task is unwinnable for anybody: the corpus's own next clause there is `LAYOUT:
subtotals-off`, the compiler has no case for `subtotals-*` and warns, and the veto refuses any chip
that adds a warning. So the ceiling is 79, not 80, and the runner prints it rather than scoring an
impossible task as a miss. The directive gap is filed in `open-items.md` 2.AI.11 — the language
teaches three directives its own compiler warns about, and `LayoutConfig` has nowhere to put them.

**Two defects the measurement found before the number did.**

*The prompt promised something the grammar forbade.* Its last line is "if the query is already
complete, reply with nothing at all", and the root rule was `root ::= (clause) "\n"?` — exactly one
clause, mandatory. The model could not obey however well it understood, so the no-clause rate could
only ever have been zero, and on a finished query the only thing between the person and an unwanted
chip was the compile veto — which passes a syntactically fine LAYOUT, because it adds no error and
no warning. The root is now `root ::= nextclause?`, and the runtime honours it: a probe with a
grammar whose only content is optional returns the empty string with finish reason `stop`. The
model then declined to use it 52 times out of 52, which is a fact about the model rather than about
the grammar — and only measurable once the grammar stopped lying.

*An unbounded repetition is an invitation.* `values ::= "VALUES: " val (", " val)*` let the 1.5B
answer `VALUES: [Revenue], [MarginPct], [Margin], [Cost], [Customers], [Quantity]` — every measure
it had been shown, in the order it had been shown them — on every prefix of every query. It is the
formula grammar's lesson a second time. Every clause repetition is now `{0,3}`; the widest clause in
all 52 correct queries lists two. Bounding cut the next-clause median from 838 ms to 674 ms and
moved the exact rate not at all, and a paired run of the DRAFTING eval either side of the change
(16/40 passed, 40/40 compiled, ~4 s median both ways) says the shared grammar lost nothing.

**What the corpus gate learned from the row.** The gate had re-implemented the chip loop with an
ABSOLUTE compile bar while the row uses "no worse". It was therefore quietly weaker than the thing
it guards, and it was hiding a fixture: an `ALSO_CORRECT` shape named `Date.Quarter`, a column this
model does not have, so that row never compiled and gated nothing. Both are fixed, and the gate now
calls `rulesChips` rather than a copy of it.

### 14.7 In the text, and at another line — the Next Edit Suggestion shape, 2026-09-11

Milestone C answers the owner's original question literally. Copilot's Next Edit Suggestions are
edit-triggered, show inline, and predict an edit at ANOTHER location; the chip row of §14.5 is
none of those. This puts the same suggestions in the text itself: ghost text on the line being
typed, and — where the strategy wants a change somewhere else — a hint at the cursor that jumps to
it. **Still no model.** §14.6 measured the built-in 1.5B at 0 of 80 next clauses, and ghost text
from it would be wrong every time it appeared, in the one place a wrong suggestion is hardest to
ignore. The rules answer instantly and are already right about 19 of 80.

**Monaco 0.55 already implements the shape, which changed the design.** `InlineCompletion` carries
`isInlineEdit`, `showRange` and a `hint` with `jumpToEdit`, and
`editor.action.inlineSuggest.jump` is bound to Tab. So "an edit over there you can jump to" needed
no decorations, no content widgets and no view zones — none of which this app had ever used outside
the script debugger's breakpoint glyphs. What it did need was obedience to a narrow contract: an
inline completion's range must begin and end on ONE line, must end at the end of a line if the text
contains a break, and the replaced text must be a prefix of the inserted text unless the item is
declared an inline edit.

`nextEditInline.ts` bends every suggestion into that one shape: replace ONE whole line, whose new
text may contain breaks. An insertion is anchored to the line ABOVE it, which makes the old text a
prefix for free and lets it render as plain appended ghost text; a rewrite cannot be a prefix and is
declared `isInlineEdit`. An edit that DELETES a line is a two-line range however it is sliced, so
those are reported rather than shown, and keep the chip row. The line span itself comes from a
generic head/tail diff of the text before and after, not from threading a range out of
`applyEditOp` — the edit functions already decide where a clause goes, and asking them to report it
too would be a second source of truth about one decision.

**A latent bug had to be fixed first, and it was the interesting part.** A Monaco provider is
registered per LANGUAGE and handed a `model`, so one provider serves every open DSL editor. The
language module's completion context was a set of module-level "current" fields written by whichever
editor rendered last — and a Reports dialog can sit over a pivot's Design tab, both writing on every
model change. The loser autocompleted against the winner's schema. `dslModelContexts.ts` now keys a
context per model URI, both hosts register their own, and the old globals survive only as a fallback
for the window before an editor mounts. `pivotDslLanguage.ts` had no test file at all, which is why
nothing had ever said so; the registry and the whole suggestion decision are now in monaco-free
modules with 35 tests, and the six guards were each sabotaged and each redded its own named test.
