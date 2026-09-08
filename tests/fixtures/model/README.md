# The `sales_star` model fixture

Everything on the **model path** of the insights engine (plan §6.9) runs against the files
below. They are not sample data. Each thing in them is planted so that one named test has a
true answer and its negative control has a false one; if you change a number here, find out
which test you just changed the meaning of.

| File | What it is | Authored how |
|---|---|---|
| `sales_star.json` | The model document **and** its rows | **Generated.** Edit `gen-sales-star.mjs`, never the JSON |
| `sales_star_strategy.json` | The strategy document for that model | Hand-authored |
| `gen-sales-star.mjs` | The generator | Hand-authored |
| `../../eval/strategy-cases.json` | The resolution corpus over both | Hand-authored |

---

## The schema

A five-dimension star, one fact table, one snowflake hop.

```
                       Subcategory                (the snowflake: two hops from Sales)
                            ^
                            | ManyToOne
                            |
   Date <--- ManyToOne --- Sales --- ManyToOne ---> Product
                          /     \
                 ManyToOne       ManyToOne
                        /             \
                 Customer            Geography
```

**Sales** (fact) — `Date`, `ProductKey`, `CustomerKey`, `GeoKey`, `Amount`, `Cost`, `Quantity`
**Product** — `ProductKey`, `Category`, `SubcategoryKey`, `Name` (15 rows, 3 per category)
**Subcategory** — `SubcategoryKey`, `SubcategoryName` (10 rows)
**Customer** — `CustomerKey`, `Segment`, `Name` (8 rows, 2 per segment)
**Geography** — `GeoKey`, `Region`, `Country` (8 rows, 2 countries per region)
**Date** — `Date`, `Year`, `Month`, `MonthName`, `MonthNumber` (24 rows) — marked as the
model's date table; `Date` carries `date_role: DateKey`, `Year` carries `Year`, `MonthNumber`
carries `Month`, and **`MonthName` is sorted by `MonthNumber`** so months come back in
calendar order rather than April-August-December.

Measures: `Revenue = SUM(Sales[Amount])`, `Cost = SUM(Sales[Cost])`,
`Margin = [Revenue] - [Cost]`, `MarginPct = DIVIDE([Margin], [Revenue])`,
`Quantity = SUM(Sales[Quantity])`, `Customers = DISTINCTCOUNT(Sales[CustomerKey])`.
One KPI, **`Margin % KPI`**, on `MarginPct` against a constant `0.35` with ascending status
bands (`0.0` OffTrack, `0.9` AtRisk, `1.0` OnTrack) — the higher-is-better shape a KPI can
express, and the base layer that `kpi_bands_decide_status_when_present_and_strategy_target_otherwise`
reads.

`Margin` is deliberately a **difference of two measures** and `MarginPct` a **ratio of two
measures**: that is what gives `definitional_decomposition_of_a_difference_is_exact` an exact
answer and `ratio_decomposition_states_its_residual` a residual to state. `Customers` is a
`DISTINCTCOUNT` so `a_non_additive_measure_gets_no_share_claim` has a real non-additive
measure rather than one merely declared non-additive.

### The snowflaked attribute

**`Subcategory[SubcategoryName]`.**

`Subcategory` is related to **`Product`**, not to `Sales`. Decomposition in v1 is single-hop
from the measure's fact table (plan C1), so every attribute of `Subcategory` is
`unreachable-in-v1`. It is listed in the `Quantity` measure's `analysisDimensions` in the
strategy document **on purpose**: that is the input
`a_snowflaked_attribute_is_reported_unreachable_not_silently_skipped` needs. A planner that
quietly drops what it cannot reach passes every other test in the suite and leaves the user
believing a dimension was analysed and found uninteresting.

Nothing else in the fixture is more than one hop from `Sales`, so that test has exactly one
possible subject.

---

## The fact data

**12,720 rows** at (month × product × customer × geography) grain, 24 monthly periods
(2024-01 .. 2025-12), 619 KB. Well under the 2 MB ceiling and small enough that a failing
test can be diffed by hand.

The grain is the full fact grain, not a pre-aggregate: the sparse cube (a fixed 530 of the
960 product×customer×geography combinations, ~55% density) is what keeps the row count down.
The mask is drawn **once** and reused for every month — if it were redrawn per month, the set
of combinations would differ between the last two periods and the contribution shares would
be measuring the mask instead of the plant.

Rows carry `Amount = unitPrice × Quantity` and `Cost = unitCost × Quantity`, both to two
decimals, so `Revenue`, `Cost`, `Margin` and `Quantity` are exactly consistent with each other
row by row.

### The one planted thing

In the **final month (2025-12)** the `Product[Category] = "Gadgets"` volume is multiplied by
`0.55`. Amount, Cost and Quantity all move together, because this is a volume collapse and not
a margin event — which keeps `Margin` exactly decomposable into `Revenue − Cost` and leaves
`MarginPct` moved only by mix.

Measured by the generator and written into the fixture's own `planted` block:

| Category | Revenue delta, 2025-12 vs 2025-11 |
|---|---:|
| Widgets | +2,771.94 |
| **Gadgets** | **−142,097.30** |
| Gizmos | −35.83 |
| Doodads | +3,372.28 |
| Trinkets | −329.89 |
| **Total** | **−136,318.80** |

**Share of the total delta: 1.042** — comfortably over the `> 0.5` that
`the_planted_shift_is_the_top_contributor_and_names_the_member` asserts. (It exceeds 1.0
because the other categories drift slightly *up* on trend, offsetting part of the drop. A
share above 1 is normal when contributors move in opposite directions.) The generator
**refuses to write the file** if the measured share is not above 0.5, so the assertion can
never quietly stop being true.

The first draft of the generator had November at seasonal 1.12 and December at 1.02, so every
category fell together and the planted share came out at 0.65 — the plant was still the top
contributor, but a third of the drop was the calendar. November and December now carry the
same seasonal factor. That is why "flat" in "every other category is flat" is worth checking
rather than assuming.

### Determinism

`node tests/fixtures/model/gen-sales-star.mjs` rewrites `sales_star.json` byte for byte.
`--check` regenerates to memory and exits 1 on drift — wire that into CI and a hand-edited
fixture becomes a build failure instead of a mystery.

- Seed: `20260907`, one 32-bit LCG (`x' = 1664525·x + 1013904223 mod 2^32`), consumed in a
  fixed order documented in the script.
- `Math.random` does not appear. Neither does `Math.sin`: ECMA-262 leaves transcendental
  results implementation-defined, so a seasonal curve computed with `Math.sin` would be
  reproducible only on the engine that first wrote it. The seasonal shape is a hard-coded
  12-element table.
- `Math.imul` does the multiply so it wraps in exactly 32 bits rather than losing low bits to
  double rounding.

### Data layout

The fixture is a wrapper document, following the `ModelBundle` precedent (`formatVersion` +
`model`, plus sibling keys — `app/src-tauri/src/bi/commands.rs:2246`):

```jsonc
{
  "formatVersion": 1,
  "generator": { "seed": 20260907, ... },
  "model":  { /* a raw DataModel — feed this to serde_json::from_value::<DataModel> */ },
  "data":   { "Sales": { "columns": [...], "rows": [[...], ...] }, /* one per table */ },
  "planted": { /* the measured plant, above */ },
  "counts":  { /* row counts */ }
}
```

`data` is **this fixture's own convention**, not an engine format: the engine takes Arrow
batches, and a test loader turns these `{columns, rows}` blocks into them. `Date`-typed values
are ISO `YYYY-MM-DD` strings; `Int64`/`Int32` are JSON integers; `Float64` are JSON numbers
already rounded to two decimals.

`model` deserializes into `engine_core::model::DataModel` and passes `DataModel::validate()`
— verified against the real engine while this fixture was written, which is how the
`storage_mode` spelling (`in_memory`, the one snake_case-renamed enum in the model schema) and
the hierarchy-name-versus-table-name collision were both caught.

---

## The strategy document

`sales_star_strategy.json` follows plan §7.2 exactly. It is **not** embedded in the model's
`extension_data` — it lives beside it as one file so there is one source of truth, and a test
that wants the round-trip inserts it under `extension_data["calcula.strategy"]` itself.

What each part is there to exercise:

| Piece | Where | What it makes testable |
|---|---|---|
| `model.defaultTimeAxis` / `priority` | top | the planner's axis and measure ordering without guessing |
| `lowerIsBetter` | `Cost` | `lower_is_better_flips_favourability` |
| `nonAdditive` | `MarginPct`, `Customers` | `a_non_additive_measure_gets_no_share_claim` |
| `byDimension` override | `MarginPct`, `Customers` → `{"Date": "lastValue"}` | a ratio that must not sum across periods |
| `neverSliceBy` | `Revenue` → `Product[Name]` | `a_never_slice_by_dimension_produces_no_contribution_fact` |
| its positive control | `Margin` **allows** `Product[Name]` | the same guard, proved to have teeth |
| `targetBand` | `Quantity` → `{low: 90000, high: 140000}` | a direction where both ends are bad |
| `{type: "kpi"}` target | `MarginPct` | KPI bands decide status |
| `{type: "literal"}` target | `Revenue`, and rule `nordics-margin-floor` | strategy target decides status |
| unreachable analysis dimension | `Quantity` → `Subcategory[SubcategoryName]` | the snowflake warning |
| `reviewed: false` | `Customers` | the unreviewed-entry warning does not block resolution |
| key / label / ignore roles | `tables` | `a_key_role_column_is_never_a_grouping_axis`; `MonthNumber` is `ignore` because it is a `sort_by_column` target (§7.6) |

### The rules

Seven, and each earns its place:

- **`gadgets-launch-window`** (Revenue, `Product[Category] = Gadgets`) raises materiality from
  15k to 25k. The corpus checks both that it fires inside its scope and that it does *not*
  leak outside it.
