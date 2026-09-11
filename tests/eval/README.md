# Script-authoring eval

Can a given model write Calcula object scripts? This answers it with a number
instead of a vibe.

Two siblings live beside it: `run-formula-eval.mjs` (formulas, graded by the
engine — see `docs/design/formula-assist.md`) and `run-design-query-eval.mjs`
(design queries, graded by the DSL compiler and `canonical.ts`):

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

The corpus is `tasks.json`. It ships in the repo deliberately (design doc
§11.3): withholding it would make every claim about which models work
unfalsifiable, which is a poor look for a project whose pitch is auditability.
It is a developer/CI artifact — no UI, no support promise, the same standing as
any other test suite here.

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
node tests/eval/run-eval.mjs --provider anthropic --model claude-opus-4-8 --json out.json
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
