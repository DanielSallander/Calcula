# Script-authoring eval

Can a given model write Calcula object scripts? This answers it with a number
instead of a vibe.

Six siblings live beside it: `run-formula-eval.mjs` (formulas, graded by the
engine — see `docs/design/formula-assist.md`), `run-design-query-eval.mjs`
(design queries, graded by the DSL compiler and `canonical.ts`),
`run-next-edit-eval.mjs` (the next-edit row's model chip),
`run-macro-fim-eval.mjs` (filling in a held-out line of a script),
`run-narration-eval.mjs` (wording computed facts without inventing numbers) and
`run-intent-eval.mjs` (the chat's intent router, no model at all) — the last
four are described below:

```
node tests/eval/run-design-query-eval.mjs --provider ollama --model qwen2.5-coder:1.5b
node tests/eval/run-design-query-eval.mjs --provider llamacpp --model default --grammar on
node tests/eval/run-design-query-eval.mjs --provider ollama --model qwen2.5-coder:3b \
     --examples off --repair 1 --json out/dq.json
```

Its corpus is `design-queries.json` over the sales-star fixture; Layer A is
`app/extensions/_shared/dsl/pivotLayout/designQueryCorpus.test.ts`. It drives
the PRODUCT's own loop (`draft.ts`) with a provider over a bare endpoint, so
the number is about the model, never a port of the pipeline. `--grammar on` is
refused for any provider but llama.cpp's server, which is the only one that
honours the field. `run-formula-eval.mjs` takes the same `--grammar on`, which
replaces the reply schema with `buildFormulaGrammar` (the same envelope, the
formula inside it constrained to formula syntax).

**Measuring the BUILT-IN runtime.** The app's own copy of llama-server and the
on-board model are fetched artifacts:

```
cd app && npm run fetch:llama-server && npm run fetch:builtin-model
app/src-tauri/binaries/llama-server-<triple>/llama-server.exe \
  -m app/src-tauri/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 -c 8192 -np 1 --jinja --no-webui
node tests/eval/run-design-query-eval.mjs --provider llamacpp --model calcula-builtin --grammar on
node tests/eval/run-formula-eval.mjs --provider llamacpp --model calcula-builtin --grammar on
```

Those are the flags `ai/runtime.rs` starts it with, so a run on port 8080 is a
run on the product's runtime; only the port differs.

## `run-narration-eval.mjs` — can the on-board model word facts without inventing numbers?

```
node tests/eval/run-narration-eval.mjs --provider llamacpp
node tests/eval/run-narration-eval.mjs --provider llamacpp --locale sv-SE --show-replies
```

Needs the `narration` helper built first (PowerShell, because the MSVC
environment is a PowerShell script):

```
. .\core\setup-rust-env.ps1
$env:CARGO_TARGET_DIR='C:\Users\Salle\AppData\Local\calcula-target'
cd core; cargo build -p insights --example narration
```

**Nothing here re-implements the product.** The fixtures, the prompt, the reply
schema and the citation check all come out of that helper, which is the same
Rust the product calls. A JavaScript port of the check would be a second opinion
about `number.rs`'s rounding bands, its scientific cut-off and the sv-SE
non-breaking space, and the run would then measure the port.

**The control is the engine itself.** Every run first pushes the DETERMINISTIC
narration of all five bundles through the same check and stops with exit 3 if
any of it is rejected — a narrator that only prints numbers its fact contains is
the definition of what must pass, so a rejection means the checker is wrong and
any model score would be fiction. All 41 survive.

As measured 2026-09-11 (qwen2.5-coder-1.5b, 5 bundles, 41 facts, 12 kinds):

| | en-US | sv-SE |
|---|---|---|
| bundles clean (a showable sentence, nothing invented) | 1/5 | 0/5 |
| sentences surviving | 3/9 (33 %) | 6/23 (26 %) |
| **numbers the cited facts could not account for** | **56 %** | **74 %** |
| coverage of ranked facts | 27 % | 17 % |
| median latency (gate 8 s) | 30.4 s | 34.4 s |

So the narrator does not ship — and the check deleted **22 fabricated numbers**
across the two runs, which is the more useful half of the result.

## `run-macro-fim-eval.mjs` — can the on-board model fill in a line of script?

```
node tests/eval/run-macro-fim-eval.mjs --provider llamacpp
node tests/eval/run-macro-fim-eval.mjs --provider llamacpp --surface 0   (the baseline)
node tests/eval/run-macro-fim-eval.mjs --provider llamacpp --json out/fim.json
```

The corpus is DERIVED: every `reference` in `tasks.json` is a correct object
script stored as lines, so holing out each eligible line gives 141 tasks whose
right answer is known and whose context is real. From the SECOND line on — an
empty prefix asks a model to invent a file rather than fill a gap, and measured,
it answered `filename='src/components/MyComponent.js'`. The coupling is worth
saying out loud: those references exist to grade authoring, so improving them
moves this number too.

It refuses to run unless prefix + the right answer + suffix rebuilds the original
byte for byte, and it prints a naive "repeat the line above" baseline first, for
the same reason the next-edit runner prints its Tier-0 one: a score means nothing
until something says what it is worth.

**This one does NOT go through the completion seam, and cannot.** `/infill` is at
the ROOT of llama-server, not under `/v1`; `ChatRequest` has no prefix/suffix
fields and picks its URL from a closed match; and the runtime runs `--jinja`, so
a chat request wraps the prompt in Qwen's template and destroys the
fill-in-the-middle conditioning outright. `--provider` is refused for anything
but llama.cpp: Ollama serves FIM only on its native `/api/generate` with a
`suffix` field, and the cloud providers have none.

As measured 2026-09-11 (qwen2.5-coder-1.5b, 141 tasks, p is McNemar exact
against the 600-token run). "Reachable" is how many of the 103 answers naming a
`context.<chain>` had every chain in the surface actually sent:

| budget | reachable | exact | median | p |
|---|---|---|---|---|
| off | — | 8 (5.7 %) | 712 ms | 0.0001 |
| 300 | 38/103 | 13 (9.2 %) | 924 ms | 0.0018 |
| **600** | 42/103 | **25 (17.7 %)** | 1033 ms | — |
| 1500 | 60/103 | 20 (14.2 %) | 1360 ms | 0.1797 |
| 2500 | 98/103 | 26 (18.4 %) | 1558 ms | 1.0000 |

Read the reachable column first. `rankSurface` puts capability chains ahead of
every grid member, so `getCellValue` does not appear below 2500 — and covering
98 of 103 answers instead of 42 moves the score by ONE task. Vocabulary is not
the constraint; the first ~600 tokens win by supplying capability names and the
`onClick` idiom, and the flipped tasks are the `cap-*` and `trap-*` ones. Better
retrieval is not the lever here: `--hints buffer` scored 18 (p 0.0391, WORSE).
The naive floor is 0 of 141, but structurally — the eligibility filter removes
every repeated line — so it licenses nothing.

## `run-next-edit-eval.mjs` — is the model's next-clause chip worth showing?

```
node tests/eval/run-next-edit-eval.mjs --provider llamacpp --model default
node tests/eval/run-next-edit-eval.mjs --provider ollama --model qwen2.5-coder:3b --limit 20
node tests/eval/run-next-edit-eval.mjs --provider llamacpp --model default --grammar off
```

A different question from drafting. The person is TYPING a design query, not
describing one, so there is no request to interpret — only "what comes next".
Every prefix of every correct query in `design-queries.json` becomes a task, and
each complete query becomes one more where the right answer is **silence**.

It reports three things, and they are separate on purpose:

- **exact next clause**, over prefixes — what the chip is for;
- **quiet on a finished query** — a chip here is a nag, and a nag is how a
  person learns to ignore the row the RULES are also on;
- **median and p90 latency**, warm. The gate is `--gate-median-ms` (400 by
  default) and the process exits non-zero when it is missed.

Beside them it runs the Tier-0 rules over the same prefixes, so one run answers
the question the milestone actually asks: what does the model ADD over rules
that read the strategy?

Nothing in it is a re-implementation. `buildNextClauseRequest` builds the same
prompt and grammar the row sends (including its token budget),
`nextClauseSuggestion` reads the reply the same way, `rulesChips` is the row's
own chip loop and `worseThan` its own compile veto. **And it refuses to run
unless it can score its own oracle**: each reference's own next line goes
through that same scorer first, and a single miss exits 3 rather than reporting
a flawless zero. A scorer that cannot recognise a right answer produces exactly
the number a bad model produces. The Tier-0 baseline is computed the same way,
up front and loudly, because a crashed baseline reads as a baseline of zero and
turns every model hit into "something the model added".

It also runs the oracle through the compile veto, which is how it knows the
ceiling is 79 rather than 80: one corpus task's correct next clause is `LAYOUT:
subtotals-off`, the compiler has no case for `subtotals-*` and warns, and the
veto refuses a chip that adds a warning. The runner prints the ceiling instead
of scoring an unwinnable task as a miss.

`--grammar` is refused for any provider but llama.cpp's server, for the reason
the sibling gives: every other runtime ignores an unknown body key in silence,
so the run would report `grammar=on` having measured no grammar at all. Request
errors fail the gate too — a server that dies mid-run otherwise shrinks every
denominator and the survivors can look fine.

As measured 2026-09-11 on the built-in runtime (qwen2.5-coder-1.5b, grammar
honoured): exact 0/80, rules alone 19/80, quiet 0/52, median 686 ms. The chip
therefore ships OFF (`MODEL_CHIP_DEFAULT`), and this runner is what will decide
when a better model turns it on. Layer A is
`app/extensions/_shared/dsl/pivotLayout/nextEditCorpus.test.ts`, which runs the
same rules over the same prefixes in CI with no model at all.

The corpus is `tasks.json`. It ships in the repo deliberately (design doc
§11.3): withholding it would make every claim about which models work
unfalsifiable, which is a poor look for a project whose pitch is auditability.
It is a developer/CI artifact — no UI, no support promise, the same standing as
any other test suite here.

## `run-intent-eval.mjs` — does the chat decide what a message IS before any model turn?

```
node tests/eval/run-intent-eval.mjs
node tests/eval/run-intent-eval.mjs --split held-out --show-misses
node tests/eval/run-intent-eval.mjs --json out/intents.json
```

No model, no provider flag: the router is deterministic rules
(`app/extensions/AIChat/lib/intentRouter.ts`) over the message and the loaded
semantic model's field names, and this runner bundles the product's own router
and field index (`@api/biModelFields`) with `tests/fixtures/model/sales_star.json`
open, so it scores exactly what the chat would route with that model loaded.
The corpus is `intents.json`: 214 utterances over nine intents, every one drawn
from a prompt some other corpus or session already contained, with the
known-defect regressions (`rg-*`) that trip the substring traps the old
detectors had.

It reports a **macro average** first — 122 of the 214 rows are `bi-query`, so a
raw accuracy would mostly be a score for one intent — and then the number the
design actually gates on: **precision on the decisive subset**, which is 100 %
or the router is wrong. A decisive wrong route is apply-formatting-over-the-
wrong-range and it is silent; a wrong lean only costs the model its narrowed
tool list. Rows the corpus marks non-decisive earn credit for a clarify pair
that contains the expected intent, never rows the rules were expected to settle.

**The split is the honest part.** The rules were derived from this corpus's own
vocabulary and their author read every failure of the prototype before writing
them, so `held-out` is "id hashes odd AND never inspected during authoring" —
`run-intent-eval-split.mjs` pins the inspected ids by name, and the CI gate
(`app/extensions/AIChat/__tests__/intentRouter.corpus.test.ts`) imports the
same module so the two cannot disagree about which rows were held out. `tune`
is the fitted number, `held-out` the earned one, `all` what CI pins.

As measured 2026-09-16 when the router shipped: all 214 — macro 98.9 %, raw
213/214, decisive precision 100 % (0 wrong of 201 decided), 0 false scripts,
2 clarified; tune 118/118; held-out 96 — macro 97.8 %, 95/96. The two detectors
it replaced scored 24/214 raw on the same corpus with three of nine intents
reachable; that arm cannot be re-run (one detector is deleted, the other's
trigger list rewritten) and the figure is recorded here and in `open-items.md`
2.AI.10 instead.

## Two layers

**Layer A — the corpus checks itself. No model, runs in CI.**

Every task carries a `reference` solution, and
`app/src/api/scriptHost/scriptEval/__tests__/corpus.test.ts` runs each one
through the real validator. A task whose own answer does not validate is not a
hard task, it is a broken one — it would mark every model wrong for refusing to
reproduce a mistake. Because the references are checked against the LIVE API
surface, a task also rots the moment the API moves underneath it, which is
exactly when someone needs to be told.

```
cd app && npx vitest run src/api/scriptHost/scriptEval
```

**Layer B — score a real model. Needs a provider, costs tokens, opt-in.**

```
node tests/eval/run-eval.mjs --provider ollama --model qwen3-coder:30b
node tests/eval/run-eval.mjs --provider ollama --model llama3.3:70b --canary
node tests/eval/run-eval.mjs --provider openrouter --model anthropic/claude-opus-4-8 --json out.json
```

`--canary` runs only the subset the in-app model picker uses, which is the same
subset M7 reports as `canaryScore`. Both layers read `tasks.json`, so the number
a user sees in the picker and the number CI reports cannot diverge.

## What a score means

The static half, weighted (this is the whole score for a task without an
`outcome` block, and for the in-app probe, which never executes model output):

| component | weight | why |
|---|---|---|
| parses | 0.05 | table stakes |
| has a `setup` entry point | 0.10 | without one the script mounts and does nothing |
| calls only real methods | 0.30 | an invented API cannot be recovered from without a repair round |
| declares the capabilities it uses | 0.25 | an undeclared one passes review and dies at run time |
| declares no more than it uses | 0.10 | over-declaring only raises a reviewer notice — the system working |
| does what was asked | 0.20 | weak by design: it checks the required calls happened, not that the arithmetic is right |

## Expected-diff grading

A task with an `outcome` block is also GRADED: the candidate is executed
against the task's `fixture`, the task's `event` hook is fired exactly as the
product fires it (a button click reaches `context.onClick(handler)` and nothing
else), and the cells named in `expect` — plus any `expectOutput` substrings —
are compared against what the run actually produced. Values are cell INPUT
STRINGS, the same vocabulary `ai_dry_run_script`'s `readBack` reports.

For a graded task the score is `0.5 * static + 0.5 * grade`, and `passed`
additionally requires a perfect grade — a script that is statically flawless
and writes the wrong value is the silent-corruption class, and it caps at 0.5.

The executor (`app/src/api/scriptHost/scriptEval/harness.ts`) mounts the
candidate through the REAL worker-realm machinery — `buildWorkerContext`,
`wrapModuleSource`, the production hook dispatcher, the production `ALLOWLIST`
validators and capability ceiling — over an in-memory grid. Only the backend is
fake; a real member the backend does not serve marks the run UNGRADABLE, never
wrong. Layer A holds the whole thing honest: every reference must grade 1.0,
so a harness-vs-product semantic drift reds CI before it can mislead a model
score.

`run-eval.mjs` executes candidates in a SUBPROCESS (`grade-child.mjs`): model
output is untrusted, so it gets a scrubbed environment (no provider key),
Node's permission model where available (no fs writes, no child processes), and
a hard 10s kill that even a synchronous infinite loop cannot outlive.

In `--repair` mode the harness also serves as the loop's L3 hook, so "it throws
when run" and "it runs and changes nothing" are repairable offline.

## Adding a task

Write the `reference` FIRST, then run Layer A. If it fails L1 you invented a
method; if it fails L2 your pragmas are wrong. Either way the task was not yet a
fair test of anything.

Keep `mustCall` to what a correct solution genuinely has to do. Over-specifying
it scores a model down for solving the problem a different, valid way.

For a button task, the reference registers its click handler with
`context.onClick(handler)`. `context.expose('onClick', ...)` mounts cleanly and
NEVER fires on a click — the corpus itself shipped teaching that dead shape,
and the grading harness is what caught it.

When adding an `outcome`, pick fixture values that separate right from wrong —
the adversarial review of this layer found seven fixtures a WRONG script could
pass, and the corrected patterns are worth copying:

- the sum fixture holds a text distractor and non-integer values, so unguarded
  `Number()` accumulation and `parseInt` both fail;
- the sort fixture DECORRELATES the key column from the other columns' order,
  so sorting by the wrong column cannot reproduce the expected grid;
- guard tasks seed the cell the unguarded branch would DESTROY (`confirm:false`
  with cells that must survive; an empty-input guard with a pre-seeded target);
- persistence tasks fire the event twice (`eventCount: 2`) — one click cannot
  tell a counter from a reset;
- error-handling tasks inject a real failure (`stubs.failWrite`) — without one
  the error branch is unexercisable;
- counts use `matchOutput` with an anchored regex — a bare "3" substring also
  matches coordinates and "13";
- source cells are pinned too, so copy-as-move fails;
- anything the expectation pins must be named in the INTENT (the cell, the
  note text, "a SUM formula") — an expectation the user's words don't imply
  grades correct alternatives wrong.

Prefer `match` for cells where several spellings are equally correct, and run
Layer A: if your reference grades below 1.0, the expectation or the harness is
wrong — never the model.
