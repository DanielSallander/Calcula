# Table Transformations ("applied steps")

**Status:** engine + host command surface SHIPPED 2026-08-25. Step editor, CLI verb,
script gateway shipped alongside. REST/Web connector shipped as the first source that
could not exist before it. Multi-table steps (merge/append) and query folding are
designed here but deliberately NOT built.

## The gap this closes

The Calcula Model could import tables and views. It could not **manipulate** them. A
user whose source column was `"  OPEN "` instead of `"open"`, or whose fact table
carried a `Cancelled` status that every report had to filter around, or whose customer
name arrived as one string that wanted splitting, had exactly one option: fix it
upstream, in a system they usually do not control. That is the hole Power Query fills
in the Microsoft stack, and `docs/excel-gap-analysis.md` had listed Power Query as
"deliberately replaced" without anything actually replacing it.

## Why steps, and not a scripting language

The obvious reading of "replace Power Query" is "let people write code against the
table". We rejected that, twice over.

**Python was considered and rejected.** It is the language people expect for this job,
and Power BI itself offers Python steps. But Power BI's Python steps run *unsandboxed*
local Python — precisely the VBA-shaped hole this product exists to close (`CLAUDE.md`,
Project Vision). Sandboxing Python honestly is not a small job: Pyodide is ~10 MB of
WASM living in the renderer, which this architecture explicitly treats as
compromisable and never authoritative; CPython via PyO3 puts an unsandboxable
interpreter inside the Tauri process. Either way it would be a **fourth** sandboxed
runtime alongside QuickJS, the Worker realms, and Rhai — and none of the hard-won
guards in those three transfer (the QuickJS poisoned-runtime leak, Rhai's crate-wide
`no_module`/`no_time`, the Worker realm's broker). We would have paid for a new
security surface to get a feature that mostly does not need code.

**Because mostly it does not need code.** The overwhelming majority of real Power Query
use is a dozen operations — filter, remove columns, rename, change type, split, replace,
trim, fill down, dedupe, sort, group, unpivot. Power Query's own "Applied Steps" pane is
the honest shape of the feature: an ordered, inspectable list. Making that list the
*primary* representation rather than generated M code buys three things a language
cannot:

1. **Schema derivation without data.** Each step's output schema is a pure function of
   its input schema, so the editor shows the resulting columns while the user is still
   typing, and model validation can assert that a table's declared columns are exactly
   what its own pipeline produces. A scripted step can only be typed by running it.
2. **Transparency by construction.** A shared model file's pipeline is readable as data.
   A reviewer sees `filterRows: status <> "cancelled"`, not an opaque function body.
   This is the Transparency pillar applied to data shaping.
3. **A future for folding.** Declarative steps can later be pushed into source SQL
   (§Query folding). Code cannot.

Logic the catalog genuinely cannot express is still reachable: an expression step may
call a **model script function** (sandboxed Rhai, already budgeted and deterministic)
via `Expression::Call`. That is the escape hatch, and it costs no new runtime.

## The script view, and why it points the other way from M

Power Query's Advanced Editor is the answer to a real complaint about applied-steps
panes: one form per step is fine for one step and miserable for twenty. You cannot copy
a pipeline to another table, cannot paste one a colleague sent you, cannot diff one in
version control, cannot reorder by dragging a line.

So a table's pipeline is also editable as **text** — but the arrow runs the opposite way
from M. Power Query makes the M text the stored form and renders the step list as a view
of it. Here the **steps stay canonical** and the text is a lossless rendering that parses
back. Three mechanical reasons, any one of which decides it:

- **The cache identity hashes the typed JSON.** `pipeline_fingerprint` is
  `serde_json::to_string(steps).hash(..)`, folded into `Table::schema_hash()`. With text
  as the stored form, re-indenting a `groupBy` block would change the fingerprint, so
  every cached row for that table on disk would be discarded — for a whitespace edit.
- **`TransformStep` derives `Eq`.** That allows the strongest round-trip assertion
  available anywhere in this repo, `parse(render(s)) == s`, on the STRUCTURE rather than
  on rendered bytes. Asserting rendered text is how a serializer and its parser drift
  apart while both look tested — this project has already paid for that once, in the
  formula renderer that dropped every parenthesis and printed 248 built-ins under their
  Rust variant names.
- **Validation reads no rows.** Schema derivation and the expression allowlist are
  defined over typed steps. Text as the stored form would push a parser below that
  boundary and into every model load.

The practical consequence is that entering the Script view and leaving it again is
*provably* not an edit, and that a script cannot express anything the typed steps
cannot: the grammar spells exactly the seventeen tags and nothing else, there is no
binding, no control flow and no evaluation, and a parsed script is a `Vec<TransformStep>`
or an error. Nothing about the Python rejection above is re-opened.

What it costs, honestly: no `let … in`, no `Table.*` function names, and **no step
names** — the store has no label field, and inventing a side channel for one (a name map
in `extension_data`) would be worse than having none, because that map is script-mutable
through the gateway and travels inside signed `.calp` packages, so a party other than the
pipeline's author could label steps that do something else. Steps are addressed by their
1-based number, the same number `show table` and the step editor already use. Comments
survive only as long as the editor is open, for the same reason.

The grammar deliberately reuses what the Model Editor's command line already reads, so
`show table <name>` prints paste-able script and a `transform … add` line is one
statement of it. It lives in `engine-core`, beside the enum it mirrors, because that is
the only place where the renderer can be an exhaustive `match` (an eighteenth variant is
a compile error) and where the round trip can be asserted against the enum itself.

## Why it is universal across connectors, nearly for free

The requirement was "it must work for all current and future connectors". That turned
out to be almost an architectural gift rather than a design problem:

- Every connector — Postgres, SQL Server, CSV, Parquet, in-memory, script-fed extension
  connectors, and now REST — returns `Vec<RecordBatch>` through one trait
  (`engine-connectors/src/traits.rs`).
- Every in-memory table lands through one function
  (`Engine::store_refreshed_table`, `crates/engine/src/refresh.rs`).

Applying the pipeline in the gap between those two facts makes it universal by
construction, with **no per-connector code**. A pipeline authored against a CSV import
behaves identically when the table is re-pointed at PostgreSQL. The insertion point is
`Engine::apply_table_transforms` (`crates/engine/src/transform_apply.rs`), called from
the three fetch→store sites in `refresh.rs`.

## The decisions worth remembering

| Decision | Why |
|---|---|
| Expressions stored as **source text**, parsed at build/eval | The `IncrementalRefresh.refresh_filter` precedent. The author's text round-trips exactly, and the model stays `Eq` (which the editor's change detection and the cache fingerprint both rely on). |
| Pipeline lives on **`TableSourceBinding`**, not `Table` | Steps describe how *source* rows become *this table's* rows. A table with no binding (calculated table, writeback store) is structurally excluded rather than excluded by a runtime check. |
| `source_columns` recorded on the binding | The anchor that makes schema derivation an **offline** operation. Without it, checking a pipeline would require connecting to the source. |
| Transformed tables forced **InMemory** | DirectQuery pushes filters and aggregates to the source using the table's *declared* column names — which the pipeline has already renamed, retyped, or invented. The combination would generate SQL for columns the source does not have. Rejected in `validate()`. |
| Transforms **exclude** incremental refresh | Incremental refresh splices freshly fetched *source-shaped* rows into a cache holding *transformed* rows. Rejected in `validate()`, plus a defensive guard in `refresh_table_incremental` because library code does not assume validation ran. |
| Expression validation is an **allowlist** | A variant added to `Expression` later is rejected by default rather than silently admitted into a context (one table, no filter context, no relationships) it was never designed for. |
| `promoteHeaders` **cut** from the catalog | Its output schema depends on row *values*, which breaks the pure-derivation property the whole design rests on. The CSV connector's header option covers the real use case. |
| `pivot` takes **declared** `value_names` | Same reason. The host samples a preview and writes the distinct values into the step, so derivation stays pure. Unmatched runtime values are dropped; declared-but-absent values yield null columns. |
| Pipeline folded into **`Table::schema_hash()`** | A step that changes only *values* — a trim, a tightened filter — leaves the column list byte-identical while making every cached row wrong. Without this, a stale on-disk cache outlives the edit that invalidated it. A table with no pipeline hashes exactly as before, so the upgrade invalidates nothing. |
| Errors carry a **step index** | `InvalidTransform`/`TransformFailed` both do. A host anchors the message to a row of its step list; a reason without an index is not actionable in an editor. |
| One multiplexed `bi_model_transform` command | `lib.rs`'s `generate_handler!` dispatch frame sits on the OS main thread with a fixed stack budget (`/STACK:33554432`). The standing rule is one op-command over N. |
| Transform edits **are** script-gateway reachable | A pipeline is a data-shape definition, the same kind of thing as a calculated table or calculated column — both of which already change a table's column set from the gateway. Sources, credentials, roles and storage/refresh knobs stay excluded. Note the gateway arms project through `overview_value`: the shared helper returns the FULL overview, which carries security roles and source targets. |