- **`nordics-margin-floor`** (MarginPct, `Geography[Region] ∈ {Nordics}` **and**
  `Date[Date] from 2025-01-01`) supplies a target and a tighter materiality. It is the only
  rule with a date range, so it is what proves a `DateRange` scope value is *evaluated* rather
  than merely parsed — the corpus asks the same region in 2024 and expects the rule not to
  fire.
- **`public-sector-cost-buildout`** (Cost, `Customer[Segment] = Public Sector`) flips direction
  to `higherIsBetter`. This is the mixed-direction generator: at company level the total Cost
  figure aggregates over the segment the rule constrains, so favourability is **suppressed**
  and the reason names this rule.
- **`public-sector-nordics-cost-hold`** (Cost, segment **and** region) is the more-specific
  rule that legitimately overrides the general one at `{Public Sector, Nordics}`. Two
  constrained columns beat one.
- **`enterprise-margin-push`** / **`smb-margin-watch`** (Margin, `rankWeight`) are the
  **disjoint equal-specificity pair**: same measure, same attribute, same column, same
  specificity, non-intersecting members. The overlap checker (§7.5) must accept them. Note
  that `{Segment: Enterprise}` and `{Region: Nordics}` would *intersect* despite naming
  different columns — a fact at `{Enterprise, Nordics}` satisfies both — so a legal disjoint
  pair has to constrain the **same** column with disjoint members. That is the trap §7.5
  spells out, and the pair here is shaped to stay out of it.
- **`dach-quantity-rampdown`** (Quantity, `Geography[Region] = DACH`) sets **only**
  `direction`, which is what makes attribute-level inheritance observable: materiality and the
  capacity band must survive from the measure entry untouched.

One period annotation (`summer-shutdown-2025`) and three inline `tests` mirroring plan §7.2:
Public Sector cost rising is favourable, SMB cost rising is unfavourable, company-level cost
rising is suppressed.

---

## The resolution corpus

`tests/eval/strategy-cases.json` — 14 cases, each a single
`resolve(model, strategy, measure, scopePoint)` call with one right answer and a `why` saying
what breaks if it is wrong. It covers base-from-KPI, strategy overriding base, a rule
overriding strategy, attribute-level inheritance, most-specific-wins, disjoint rules
coexisting (both halves), mixed-direction suppression naming its rule, the positive control
for that suppression, materiality gating and its outside-the-scope control, a rule-supplied
target inside a date range and outside it, and an unreviewed entry that still resolves.

`model` and `strategy` are `"sales_star"` to reference these files, or an inline object where
a case needs a different shape — the base-from-KPI case uses an inline strategy with no
`MarginPct` entry, because that is the only way to see what the base layer answers on its own.

---

## Choices this fixture makes where the plan does not

Recorded here so a later reader can find them, and so a Rust implementation written against
the same plan section can agree with the data rather than the other way round.

1. **Base materiality is `{type: "relative", value: 0.05}`** when neither a KPI nor a strategy
   entry supplies one. The plan defines no default. Something has to answer.
2. **`AttrSource` is spelled** `base` / `inferred` / `strategy` / `kpi:<name>` / `rule:<id>`.
3. **Mixed-direction suppression applies to `direction` only.** §7.1's invariant 4 says
   "suppress favourability"; §7.4's wording is general enough to read as "any attribute".
   Under the general reading, `nordics-margin-floor` would suppress MarginPct's *target* at
   company level, which is not a favourability question at all. The corpus takes the narrow
   reading.
4. **When more than one rule would suppress, the first in document order is named.** Only one
   rule qualifies at each scope point in this fixture, so nothing here depends on it.
5. **`Role` has no `date` variant.** §7.6 talks about an inferred `date` role; §7.2's enum is
   `Key | Analysis | Label | Filter | Hierarchy | Ignore`. The enum wins: `Date[Date]` is
   `analysis` (it is a legitimate grouping axis and rules scope on it), `MonthNumber` is
   `ignore` (a `sort_by_column` target, per §7.6's own rule).
6. **`Product` carries `SubcategoryKey`, not a `Subcategory` text column.** The task's column
   list and its snowflake requirement cannot both be literal — an attribute cannot sit on
   `Product` *and* be reachable only through another table. The snowflake requirement wins,
   because a test needs a real unreachable attribute to point at.
7. **`{type: "measure"}` targets are not exercised.** The fixture has no budget measure, and
   inventing one to reference would add a measure no test needs.
8. **The date dimension is named `Date`**, as the plan's own §7.2 example
   (`"defaultTimeAxis": {"table": "Date", "column": "Date"}`) requires. Every date table in
   the engine's own tests is called `dim_date`, and the local-aggregation SQL builder quotes
   column identifiers but not table names
   (`crates/engine-query/src/executor/pipeline/local_aggregation.rs:1465`). If DataFusion ever
   refuses `Date` as a bare table identifier, the fix is a rename in three places: the table in
   `gen-sales-star.mjs`, `date_table`, and `model.defaultTimeAxis.table` in the strategy.
