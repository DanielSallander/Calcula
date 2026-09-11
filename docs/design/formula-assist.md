# The formula assistant, and the oracle it is measured against

Status: **M0 built 2026-09-07.** The offline grader, both corpora and the eval
runner exist and are gated in CI. The product surface (M1) is not built yet.

This is the record for the first milestone of the AI programme described in the
approved plan. Its job was never to ship a feature — it was to build the thing
that can tell whether a later feature works.

## 1. Why an oracle comes first

Everything the programme claims will be measured against a model's output, and a
model's output is plausible by construction. Without an independent decision
procedure, "the assistant writes good formulas" is an impression.

Calcula owns a deterministic formula engine, which makes an objective oracle
possible: propose a formula, evaluate it against a stated fixture, compare the
answer to what the task said it should be. That is the whole idea, and it is the
advantage the project has over a competitor that can only ask a second model
whether the first one was right.

## 2. What was built

| Piece | Where | What it does |
|---|---|---|
| Evaluation core | `core/calcula-format/src/ai/formula_verify.rs` | Seeds a fixture, settles it, evaluates a formula at its own address, reports spills and parse errors rather than guessing. Also the comparison rules. |
| Grader binary | `core/calcula-format/examples/eval-formulas.rs` | JSON in, JSON out, batched. No app, no WebView, no Tauri. |
| CI gates | `core/calcula-format/src/ai/corpus_tests.rs` | Four assertions over the corpora, run by `cargo test --workspace`. |
| Hand-written corpus | `tests/eval/formulas.json` | 60 tasks, 12 families, 12 Swedish, each with a distractor. |
| Pattern library | `app/scripts/gen-formula-patterns.mjs` → `app/src/api/formulaAssist/generated/formulaPatterns.ts` | Mined from `functions/*.md` and verified against the engine. |
| Shared prompt pieces | `app/src/api/formulaAssist/` | Context, retrieval, schema, prompt, normalisation. |
| Eval runner | `tests/eval/run-formula-eval.mjs` | Runs a model over the corpus and grades every answer with the engine. |
| Paired comparison | `tests/eval/compare-runs.mjs` | McNemar's exact test over two runs. |
| Matrix driver | `tests/eval/formula-matrix.mjs` | Runs the grid, one configuration at a time. |

## 3. Decisions that were not obvious

**The grader lives in `core/calcula-format`, not the app.** The app crate already
does this work in `ai/preview_eval.rs`, but it links the whole Arrow and
DataFusion tree, its test binaries need a Windows manifest patch before they will
load, and nothing under `app/` is exercised by the `cargo test --workspace` job CI
gates on. The blocker everyone expects — that a core crate cannot turn text into
an evaluable AST — does not exist: `core/engine` takes a real dependency on
`core/parser` and re-exports its `Expression`, so the engine's own tests parse and
evaluate in two lines. The app's `convert_expr` is a 3D-sheet expansion, not a
type conversion.

**The typed-entry ladder moved down to the engine.** A grader that seeds its own
fixtures is a second implementation of "what does this typed text become", and it
drifted immediately: `6%` became the string "6%" instead of 0.06, `$1,000` became
a string instead of 1000, and every financial example then failed against a
correct formula. The product's own ten-rung ladder had no app dependencies at all,
so it moved to `core/engine/src/typed_entry.rs` with a re-export left behind. Its
assertions now run in the workspace suite as well.

**A fixture takes the interactive ladder, not the invariant one.** `typed_entry`
offers both. `parse_cell_input_invariant` is script-facing and infers no format,
so an ISO date stays text; a fixture cell is text a person types, so it takes
`parse_cell_input` with an invariant locale. Choosing the obvious-sounding one
makes every date task fail silently.

**Numbers are compared as numbers.** `Cell::display_value` is style-independent
and prints non-integral floats with Rust's default formatting, so a correct answer
can render as `0.30000000000000004`. Comparing renderings rejects correct answers;
comparing values with a tolerance does not.

