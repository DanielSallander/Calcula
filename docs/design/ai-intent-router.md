# The intent router (AI programme M4) — design recovered 2026-09-11, built 2026-09-16

Status: BUILT 2026-09-16. §6 records what was built, what deliberately differs from §3, and what
§5 still blocks. §§1–5 are left as written on 2026-09-11 because they are the argument for the
ordering and the record of what the code looked like before; §2 describes modules that no longer
exist in that form. Step 5 of the AI programme's build order (owner decision D5).
Companion documents: `local-model-script-authoring.md` (where the routing evidence was measured),
`insights-strategy-layer.md` §14 (the consumers a router would dispatch to), `open-items.md` 2.AI.12
(the build record) and 2.AI.10 (the programme's steps).

## 0. Why this file exists at all

`open-items.md` has said since 2026-09-07 that "M4 (intent router) … keeps its design and its
seams". **It cited no file, and there was none.** The design lived only in a plan-file snapshot under
a user profile directory — outside the repository, outside version control, and invisible to anyone
reading the docs. A scout looking for it in 2026-09-11 concluded from `docs/` alone that no design
existed, which is exactly the citation rot `open-items.md` warns about happening to this repository's
own claim. This file is that design, copied in before it was lost, with the state of the code it
would replace measured at the same time.

**A NAMING TRAP, because a grep will find the wrong one.** There are two unrelated milestone series
using "M4". `local-model-script-authoring.md:1035` — "M4 — Sliceable typings. SHIPPED 2026-08-19" —
is the script-authoring series. The router is the AI-programme series: M0 grader, M1 formula
assistant, M2 on-board runtime, **M4 router**, M5 flywheel (dropped), M6 narration, M7 telemetry.

## 1. The evidence the design rests on, which is unusually direct

Every measurement this programme has taken points the same way: **models are good at GENERATING and
bad at ROUTING**, and the gap does not close with model size.

| finding | where |
|---|---|
| 24 tools → 0 of 4 real tool names; 12 tools → 4 of 4; the 10-tool core → 4 of 4 | `local-model-script-authoring.md:1481-1486` |
| the 7B invents at 24 tools **exactly as the 3B does** — size did not fix it, surface size did | `:1568-1573` |
| with the core set the model formats cells reliably and **never** chooses `draft_object_script` | `:1506-1512` |

That last row is the router's job description, and the doc states it plainly: "a 3B model failing to
distinguish a request for automation from a request for the outcome, and no prompt wording tested
here changed it."

Three model-backed features were measured on the bundled 1.5B in September 2026 and **none shipped
on**: the design-query next-clause chip (0 of 80), macro fill-in-the-middle (18 %, and a second per
line), insights narration (a fabricated number in 56 % of English sentences, 74 % of Swedish). None
of those is a classification task, so they argue for caution rather than settling it — but they
settle the SHAPE. Deterministic dispatch to a verified specialist, with a model used only to fill a
slot something else then checks, is the only thing that has worked here.

## 2. What exists today, and why it is not a router (measured 2026-09-11)

Three modules, each ~100 lines, pure, no model call anywhere, with exactly one production caller
between them: `ChatView.tsx`'s `send()`.

- `AIChat/lib/scriptIntent.ts` — "is this a request to author something durable, and what object
  does it attach to?" Twelve trigger words, six suppressors, a 17-entry type table.
- `AIChat/lib/analysisIntent.ts` — "is this a question about what the data says?" 23 words (English
  and Swedish), a phrase list, a veto list.
- `AIChat/lib/tierZero.ts` — not a detector at all. It is the ACTION behind `analysisIntent`, and it
  is the only one of the three already router-shaped: an ordered decision table with documented
  precedence and a fail-open catch.

**Five things a router has to fix, found by reading the code rather than by running it.** Each is a
one-line check to confirm once someone is editing these files.

1. **The two detectors run unconditionally and independently, with no arbitration.** "Write a macro
   that flags outliers every month" matches both, so the transcript gets the Tier-0 fact bundle AND
   the script offer card — and if the person accepts the offer, the facts are dropped on the floor.
   Deciding between them is the whole point of M4.
2. **`scriptIntent` matches its own trigger list with `String.includes`, not with the `mentionsWord`
   primitive the same file exports** — whose doc comment says `includes` "was WRONG, not merely
   loose". So "add a description to the chart" fires the script offer, because *description*
   contains *script*. So do *subscription*, *transcript*, *prescription*, and *macroeconomic* for
   *macro*.
3. **The suppressor `"just "` is substring-matched too**, so "adjust the totals" silently kills the
   script offer: *adjust* contains *just*. A suppressed offer leaves no trace, which is the worst
   shape for a defect.
4. **`analysisIntent`'s "defer to the formula assistant" veto has no destination.** The chat has no
   formula tool and never touches `getFormulaAssistProvider`, so the veto means "send it to the
   model with no facts" rather than "send it somewhere better".
5. **The script detector's object-type guess drives a ~6,000-token API-surface build for EVERY
   message**, including a pure "analyse this" — which is precisely the surface size the measurements
   above say destroys tool selection.

Two of the seventeen legal draft object types, `panel` and `range`, have no hint word at all and
silently take the `button` surface.

## 3. The design

**Taxonomy — nine intents:** `formula`, `format`, `data-op`, `analyze`, `chart`, `script`,
`bi-query`, `question`, `unclear`. Every tool the chat has is reachable from some specialist, and
that is pinned by a test. **Only `script` carries the API surface**; every other specialist targets
≤ 800 prompt tokens (`data-op` and `bi-query` ≤ 1,100).

**The router — `AIChat/lib/intentRouter.ts`, absorbing `scriptIntent.ts`:**

1. **Deterministic rules first.** English and Swedish word tables per intent, matched with
   `mentionsWord` — never `includes`. Precedence: a strong `script` beats `format`; `bi-query` beats
   `analyze`; a leading `=` is `formula`. Exactly one strong class is decisive; two produce a fixed
   clarifying question for that pair; a short follow-up with a remembered `lastIntent` is sticky.
   **A decisive rule must be ≥ 99 % precise**, because a decisive wrong route is the
   apply-formatting-over-the-wrong-range failure.
2. **One schema-constrained call, ~250 tokens**, `{intent, objectType?, confidence}` as string
   enums, temperature 0, 40 reply tokens — and ONLY when the rules were not decisive and the model
   is not the assisted tier.
3. **`low` or `unclear` → one fixed question with buttons** that set the intent. "Not now" falls to
   `question`.

**Specialists — `lib/specialists.ts`:** each carries a tool subset (≤ 8, with shorter descriptions
than the global ones), a system prompt, context lines (the selection, plus prefetched region context
through one `read_cell_range`, which saves a model turn), a token ceiling, and `needsSurface`.
`formula` and `analyze` are DIRECT calls to `@api/formulaAssistService` and `@api/insightsService`
that render cards — no tool loop at all. Apply buttons still go through `ai_chat_run_tool`, like
every other write. A `script` intent on an assisted-tier model goes straight to the guided
`authorScript` job.

**ChatView:** route before the loop; take `tools`, `system` and `maxTokens` from the specialist;
key unknown-tool-name handling per specialist; print a one-line transcript notice — "Routed as
format (matched: bold, background) — 4 tools". `MAX_TOOL_TURNS`, the doubt/confirm path,
`AUTORUN_TOOLS` and `draftGate` are untouched.

## 4. The corpus comes first, and it does not exist

`tests/eval/intents.json`: ≥ 120 utterances, ≥ 40 Swedish, confusable pairs ≥ 10 each, drawn
verbatim from the prompts already reported in the script-authoring doc rather than invented.
`run-eval.mjs --intents` scores it, and a CI table test pins **100 % precision on the decisive
subset** — a rule that fires must never be wrong, even if many rules never fire.

**Targets:** rules-only ≥ 80 %; rules + a 7B ≥ 92 %; script/format confusion ≤ 3 %.

**As built (2026-09-11): 170 utterances, 48 Swedish, 147 in the decisive subset.** Composition:
`bi-query` 40, `script` 35, `data-op` 21, `analyze` 17, `formula` 16, `format` 16, `chart` 9,
`question` 9, `unclear` 7. Confusable pairs at ten or more: analyze/bi-query 42, data-op/script 22,
format/script 13, formula/question 11, analyze/question 10. The remaining pairs are left at whatever
the real corpora produced — padding all sixteen to ten would mean inventing utterances nobody would
type, and a corpus whose hard cases are imaginary reports a precision about imagination.

### 4a. What the corpus already says, before any router exists

Two things fall straight out of it, by string arithmetic and with no model involved.

**The substring traps are real.** Seven of the nine regression utterances were confirmed to trip
them: *description*, *subscription*, *transcript* and *prescription* all match the trigger `script`
as a substring and none of them as a word; *macroeconomic* matches `macro`; and *adjust* and
*readjust* both match the suppressor `"just "` as a substring while carrying a genuine automation
signal (`automatically`, `every time`). The other two regression cases are not substring cases at
all — they are the dual-match ones, where both detectors fire and nothing arbitrates.

**And the bigger one: the current trigger table would miss most real script requests.** Of the 31
genuine `script` utterances in the corpus, **23 carry no trigger word at all, even matched as a
word** — "when this button is clicked", "every 15 minutes, and keep doing it after the workbook is
reopened", "remembering the count across sessions", "ask the user to confirm", "expose a command",
"log the value of A1", "pop up a message", "so it survives reopening". The existing twelve-word list
is built from how a person describes *automation in the abstract*; these are how a person describes
*a thing that keeps happening*. A rule table for `script` has to be built from durability signals —
an event ("when … is clicked", "whenever … changes"), a schedule ("every 15 minutes"), persistence
("across sessions", "survives reopening"), an interaction at run time ("ask the user", "pop up"),
or an exposed entry point ("expose a command", "make a form") — and not from the word *script*.

That finding cost one pass over a corpus that did not exist this morning, and it would have cost a
rewrite of the router had the router been written first. It is the whole argument for the ordering.

### 4b. The rule vocabulary, derived rather than guessed

Taking every 1-, 2- and 3-gram that occurs at least twice in one intent and **never in any other**
— which is what a decisive rule needs, precision over the corpus rather than frequency — gives this,
and four of the nine results change the design.

| intent | phrases that appear only there |
|---|---|
| `script` | log, when, button, whenever, every time, ask, show it, then |
| `bi-query` | segment, category, by category, year, region, margin, revenue by category, country, customers, as columns |
| `format` | format, light grey background, decimal, mm dd, background |
| `formula` | median, c7, b2 b100, 0 (from `#DIV/0!`) |
| `chart` | chart |
| `question` | excel, calcula |
| `data-op` | ta bort, kolumn a, column a, the first |
| `analyze` | leads, these numbers |
| `unclear` | **none** |

**`bi-query` is not decidable by keywords, and does not need to be.** Its decisive tokens are not
vocabulary at all — they are *segment*, *category*, *region*, *margin*, *revenue*, *customers*: the
names of measures and dimensions in the loaded semantic model. The rule should therefore be "the
message names a measure or a dimension of the current model", which is exact, needs no word list in
either language, gets Swedish for free, and improves by itself as a model gains fields. No keyword
table can imitate it, and neither existing detector does it.

**But it is not free, and the difference matters.** The chat reaches the semantic model only through
TOOLS — `list_connections`, `describe_bi_model` — which means a model turn, which is the thing a
router runs *before*. There is no synchronous `@api` seam handing field names to the renderer. So
this rule needs the names cached: `get_connection_bi_model` already exists as a command and
`PivotEditor` already holds its result at connection level for exactly this kind of use, so the
router can do the same and re-fetch on `bi:model-changed`. Cheap, but it is a seam to build, not a
list to write — and a design that said "just check the model's names" without saying where they come
from would have been found out at implementation time.

**`unclear` has no vocabulary and must not be given one.** It is defined by ABSENCE — no cell
reference, no named surface, no verb from any other table — so it belongs as the fallback arm, not
as a class with rules of its own. A phrase list for "unclear" would be a list of things people say
when they are being clear about something the list has not thought of.

**`analyze` is the weakest, and the corpus says why.** Its obvious words — *trend*, *outlier*,
*correlation* — are not decisive because they also appear in `bi-query` and `chart` utterances,
which is exactly the analyze/bi-query pair the corpus is densest on (42 of the confusable entries).
That pair is settled by the design's stated precedence — `bi-query` beats `analyze` — and now there
is a reason for the precedence rather than a preference: a message that names model fields is asking
for a report, and one that names a statistic without them is asking for an analysis.

**`script` confirms §4a from the other direction.** Its decisive phrases are events, schedules and
run-time interactions — *when*, *whenever*, *every time*, *button*, *ask*, *log*, *show it* — and
the word *script* is not among them, because it is not what people type.

This ordering is not optional and it is not new. The design-query corpus preceded the drafting loop;
the fill-in-the-middle corpus preceded any FIM code; the citation check preceded the narrator. D5
says "each measured before the next". **The corpus is the first deliverable of Step 5, not the
router.**

## 5. What the router cannot route to yet

A scout of every AI-backed surface found the chat can reach exactly four destinations today: the
tool loop, the Tier-0 analysis pre-route, the guided script author, and "open this draft in the
editor". The three richest surfaces this programme built are reachable ONLY from their own panels
and are invisible to the chat: the formula assistant, the design-query drafting row, and "Edit with
AI" in the script editor.

Two concrete blockers for anything bidirectional:

- **`registerChatPromptSink` (`@api/chatPromptService.ts:31`) has no caller anywhere.** AIChat
  implements no `openWithPrompt`, so `hasChatPromptSink()` is permanently false and the Insights
  pane's "Send to chat" button never renders. The one designed route INTO the chat is dead code with
  only tests as consumers.
- **The design-query drafting assistant has no headless seam.** Unlike the formula and script
  assistants, drafting a design query exists only as a React row needing a host-supplied
  `connectionId` and dry run, because `@api` may not import the DSL compiler. Routing to it today
  means opening an editor, not calling a specialist.

And there is no narration destination at all: Step 4 shipped the citation check and the
measurement, not a surface.

## 6. As built, 2026-09-16

Measured on `tests/eval/intents.json` — 214 utterances, regenerated from the other corpora by
`gen-intents.mjs` and pinned in CI by `check:intents` — with `tests/fixtures/model/sales_star.json`
as the loaded model, by `tests/eval/run-intent-eval.mjs`:

| split | n | macro | raw | decisive precision | false scripts | clarified |
|---|---|---|---|---|---|---|
| all | 214 | 98.9 % | 213/214 | 100 % (0 wrong of 201 decided) | 0 | 2 |
| tune | 118 | 100 % | 118/118 | 100 % (0 of 112) | 0 | 0 |
| held-out | 96 | 97.8 % | 95/96 | 100 % (0 of 89) | 0 | 2 |

Per intent over all 214: `formula` 9/10, every other intent 100 %; all nine `rg-*` regression cases
route correctly. The two detectors this replaced scored 24/214 raw on the same corpus, with three of
nine intents reachable and 23 of 35 script requests missed. Both §4 targets are cleared on the
held-out half by rules alone (80 % rules-only; 92 % rules + a 7B).

**What "held-out" means here, because the rules were derived from this corpus.** §4b took the
rule vocabulary from the corpus itself, and the author read every failure of the prototype on the
full corpus before writing the rules. So `held-out` is defined as: id hashes odd AND the row's
failure was never inspected during rule authoring — `run-intent-eval-split.mjs` pins the nineteen
inspected ids to the `tune` half by name, and the CI gate imports that same module so the runner
and the gate cannot disagree about which rows were held out. `tune` is the fitted number,
`held-out` the earned one.

### 6.1 Built as designed

- **`AIChat/lib/intentRouter.ts`.** Nine intents. Rule tables matched with `mentionsWord`, never
  `includes`. Every strong signal is collected first, then the documented precedence pairs run
  (script beats format and data-op, and analyze when explicit; chart beats bi-query, analyze and
  format; bi-query beats analyze and data-op, and format when the format word is report layout;
  formula vs data-op is settled by whether the verb is a copy; a data-op with a cell target beats
  format). Exactly one survivor is decisive. Two survivors are `unclear` with a `clarify` pair —
  the chat prints one notice naming both readings and asks; it never guesses. A lean (a bare cell
  reference → data-op, a question phrase, weak field evidence → bi-query) is never decisive and
  keeps every tool.
- **`script` from durability signals, not the word.** An event, a schedule with an automation verb
  (a schedule after *for/per/by/of/in* is a grouping, not automation), persistence across sessions,
  a run-time dialog, an entry point (a command, a form, a button), a network/JSON capability, or the
  explicit word. A one-off phrase ("just", "right now") cancels only the explicit word: "when this
  button is clicked, just copy A1" is still a button.
- **`bi-query` from the loaded model's field names, through the seam §4b said did not exist.**
  `@api/biModelFields.ts` caches the result of `get_connection_bi_model` per connection, built by
  `buildModelFieldIndex` (measures, non-calendar columns and their non-generic parts, calendar
  columns, table names; key columns and generic parts like *name*, *id*, *type* excluded), warmed
  at activation for every connection the insights provider knows and re-warmed on
  `bi:model-changed`, and read synchronously in `send()`. The rule: two business fields, or one
  business field plus a calendar word, and no cell reference. A calendar word alone is a time
  expression; one word contributes at most one field, so "sales" (a table and a measure synonym) is
  not two.
- **`lib/specialists.ts`.** One tool subset (≤ 8) and one byte-stable addendum per intent; only a
  decisive route narrows; every tool is reachable from some specialist (pinned). Only `script`
  carries the ~6,000-token API surface, and the gate in ChatView is the NEGATIVE one —
  `skipSurface = route.decisive && route.intent !== "script" && !mightWantScript(text)` — because
  gating on a positive script signal would have starved the two thirds of script requests §4a
  showed carry no trigger word. `scriptIntent.ts` is a thin view over the router that keeps only
  that over-broad recall sniff (with a handful of Swedish tokens, so a Swedish script request is not
  starved of the reference). `analysisIntent.ts` is deleted: the router reproduces every English
  case it fired on and stayed quiet on (carried into `intentRouter.test.ts`), and its "defer to the
  formula assistant" veto, which had no destination, now IS the `formula` route.
- **ChatView routes ONCE per message**, before the loop, prints the one-line notice
  (`describeRoute`), takes tools and system from the specialist, and runs the Tier-0 pre-route on
  `analyze`. The offer card renders only for a decisive `script` with no clarify pair.

### 6.2 Found during integration, not by design

The reactive narrowing — "the model invented a tool name; retry with the core set" — composed
wrongly with a decided route: a format request that began with FOUR tools was retried with the
TEN-tool core set under a notice saying "smaller". The salvage harness caught it (its invariant is
"the retry must carry fewer tools"). `narrowedSurface(specialist)` now returns the smaller of the
core set and the specialist's own — the same object when nothing shorter exists, so the notice can
say the true thing ("the list is already as short as this job allows") — and the remembered
narrowing caps later lean messages at the core set without replacing a later decided route's
shorter list. Pinned by three harness cases.

### 6.3 Deliberately not built, and why

- **§3 step 2, the schema-constrained model call for non-decisive messages.** Rules alone clear
  both §4 targets on the held-out half, every model-backed classification-adjacent feature this
  programme measured was dead, and the cost of not calling is a wider tool surface on a lean, not a
  wrong route. Revisit only with a measured lean-accuracy problem.
- **§3 step 3, buttons.** A clarify pair is a transcript notice; the person rephrases. Buttons that
  set the intent need a ChatView affordance that does not exist.
- **§3 specialists as DIRECT calls** to `@api/formulaAssistService` / `insightsService` rendering
  cards. `formula` and `analyze` still run through the tool loop with a four- and six-tool subset.
  §5's blockers stand.
- **Swedish rule tables.** English-only by owner decision.
- **Sticky `lastIntent` for short follow-ups.** Follow-ups route on their own words and mostly lean,
  which keeps every tool; nothing measured says the stickiness is needed.

### 6.4 The five defects of §2

1 (no arbitration) — fixed by construction. 2 and 3 (substring traps, `"just "`) — fixed with
`mentionsWord`; the traps are corpus rows `rg-*` and route correctly. 4 (the formula veto with no
destination) — the formula is a route. 5 (the surface on every message) — the negative gate.
`panel` and `range` still have no hint word and take the `button` surface; that is the object-type
guess, not the route, and it is unchanged.

**Still open from §5:** `registerChatPromptSink` has no caller; the design-query assistant has no
headless seam; there is no narration destination.