## The load-bearing invariant

`DataModel::validate()` asserts that a transformed table's **declared columns are
exactly what its steps derive**. Without it a model file could claim a shape its refresh
will never deliver, and every downstream consumer — measures, relationships, the query
planner, the disk cache — would be reasoning about a table that does not exist.

It is enforced in `validate_table_transformations`
(`engine-core/src/model/schema/validation.rs`) and tested from both directions: the
schema-derivation tests prove the pure function, and
`every_step_produces_the_schema_derivation_promised`
(`engine-core/src/transform/eval/eval_tests.rs`) proves that *evaluation over real
batches* produces what derivation promised, across the whole catalog. That test has been
verified to have teeth by sabotage (renaming a `splitColumn` output column made it red).

## Preview is a sample, not the answer

`Engine::preview_transformations` fetches at most `MAX_PREVIEW_ROWS` (10 000) source
rows and runs the **candidate** steps — the editor's unsaved draft — optionally stopping
after N. Steps that aggregate or reorder across the whole table therefore see only the
sample. `TransformStep::changes_row_count()` reports which those are, and the host
surfaces a "sampled" note rather than presenting a sampled total as final. Power Query
has the same caveat; stating it is better than hiding it.

Validation runs *before* the fetch, so a typo in a half-typed expression comes back
instantly rather than after a round trip to the database.