**Arrays are detected before they are collapsed.** `EvalResult::to_cell_value`
turns an array into its first element, so asking for the value before asking
whether it spilled reports a nine-value spill as a single number.

## 4. What the distractor rule buys

Every hand-written task names the plausible wrong formula a model reaches for,
and a CI gate requires that formula to FAIL the task. A task whose wrong answer
also passes cannot tell two models apart, and a corpus of those reports a number
that means nothing. The corpus was authored by a fan-out over twelve families
with an adversarial audit stage; the audit corrected 34 of the 60 tasks, mostly
argument order and fixtures with no excluded row.

At the time of writing: 60 of 60 references produce their stated answer, and 0 of
60 distractors pass.

## 5. The pattern library, and the leads it produced

406 function documents yield 650 candidate examples; 581 survive engine
verification. Roughly 81 are `doc` oracle, meaning the document states the answer
AND the engine independently reproduces it. The rest are `engine` oracle: the
example is real and the engine's own result is the expectation, which is useful
for teaching a model what a formula looks like and explicitly cannot detect an
engine defect.

Two parser traps cost most of the yield before they were found. `\s*` in a
heading regex crosses newlines, so `## Example` swallowed the grid's header row
and 345 of 406 documents reported no grid at all. An unanchored `**Result:**`
matched inside a table header row and captured the pipe that followed, so 98
documents stated their answer as the string `"|"`.

Where a document states a value the engine does not reproduce, the generator
names it rather than dropping it. Those are leads, not noise, and the surviving
set includes what look like genuine engine defects: `ODDFPRICE`, `ODDFYIELD`,
`ODDLPRICE` and `ODDLYIELD` return `#NUM!` where their documents expect a number,
`PERCENTRANK` disagrees, and `=FALSE()` and `AREAS` with a union argument do not
parse at all. None has been filed yet; each needs an owner call on whether the
document or the engine is wrong.

## 6. Retrieval, and why it needed fixing before it could be measured

Showing a small model two or three verified examples costs about 120 prompt
tokens. Whether that is worth paying is a question for the matrix, but a broken
retriever would answer it wrongly. Three defects were found against a live model
and fixed:

- **Formula string literals were indexed.** A document example's fixture
  vocabulary is arbitrary — "Sales", "North", "Geo[Region]" — and rare, so IDF
  made it dominate. A sales-by-region request retrieved `CUBEMEMBERPROPERTY`
  ahead of `SUMIFS`. Only the functions a formula CALLS are indexed now.
- **English words that are also function names won.** "rows that match only one"
  boosted the `MATCH` function. The exact-name boost is now case-sensitive, and
  a bare upper-case name counts only when it is longer than three characters, so
  a capitalised `AND` in a sentence is read as a conjunction.
- **Task vocabulary and dictionary vocabulary barely overlap.** A request says
  "add up the Amount where the Region is North"; the document says "sums values
  in a range that satisfy multiple conditions". A small task-verb lexicon bridges
  them, adding candidate function names that BM25 then ranks.

After those, the same request retrieves `SUMIFS`, `SUMIF`, `SUM`.

## 7. The measurement

The runner grades every proposal with the engine and reports a pass rate, median
and p90 latency, mean prompt tokens, and how many replies contained no formula at
all. Configurations differ by one thing at a time so a pair can be compared with
McNemar's exact test, which is the right instrument here: the runs are paired,
the discordant counts are small, and a corpus this size puts the standard error
of a pass rate near five points. A difference of "a few points" between two runs
is not a finding, and `compare-runs.mjs` says so in those words.

### The first numbers were the harness, not the model

Worth recording because it took twenty minutes to produce and one diagnostic to
disprove. The first run of `qwen2.5-coder:1.5b` scored 1 of 60, with 51 replies
reported as containing no formula at all. A coder model failing that way is not
credible, and it was not what happened.

