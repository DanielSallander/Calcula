# Script-authoring eval

Can a given model write Calcula object scripts? This answers it with a number
instead of a vibe.

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

Per task, weighted:

| component | weight | why |
|---|---|---|
| parses | 0.15 | table stakes |
| calls only real methods | 0.30 | an invented API cannot be recovered from without a repair round |
| declares the capabilities it uses | 0.25 | an undeclared one passes review and dies at run time |
| declares no more than it uses | 0.10 | over-declaring only raises a reviewer notice — the system working |
| does what was asked | 0.20 | weak by design: it checks the required calls happened, not that the arithmetic is right |

The last row is honest about being weak. The strong check is a dry run against a
cloned workbook with a diff, which needs a live app — that belongs to the
harness, not to a corpus file.

## Adding a task

Write the `reference` FIRST, then run Layer A. If it fails L1 you invented a
method; if it fails L2 your pragmas are wrong. Either way the task was not yet a
fair test of anything.

Keep `mustCall` to what a correct solution genuinely has to do. Over-specifying
it scores a model down for solving the problem a different, valid way.