## What is deliberately NOT built

**Multi-table steps (`mergeTable` / `appendTable`).** Cleanly additive: the evaluator
takes a batch and a schema, so a `TransformTableProvider` reading other tables' cached
batches slots in. What it needs beyond that is refresh **ordering** — a topological sort
over the table dependency graph, with cycle rejection in `validate()`. That is a real
piece of work and it does not block anything shipped here.

**Query folding.** A leading prefix of a pipeline can fold into the existing
`FetchRequest`: `selectColumns` → `columns`, an AND-of-comparisons `filterRows` →
`filters` (the `fold_refresh_filter_now` machinery already folds exactly that shape),
`keepRows FirstN` → `limit`, `sort` → `order_by`, and for SQL sources an arbitrary prefix
→ a generated `source_query`. The seam would be `fold_prefix(steps, capabilities)`
gated on a new `ConnectorCapabilities` flag (the struct is `#[non_exhaustive]` with
false defaults, so adding one is non-breaking), failing **soft** to local evaluation —
matching the planner's existing posture of never returning a silently-wrong number.
Nothing in the shipped design blocks this: steps are declarative, evaluated
front-to-back, and the evaluator already takes an arbitrary sub-range.

## Where the code is

| Concern | Path |
|---|---|
| Step catalog + operand types | `model-engine-lib/crates/engine-core/src/transform/{step,parts}.rs` |
| Pure schema derivation | `.../transform/{schema,rules_columns,rules_rows,infer}.rs` |
| Validation (the allowlist) | `.../transform/validate.rs` |
| Script render + parse (one pair) | `.../transform/script/{lex,vocabulary,render,parse,mod}.rs` |
| Script round-trip battery | `.../transform/script/tests.rs` |
| Evaluation over batches | `.../transform/eval/{mod,sql_steps,kernel_steps}.rs` |
| Model-build enforcement | `.../model/schema/validation.rs` (`validate_table_transformations`) |
| Persistence | `.../model/source.rs` (`TableSourceBinding`), format version **24** |
| Refresh integration | `crates/engine/src/transform_apply.rs` + `refresh.rs` |
| Edit + preview API | `crates/engine/src/{transform_edit,transform_preview}.rs` |
| Host command | `app/src-tauri/src/bi/model_editor.rs` (`bi_model_transform`) |
| Host DTOs / `@api` | `app/src/api/backend.ts` |
| Step editor + Script tab | `app/extensions/ModelEditor/components/transform/` |
| Script editor language | `.../components/transform/transformScriptLanguage.ts` (vocabulary SERVED, never declared) |
| CLI verb | `app/extensions/ModelEditor/cli/` (`transform`) |
| CLI-to-engine drift guard | `.../cli/__tests__/transformScriptDrift.test.ts` |
| End-to-end journey | `app/e2e/journeys/model-transform.spec.ts` |
| REST source config + validation | `model-engine-lib/crates/engine-core/src/model/rest/` |
| REST connector | `model-engine-lib/crates/engine-query/src/rest_connector/` |
| REST source editor + secrets card | `app/extensions/ModelEditor/components/sections/RestSourceForm.tsx` |

The host-facing contract is recorded in
`model-engine-lib/docs/host-integration-changelog.md` under format version 24.