The model wrote `=SUMIFS(C2:C10, A2:A10, "North", B2:B10, "Alice")` — correct —
and then looped inside the `assumptions` field, repeating one sentence until it
hit the runner's 300-token reply limit. The JSON object never closed, so parsing
failed, the balanced-object scan found nothing, and the line scan found no line
beginning with `=` because the formula sat inside a `"formula": "..."` field.
Every one of those 51 tasks had been answered.

Three changes came out of it, and the first is the one that matters:

- `extractProposal` now recovers the formula from an unterminated JSON object.
  A truncated reply still contains the only field that decides anything.
- The runner records `finish_reason` and warns, by name, when replies hit the
  token limit — because a truncated reply and a model that writes half a formula
  are indistinguishable in the output, and one of them is the runner's fault.
- The default reply budget went from 300 to 600 tokens.

The standing lesson is the one the repo already knows in another form: a
measurement that makes a model look broken is a claim about the harness until
the harness has been checked. The diagnostic that settled it was worth more than
the run that produced the number.

### Results, 2026-09-07

60 hand-written tasks, Ollama on a CPU-only Snapdragon X Elite, temperature 0,
schema on, context on, retrieval 3, no repair rounds. Every proposal graded by
the engine.

| model | cell | passed | median | prompt tokens | vs baseline |
|---|---|---|---|---|---|
| llama3.2:1b | baseline | 0/60 (0.0%) | 4.1 s | 458 | — |
| qwen2.5-coder:1.5b | baseline | 22/60 (36.7%) | 15.0 s | 458 | — |
| qwen2.5-coder:1.5b | no retrieval | 8/60 (13.3%) | 15.6 s | 419 | p = 0.0005, worse |
| qwen2.5-coder:1.5b | no context | 19/60 (31.7%) | 15.1 s | 392 | p = 0.375, n.s. |
| qwen2.5-coder:1.5b | lean schema | 22/60 (36.7%) | 18.1 s | 458 | p = 1.0, n.s. |
| qwen2.5-coder:1.5b | one repair round | 22/60 (36.7%) | 30.5 s | 458 | p = 1.0, n.s. |

Latency for the last four cells was measured while other work ran on the same
machine and is not comparable to the baseline's. Pass rates are unaffected:
grading does not depend on timing.

**Model choice dominates everything else measured so far.** At the same
parameter scale, a coder-tuned model goes from nothing to better than a third.
Nothing else in the matrix has moved a number nearly that far.

Failure modes, which say more than the totals:

| | llama3.2:1b | qwen2.5-coder:1.5b |
|---|---|---|
| passed | 0 | 22 |
| wrong value | 9 | 18 |
| did not parse | 36 | 11 |
| evaluated to an error | 7 | 8 |
| no formula in the reply | 8 | 1 |

The 1B fails at SYNTAX: 60% of its proposals are not formulas at all in the
grammatical sense. The 1.5B has largely stopped making that mistake and now
fails at MEANING, which is the failure a repair round can address and the
syntactic one cannot.

Per family, the 1.5B is uneven in a way a user would feel: logic 5/5, error
guards 4/5, running totals 3/5, then conditional aggregation, text assembly and
percentages at 2/5, lookup, text extraction, ranking and statistics at 1/5, and
dates and dynamic arrays at 0/5.

**Retrieval earns its tokens, decisively.** This was the open question the plan
named, and the answer is not close.

| | retrieval 3 | retrieval 0 |
|---|---|---|
| passed | 22/60 (36.7%) | 8/60 (13.3%) |
| mean prompt tokens | 458 | 419 |

Paired over the same 60 tasks: 7 both, 37 neither, 15 broken by removing
retrieval, 1 fixed, **McNemar exact p = 0.0005**. Three worked examples very
nearly triple the pass rate for 39 tokens, which is under a tenth of a second of
prompt processing even on the slowest model measured.

The tasks retrieval rescues are the ones where imitation is exactly the right
strategy: two-condition aggregation, anchored running totals, percent-of-total,
zero-padded text assembly, four-band grading. These are shapes a small model
recognises when shown one and guesses at otherwise.

This result also retro-justifies the three retrieval defects fixed before the
run. Without them the retriever returned `CUBEMEMBERPROPERTY` and `MATCH` for a
conditional-sum request, and measuring THAT would have concluded retrieval was
worthless.

**The context block: a positive trend, not a proven one.** Removing the
~66-token region description cost 5 points (36.7% to 31.7%), breaking 4 tasks and
fixing 1, McNemar exact p = 0.375. That is the direction one would hope for and
it is NOT significant at this corpus size. Keep the block, because it is cheap
and the trend favours it, but do not claim it is proven; settle it on the larger
corpus if it ever matters.

**A repair round bought nothing and doubled the wait.** This is the result that
most contradicts what the design expected.

| | one shot | one repair round |
|---|---|---|
| passed | 22/60 | 22/60 |
| median latency | 15.0 s | 30.5 s |

Paired: 1 fixed, 1 broken, McNemar exact p = 1.0.

The reason is visible in the per-task data and is worth more than the totals. Of
the 38 tasks that got a second round, the model returned a **byte-identical
formula 30 times**. At temperature 0, shown its own wrong answer and the engine's
specific complaint, it mostly repeats itself. Only 8 formulas changed at all.

That is the same failure the script-authoring loop found and named
`STALLED_AFTER_REPEATS`, rediscovered independently on a different surface. The
runner now detects it: a repair round that returns the previous formula retires
the task instead of spending another generation. For M1, the lesson is that a
repair loop needs the stall check before it needs more rounds, and that
verification feedback is not automatically actionable by a small model.

**Full schema versus lean schema: no difference.** Removing the free-text
`assumptions` array changed the pass rate not at all (22/60 both ways) and was
not faster. Paired over the same 60 tasks: 21 both, 37 neither, 1 each way,
McNemar exact p = 1.0. The rambling simply moved into `explanation`. Two runs
with identical headline rates that disagree on two tasks is exactly the case the
paired test exists for.

_(Caveat on that pair: a type-check ran concurrently with the first tasks of the
lean run, so its latency figure is not clean. The pass-rate comparison is
unaffected — grading does not depend on timing.)_

### What the numbers argue for

**Grammar-constrained decoding.** Even the coder model emits 11 unparseable
formulas in 60. A grammar makes that impossible rather than unlikely, and it is
the one intervention that addresses the failure mode directly. Ollama's
OpenAI-compatible endpoint has no grammar field; the llama.cpp server does. That
is an independent argument for the bundled runtime the owner already chose.

**A repair round does NOT pay, which the measurement had to say out loud.** The
prediction here was that the 1.5B's 18 wrong values and 8 error results were
exactly what a grader could describe back usefully. They were not: the model
returned the same formula 30 times out of 38. Spend the effort on retrieval and
on the grammar instead, and keep a repair round only behind a stall check.

**Latency needs attention before this ships.** A 15 second median is too slow to
feel like a feature, and most of it is decode spent on prose nobody reads: 52 of
60 replies hit even a 600-token limit. The lean schema was the wrong lever. The
right ones are an explicit brevity instruction, a hard cap on the explanation, or
stopping generation once the formula field closes.

### Bounding the schema fields, measured 2026-09-07 (M1)

The prediction above was tested. `maxLength` on every string field and `maxItems`
on the array were probed against Ollama 0.33.1, accepted (HTTP 200), and honoured
by its constrained decoder. The same 97-task corpus was then run twice on
`qwen2.5-coder:1.5b`, paired.

| | Unbounded | Bounded |
|---|---:|---:|
| Passed | 37 / 97 | 36 / 97 |
| Truncated replies | 84 | **0** |
| Replies with no formula | 1 | **0** |
| Median latency | 19 497 ms | **7 027 ms** |
| Wall clock | 1 929 s | **1 209 s** |

McNemar exact p = 1.0 on the paired outcomes: 34 both, 58 neither, 2 fixed by
bounding, 3 broken by it. **Correctness is unchanged and the wait is a third of
what it was.** Truncation, which was the mechanism behind the fake 1/60 score in
M0, is gone entirely rather than merely recovered from.

Bounding only `assumptions` does NOT work — a separate probe showed the model
moves the same padding into `explanation`. Every string field has to be bounded,
which is why the constants sit together in `schema.ts` with that reason written
next to them.

**The exit criterion for M1 is still not met, and by a wide margin.** The target
was ≥ 90 % verified-correct at ≤ 3 s. The measured figures are 37 % at a 7 s
median on this CPU. That is a statement about a 1.5B model on this machine, not
about the pipeline: the verifier means a wrong answer is never shown as right, so
the feature is honest at 37 %, just often unhelpful. Closing the gap is a model
and runtime question — grammar-constrained decoding, a larger local model, or a
cloud provider — not more prompt engineering.

### The grammar, measured on the built-in runtime — 2026-09-10 (Step 3 of 2.AI.10)

The paragraph above named grammar-constrained decoding as the next lever and could not pull it:
no runtime in the picker honoured a grammar. The bundled llama-server does
(`local-model-script-authoring.md` §14). `app/src/api/formulaAssist/grammar.ts` describes the same
JSON envelope the schema asks for, with the `formula` string held to formula syntax — numbers, text
literals with doubled quotes, error literals, array constants, calls as a SUFFIX so
`LAMBDA(a,b,a+b)(1,2)` parses, A1 and whole-row or whole-column ranges, quoted and bare sheet
names, structured references with or without the table name, defined names, the operators, `%` and
`#`, `@`. Function names are any identifier: the verifier refuses an invented one, and 526 names
would cost more tokens than the prompt. `FormulaAssist/__tests__/formulaGrammar.test.ts` matches
every corpus reference, every distractor and every pattern-library formula against it — as
`JSON.stringify` renders them, which is the escaping the model must produce — samples it three
hundred times into `extractProposal`, and pins what it refuses: `=SUMMA(A1;B1)`, an unbalanced
call, an open text literal, a sheet name with parentheses in it.

The same 97 tasks, the same runtime, the same day, the ladder's own prompt and retrieval:

| | Schema | Grammar (bounded) |
|---|---:|---:|
| Passed | 35 / 97 | 37 / 97 |
| Replies with no formula | 0 | 7 |
| Truncated replies | 0 | 7 |
| Median latency | 2 984 ms | 1 868 ms |
| p90 latency | 4 278 ms | 6 056 ms |

McNemar exact p = 0.69: 58 neither, 4 fixed by the grammar, 2 broken by it. **The grammar does
not change correctness on this model. It changes the wait, and the shape of a failure.** Under the
schema the runtime enforces `maxLength: 400` on the formula as a hard stop, so nothing loops. Under
the grammar every REPETITION is bounded — the first version was not, and measured 12 truncations
with a p90 of 11.6 s, one of them a single quote where a text literal belonged opening a "sheet
name" that swallowed `|)` and never closed — but NESTING cannot be expressed as a bound in GBNF, and
a 1.5B that starts `TEXTJOIN(TEXTJOIN(` runs to the 600-token limit inside the law seven times in
ninety-seven. The ladder reports those as declined with the length-limit sentence; none is shown as
a formula. The product keeps the grammar where the verdict is true, a third off the median for
equal correctness, and records the number to beat: on this model the exit criterion (≥ 90 % at
≤ 3 s) is as far away as it was, and the lever that remains is a larger model or a GPU — exactly
what §7 concluded before the runtime existed, now with the runtime in hand to measure it on.

## 8. What M0 deliberately did not build

The wire's structured-output field, the live `RegionContext` over a real sheet,
the F0–F3 ladder as a product surface, and the popover all belong to M1. The
runner reaches an OpenAI-compatible endpoint directly, exactly as the script eval
runner does, because it runs headless with no app and no keychain.
