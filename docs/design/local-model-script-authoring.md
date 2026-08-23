# Local-model script authoring — hardware-independent AI that writes Calcula scripts

**Status:** **M1–M7 SHIPPED 2026-08-19. L3 and the UI wiring SHIPPED 2026-08-20.** Every
milestone's as-built notes are in §8, including the things that turned out differently from the
design — and the two places the design itself was wrong.

**The pipeline is reachable by a user, end to end:** pick any model (local or cloud, any vendor) →
optionally measure it against the built-in tasks → chat → the model drafts a script → the validation
ladder checks it, including a dry run against a clone → a bad draft goes back to the model
automatically → only a validated draft reaches the review queue → the user reads it and decides
whether it becomes live code. Nothing in it is vendor-specific, and nothing in it assumes a
particular machine.

**~~The one honest gap~~ — CLOSED 2026-08-20: expected-diff grading is built.** The corpus (v2)
carries per-task expectations (`outcome`: fixture + event + expected cell input strings /
output substrings), and the offline runner executes every gradable candidate through
`scriptEval/harness.ts` — the REAL worker-realm mount (`buildWorkerContext`, `wrapModuleSource`,
the production hook dispatcher, `ALLOWLIST` validation and the capability ceiling) over an
in-memory backend — in a sandboxed subprocess (scrubbed env, Node permission model, hard kill).
A graded task scores `0.5·static + 0.5·grade` and cannot pass with a wrong value. Layer A pins
every reference at grade 1.0, which is what keeps the fake backend's semantics honest.

**Building the grade found two defects the whole ladder had missed, one severe.** (1) The corpus,
this doc's own prompt (`BASE_SYSTEM`), and the assisted template all taught
`context.expose('onClick', handler)` — and an exposed method named "onClick" NEVER receives a
click: the product fires the `onClick` HOOK (`context.onClick(handler)`; the Controls click path
even diagnoses the exposed-only script as "never registered a click handler"). Every AI-drafted
button script therefore mounted cleanly and did nothing when clicked. Same fingerprint as the
`export function setup` mount defect: the teaching drifted from the production form, and every
test doubled the part that would have told. All 31 button references, both prompts, and the
no-entry-point repair message now teach the hook form, and the grading harness fires the hook
exactly as the product does — the exposed form grades 0 with a repair instruction naming the fix.
(2) The sort reference passed static validation with `{ column: 0 }`, but the real
`ScriptSortField` is `{ key }` and `vSortRange` rejects unknown properties — the reference itself
failed the moment it actually ran. Layer A now RUNS every reference, so this class is closed, not
just this instance. A third, smaller find: at a 4k budget the surface prompt omitted `onClick`
itself for five canary tasks (nothing hints at it), so the ranker now always includes the object
type's OWN members — the prompt on which the correct answer was unwritable cannot be assembled
any more.

**Owner decisions that shaped it** (2026-08-19):

1. The primary AI use case is **script authoring**, not conversational grid manipulation. Grid work
   stays reachable — the 21 existing tools are not being removed — but it is no longer what the
   design optimises for.
2. **The user picks the model. Any model, any vendor, local or cloud.** The stated reference is VS
   Code's Copilot Chat model picker: one chat surface, a dropdown of everything the user has access
   to. Local is the *default* because of what it buys (§1), never a cage.

The second decision is not a widening of the first — it is the same seam. A provider abstraction
built only for "local plus Anthropic" and a provider abstraction built for "anything" are the same
abstraction, and §4b turns out to *simplify* once cloud models are profiled by the same mechanism
as local ones.

## 1. Identity — what this surface is, and why local

The user describes an outcome ("flag every row where margin dropped two quarters running"), a model
writes a **Calcula object script** to achieve it, the script is **verified mechanically**, and the
user **reads, edits, and mounts it**. The artifact is the product. The user ends up owning code they
can inspect, change, and keep — not a one-off mutation they have to trust.

That is the same claim the project makes about VBA in `CLAUDE.md`: custom code must be visible,
auditable, and never hidden. An AI that mutates the grid directly produces no artifact and leaves
nothing to audit. An AI that produces a reviewed script produces exactly the thing the transparency
pillar was built to govern — and it lands in the machinery that already governs it
(`// @capability` pragmas, the R19 ceiling, the audit ring, the consent gate).

**Why local specifically.** Running the model on the user's own machine means workbook contents
never leave it. For finance, health, legal, and government users that is not a nice-to-have — it is
the difference between "we can use this" and "our policy forbids it outright". Excel + Copilot
cannot make that claim. This is a differentiator, not a compromise, and it is the reason to accept
the engineering cost.

### 1a. Why the refocus onto scripts makes local models viable

Conversational grid work is close to the worst possible task for a local model. It needs reliable
multi-turn function calling across a wide tool surface with nested schemas — the in-app chat
declares **21 tools** today, and `create_pivot` alone takes an array of objects. Local models are
weakest at exactly that.

Script authoring inverts every one of those pressures:

| Pressure | Grid chat | Script authoring |
|---|---|---|
| Output shape | conformant tool-call JSON, many turns | **one fenced code block** |
| Needs native tool-calling templates | yes | **no** |
| Latency tolerance | must feel instant | 30–60 s is acceptable, and the code can stream visibly |
| Verifiable mechanically | no | **yes — the sandbox is an objective oracle** |
| Cost of retrying | per-token, metered | **zero marginal cost when local** |

The last row is the one that decides the design. Cloud tools do not run six repair rounds because
six rounds cost six times the money. Local inference costs electricity and wall-clock. **That lets
the pipeline spend iterations precisely where a weak model needs them**, and it is why a modest GPU
can produce usable scripts at all.

## 2. Anti-goals

- **No shipped weights.** Not in the installer, not downloaded by us. Licensing, size, and update
  burden all belong to the user's inference runtime.
- **No GPU backend compiled by Calcula.** No CUDA, ROCm, Vulkan, Metal, or DirectML build matrix.
  See §4a — this is the single largest source of hardware lock-in and we decline all of it.
- **No hardware detection.** We never read VRAM or enumerate adapters. See §4b.
- **No unattended mounting.** A generated script is never mounted or executed as live code without
  a human action. `mcp/drafts.rs` already establishes this invariant and this design inherits it
  unchanged.
- **No silent degradation.** If the selected model is weak, the user is told so in measured terms
  before they rely on it. A quality drop the user cannot see is a transparency defect.
- **No hand-maintained vendor × feature matrix.** Capabilities are probed per model (§4b), never
  tabulated per vendor. A table like that is stale the week after it is written and wrong for every
  model released since.
- **No privileged vendor.** Anthropic gets a native provider impl for wire fidelity, not preferential
  placement in the picker. A user who only ever points Calcula at a local endpoint, or at
  OpenRouter, must lose no functionality that matters to script authoring.
- **Not a replacement for the grid tools.** The 21 existing chat tools stay. This design adds a
  surface; it removes none.

## 3. Where we stand today (verified 2026-08-19)

**Recount before restating.** Every figure below was extracted by parsing the file, not by grep
line-counting — an earlier pass over this same material reported "152 ops" and "29 capability ids"
from `grep -c`, and both were wrong because `grep -c` counts *lines containing a match*, not
entries. The extraction one-liners are in the git history of this document's introducing commit.

### 3a. What already exists and is reusable

| Asset | Location | Why it matters here |
|---|---|---|
| Agentic chat loop | [ChatView.tsx:326-357](../../app/extensions/AIChat/components/ChatView.tsx#L326-L357) | Working tool loop, `MAX_TOOL_TURNS = 8` |
| Tool dispatcher | [ai_chat.rs:219](../../app/src-tauri/src/ai_chat.rs#L219) | Dispatches into `mcp::tools` — **already vendor-neutral** |
| Draft-and-review flow | [mcp/drafts.rs:238](../../app/src-tauri/src/mcp/drafts.rs#L238) | `draft_object_script`; the exact flow this design needs |
| Draft review UI | `ScriptableObjects/ObjectScriptEditorApp.tsx` | Has a draft path (`objectScriptEditorDraft.test.tsx`) |
| **Object-script policy** | `api/scriptHost/allowlist.ts` | **The ground truth for what this feature drafts.** 233 methods, **53 capability-bearing**, mapped to the 16 ids. Its own header: consumed by broker dispatch, the transparency panel, and consent-dialog text, "so drift is impossible" |
| QuickJS op manifest | [manifest.rs](../../core/script-engine/src/manifest.rs) | **130 entries** (115 `op()` + 15 `gated()`). Governs `notebook-cell`, `one-off-script`, `mcp-tool` — **NOT object scripts**; see §5a |
| Capability vocabulary | `api/scriptHost/capabilityIds.ts` | **16 ids**: `net.fetch`, `bi.query`, `bi.sql`, `storage`, `ui.html`, `formula.udf`, `bi.model`, `bi.connector`, `ui.dialog`, `distribution.writeback`, `schedule`, `file.picker`, `ui.shortcut`, `grid.read`, `distribution.publish`, `distribution.subscribe` |
| Typings generator | `app/scripts/gen-script-typings.mjs` + `scriptTypings/declarations.ts` | AST-based, lockstep-tested against the runtime shim. The slicing work in §6 extends this rather than inventing it |
| Script API surface | `_shared/lib/calcula.d.ts` — 35,599 bytes | Fits a mid-size context whole (~10k tokens, estimate) |
| Object context typings | `ScriptableObjects/objectContexts.d.ts` — 348,501 bytes | Far too large to inline; must be sliced |

The critical structural fact: **`ai_chat_run_tool` dispatches into the same `mcp::tools` helpers the
MCP server uses**, inheriting the main-window guard, `check_script_security`, undo, and audit. None
of that cares which model authored the call. A local model inherits the entire safety envelope for
free — this design adds no new privileged reach whatsoever.

### 3b. The gap that blocked the feature outright — CLOSED 2026-08-19 (M1)

**Fixed the same day this was written; the description below is the BEFORE state**, kept because it
is why the draft flow needs wiring at all. The chat now declares and dispatches 24 tools including
all three draft tools.

`draft_object_script`, `list_script_drafts`, and `get_script_draft` are registered on the MCP server
([server.rs:1069, :1098, :1110](../../app/src-tauri/src/mcp/server.rs#L1069)) — the MCP surface
exposes **37 tools**. The in-app chat exposes **21**, its dispatcher has **exactly 21 matching
arms**, and **none of the three draft tools is among them**.

So today the in-app chat's only route to a script is `run_script`, which **executes immediately**.
That is the precise opposite of the reviewable flow this design is built on. An external MCP client
can draft a script for review; the built-in chat cannot.

This is M1 in the build order and it is correct behaviour with a cloud model too — it is not
local-model work and should not wait for any of it.

### 3c. The chat is hard-locked to one vendor, and offers no model picker at all

| Pin | Location | Severity |
|---|---|---|
| Hardcoded endpoint | [ai_chat.rs:33](../../app/src-tauri/src/ai_chat.rs#L33) | trivial |
| Credential target is the single fixed string `Calcula:aikey\|anthropic` — **only one vendor's key can be stored** | [ai_chat.rs:30](../../app/src-tauri/src/ai_chat.rs#L30) | must become per-provider |
| Auth is `x-api-key` + `anthropic-version`, not `Authorization: Bearer` | [ai_chat.rs:174-179](../../app/src-tauri/src/ai_chat.rs#L174-L179) | trivial |
| `thinking` param gated on `claude-opus-4` | [ai_chat.rs:153](../../app/src-tauri/src/ai_chat.rs#L153) | trivial |
| **Anthropic wire format built inside the extension** | [ChatView.tsx:20](../../app/extensions/AIChat/components/ChatView.tsx#L20) | **structural** |

The fifth is an architecture defect independent of any of this. `ChatView` builds `input_schema`
tools, reads `stop_reason === "tool_use"`, and assembles `tool_use_id` result blocks — one vendor's
JSON schema, inside an extension. `ai_chat.rs`'s own header states it as deliberate ("the frontend
speaks the Anthropic wire format, so the Tauri layer stays thin"), which makes it a decision to
revisit rather than an oversight to patch. Under the Facade Rule the extension should speak
*Calcula's* chat shape and the backend should own provider translation.

**And the model is not selectable even within Anthropic.** `ai_chat_complete` accepts a `model`
parameter and `DEFAULT_MODEL` is only a fallback — but `ChatView` never passes one
([ChatView.tsx:327-331](../../app/extensions/AIChat/components/ChatView.tsx#L327-L331) sends
`messages`, `tools`, `system` and nothing else), so **every request in the product is
`claude-opus-4-8`**. The setup screen hardcodes "Connect Claude" and an `sk-ant-…` placeholder
([:369, :374](../../app/extensions/AIChat/components/ChatView.tsx#L369)). There is no picker, no
stored preference, and no second credential slot to put another vendor's key in.

### 3d. What does not exist at all

**There is no parse-only or static-validation path in `core/script-engine`.** No `validate`, no
`parse_only`, no dry-run entry point. This is the genuinely new engineering in the design, and §5
argues it is also the highest-leverage piece.

## 4. The five decisions that buy hardware independence

The owner's constraint: users will have "all sorts of GPUs". The answer is not to pick a tier. It is
to **make the pipeline adapt to whatever is present, and make the verifier — not the model — carry
the quality bar.**

### 4a. Never ship weights, never compile a GPU backend

Discover an OpenAI-compatible inference runtime already on the machine:

| Runtime | Default endpoint |
|---|---|
| Ollama | `127.0.0.1:11434` |
| LM Studio | `127.0.0.1:1234` |
| llama.cpp `llama-server` | `127.0.0.1:8080` |
| vLLM | `127.0.0.1:8000` |

Ask it for its model list, let the user pick, remember the choice. If none is found, link the user
to one; we do not own that install.

This is the largest single escape from hardware lock-in: **we never compile a GPU backend, so we
have no hardware matrix to support.** An M3 Max, a 5090, an Arc A770, and a CPU-only ThinkPad all
present the same HTTP interface, and their runtime — not us — solved layer offload years ago.
Installer stays small; no weights licensing; no download UX; no driver support burden.

The embedded alternative (`llama-cpp-2`, `mistral.rs` in-process) is explicitly deferred, not
rejected. §7 places the seam so it can be added later as one more provider impl.

### 4b. Probe behaviour, do not detect hardware

We never read VRAM. The numbers lie — shared memory, unified memory, other processes — and the
detection code would be a permanent tax across four vendors that answers the wrong question anyway.

Instead, run a one-time **capability probe** against the model the user selected and cache the
result:

```
ModelProfile {
  contextTokens         // measured, not what the card claims
  decodeTokensPerSec    // timed short generation
  emitsFencedCode       // true for essentially everything
  honorsGrammar         // does the runtime accept a constrained-decoding grammar?
  nativeToolCalls       // nice to have; NOT required by this design
  canaryScore           // N of M golden script tasks passed end to end
}
```

`canaryScore` is the field that matters and it is honest in a way no public benchmark is: it runs
*our* tasks through *our* verifier. It costs the user a couple of minutes once and answers the
question they actually have — "will this model work for Calcula?" — instead of the question
hardware detection answers, which is "how many gigabytes do you have".

**The probe is per-MODEL, not per-local-model — and that is what makes the any-vendor requirement
cheap.** A cloud model is profiled by exactly the same mechanism: does it emit fenced code, what is
its real context budget, does it do native tool calls, what does it score on the canaries. This
removes the thing that would otherwise sink a multi-vendor picker — **a hand-maintained vendor ×
feature matrix**, which is stale the week after it is written and wrong for every model released
since. We do not maintain a table of who supports what. We ask the endpoint, once, and cache the
answer. A vendor that ships a new model, or a user who points at something we have never heard of,
needs no code change.

### 4c. Stable contract, tiered strategy

The pipeline signature never varies: `(intent, workbook context) -> validated draft`. Only the
internal strategy tiers off the profile.

| Profile | Strategy |
|---|---|
| Low `canaryScore`, small context | **Skeleton-filling** — the model completes slots in a vetted template rather than authoring free-form. Grammar-constrained. Minimal sliced typings. 6+ repair rounds. |
| Mid | Free-form authoring, full `calcula.d.ts` injected, 2–3 repair rounds |
| High / cloud | Plan-then-write, full context, 1–2 repair rounds |

**The cloud is not a special case.** It is a provider whose probe lands in the top tier. The owner's
"window open to the cloud" principle therefore costs zero additional code paths — which is the
correct shape for a principle we intend to keep.

### 4d. Budget the context, never assume it

Context windows range from 8k to 128k+. Prompts are assembled by a **priority-ordered budget fill**,
not a fixed template:

```
required   system + task                         ~800 tok
required   API slice for the target object type  varies (§6)
optional   worked examples                       dropped 4th
optional   workbook shape summary                dropped 3rd
optional   prior attempt + verifier errors       dropped 2nd — should almost never drop
```

Fill until the probed budget is spent; drop from the bottom. No prompt may be constructed that
assumes a large window.

### 4e. The verifier carries the quality

This is what actually makes the design model-agnostic, and it gets its own section.

## 5. The verification ladder

| Level | Check | Inference cost | Catches |
|---|---|---|---|
| L0 | Parses as JS (QuickJS parse-only) | **zero**, ~1 ms | truncated / malformed output |
| L1 | **Calls only methods present in the policy for its surface** (§5a) | **zero**, ~1 ms | **hallucinated APIs — the dominant small-model failure** |
| L2 | `// @capability` pragmas reconcile with the methods actually called | **zero**, ~1 ms | a ceiling that will deny the script at runtime (§5b) |
| L3 | Dry run over cloned grid state, fuel-budgeted | ~100 ms | runtime errors, runaway loops |
| L4 | Diff rendered for the user | — | wrong-but-valid behaviour |
| L5 | Human reads, edits, mounts in `ObjectScriptEditorApp` | — | everything else |

**L0–L2 cost no inference and catch the failure mode that actually dominates**: a weak model
confidently emitting `Calcula.formatRange()`, or drifting into VBA or Office.js idiom.

### 5a. Which policy is the ground truth — and it is NOT `OP_MANIFEST`

This document's first draft said L1 checks against `OP_MANIFEST`. **That is wrong for the surface
this feature actually targets**, and the error is worth recording because it is easy to repeat: the
project has two sandboxes with two separate policies.

| Surface | Realm | Policy / ground truth |
|---|---|---|
| **Object scripts** — what `draft_object_script` produces | per-script hardened **Worker** | **`api/scriptHost/allowlist.ts`** (233 methods, 53 capability-bearing) |
| notebook-cell, one-off-script, mcp-tool | Rust **QuickJS** | `core/script-engine/src/manifest.rs` (`OP_MANIFEST`, 130 entries) |

`SURFACE_PROFILES` in `manifest.rs` names its FOUR surfaces explicitly (notebook-cell, one-off-script, mcp-tool, writeback-validator), and `object-script` is not
one of them. So **M2's L1/L2 must read `allowlist.ts`** — and its self-description is exactly the
property the checker needs: one object consumed by broker dispatch, the transparency panel, and the
consent-dialog text, so what the checker validates against is what the broker will actually enforce.

`OP_MANIFEST` still matters if the chat ever drafts a notebook cell, and the QuickJS round-trip test
remains the stronger guarantee of the two (it boots a real runtime and diffs both directions).
Neither is a substitute for the other.

### 5b. Under-declaration is a runtime denial, not a prompt

The consequence of getting L2 wrong is sharper than "the user sees an extra consent dialog".
`broker.ts:162` denies any capability outside the script's declared R19 ceiling **before the grant
check, so it is never JIT-prompted at all** — the call throws `PermissionDenied` naming the missing
capability.

So an under-declared script passes review, mounts cleanly, and then fails at runtime — possibly deep
in a workflow, possibly on a schedule, possibly inside a distributed report. The reviewer had no way
to see it coming. That is what makes L2 a correctness check rather than metadata hygiene.

**The resolved policy is §11.2**, decided 2026-08-19: the model writes its own pragmas, a missing one
is a hard reject with a repair round, and a declared-but-unobserved one is shown to the reviewer
rather than rejected. Read §11.2 before implementing L2 — the asymmetry is deliberate and rests on
the fact that a source scan can miss indirectly-dispatched calls.

**Repair prompts must be compiler-quality, not "try again".** A rejection at L1 should read:

> `Calcula.formatRange` does not exist. Nearest ops in the injected surface:
> `Calcula.applyStyle(range, style)`, `Calcula.setRangeFormat(...)`.
> Only ops from the provided surface may be called.

A nearest-neighbour suggestion computed off the manifest turns a repair round from a coin flip into
a targeted fix. Combined with the zero marginal cost of local retries (§1a), this is the mechanism
that lets model quality degrade *gracefully* instead of failing — which is the whole hardware-
independence argument in one line.

**L3 must be a true dry run — BUILT 2026-08-19** as `ai/dryrun.rs` + `ai_dry_run_script`.

The missing piece turned out to be a decision point, not machinery. `run_script_with_model`
(`mcp/tools.rs`) already cloned the grids, ran the script against the clone on its own thread, and
handed back `modified_grids`; `apply_script_result` was a separate step afterwards, and
`diff_grids_to_updates` already existed for it. So the split is:

| | |
|---|---|
| `run_script_isolated` | gate, run, return what changed. **Applies nothing.** |
| `run_script_with_model` | that, plus the apply — byte-identical for every existing caller |
| `ai_dry_run_script` | that, plus a diff. Applies nothing, ever. |

Sharing the run rather than copying it is deliberate: a duplicate would be a second copy of the
security gate, the capability grant/revoke and the thread hand-off, and this project has already
measured what a copied run path costs.

Two details that would be wrong the obvious way:

- **The baseline is a second clone taken BEFORE the run**, not a re-read of `AppState` afterwards.
  Re-reading races any concurrent edit and diffs against the wrong state.
- **`cell_input_string` is shared with the apply path.** The preview must render the *before* side
  with exactly the rule the apply path uses for the *after* side, or a cell whose two renderings
  merely disagree shows up as a spurious change.

**The invariant is asserted where it can actually be proven, and it HOLDS.** A report is easy to
fake; an unchanged workbook is not. `e2e/tests/ai-chat-tools.spec.ts` writes a value, dry-runs a
script that would overwrite it, asserts the report names the change, then asserts **the cell still
holds the original**. It passes, and an in-command probe of live `AppState` reads `keep-me` at entry,
after the run returns, and after unwrap.

**It is also asserted where it is IMPLEMENTED**, which is what finally settled it:
`a_run_never_mutates_the_callers_grids` (`core/script-engine/src/notebook.rs`) runs
`Calcula.setCellValue` against a `CellRunInput` and checks the caller's own copy is untouched while
the returned copy carries the write. Every layer above depends on that and nothing had ever asserted
it at the layer that implements it. It runs in **milliseconds** against a two-minute app launch.

### The hours this cost, and why

This rung was reported as BROKEN for a stretch, on a defect that never existed. Worth recording,
because the mechanism will recur:

**A source restored while its own build is in flight leaves cargo believing the binary is current.**
The source was restored at 20:12:40; the still-running sabotage build finished at 20:17:13. Cargo
compared source (20:12:40) to binary (20:17:13), found the binary newer, and rebuilt nothing — so the
next run executed the SABOTAGED binary with clean source on disk and **zero compile errors**.

The check used to rule that out — "the binary is newer than the source, therefore it rebuilt" — is
exactly backwards: in this race, a newer binary is the signature of a stale one. Read the run's log
for `Compiling` / `could not compile`, or the `[e2e] app binary: … (built <time>)` line, and never
edit sources while a build is running.

**Two experiments were also wasted on shielding assertions.** The first sabotage (apply BEFORE the
diff) reddened `totalChanges`, not the write-invariant, because the second run then diffed against
already-modified state. The first bisect (empty report) failed the same way for the same reason —
after that lesson had already been written down. Assertions ahead of the target are shields; an
experiment must pass them to discriminate anything, so the canned report had to claim exactly what a
real run would.

### L3 is wired into the repair loop (2026-08-20)

`authorScript` takes an optional `dryRun` hook. Once L0-L2 pass, the draft is run against a clone and
two things become repairable that were invisible before:

- **It throws when run.** A script can parse, invent nothing, declare its capabilities correctly and
  still fail on the first line. The runtime error goes back as the repair instruction.
- **It runs cleanly and changes nothing**, when the caller says writes were expected.

That is the measured gap: against two real local models, roughly HALF of all failures were scripts
the validator called `ok`, and the loop stopped after one round on every one of them because
"does it parse and call real methods" was the only question it could ask.

Three deliberate choices:

- **The dry run happens only AFTER the static checks pass.** Executing a known-broken draft wastes a
  run and yields a runtime error that merely restates the static one — noise at exactly the moment
  the model needs one clear instruction.
- **`expectsWrites` is the CALLER's judgement, not a corpus field.** "Changed nothing" is only a
  defect when the task was meant to write, a read-and-report script is a normal thing to ask for,
  and only the caller knows whether the live workbook holds the data the task assumes — against an
  empty sheet a correct "sort rows 2-500" changes nothing and must not be marked wrong.
- **The hook is optional**, because the offline eval runner has no live workbook and the loop must
  still work without one.

**~~What it does NOT do yet~~ — CLOSED 2026-08-20.** The corpus half of the grade exists:
`tests/eval/tasks.json` v2 carries an `outcome` block on 21 of 36 tasks (10 of 12 canaries) —
`fixture` seeds, the `event` hook to fire, `expect` cell input strings (or a case-insensitive
`match` regex where several spellings are equally right) and `expectOutput` substrings. The
executor is `scriptEval/harness.ts`: the production mount transform and the production `context`
over an in-memory backend, with the production `ALLOWLIST` validators and the declared-capability
ceiling enforced per call; a real member the backend does not serve is a HARNESS GAP and the run
is ungradable, never wrong — the same decline discipline as the in-app rung. `gradeOutcome`
(pure) compares, `scoreCandidate` folds the grade in at half weight and refuses `passed` below a
perfect grade, `run-eval.mjs` executes candidates in a sandboxed subprocess and feeds the harness
to the repair loop as its offline L3 hook, and Layer A requires every reference to grade 1.0 —
the honesty anchor that keeps the fake backend from drifting from the product. The in-app
`canaryScore` deliberately stays static: grading means executing model output, and the renderer
is the wrong place to run it.

The finished layer was adversarially reviewed (60 agents, 37 confirmed / 18 refuted, all fixed
the same day); the as-fixed record is in `docs/design/open-items.md`'s closed row and
`tests/eval/README.md`'s "Adding a task" section, whose fixture-discrimination patterns
(decorrelated sort keys, two-click persistence, injected failures, anchored count regexes,
intent-named expectations) came out of it.

### L3 answered a question it could not answer — three defects, 2026-08-20

Wiring L3 in front of `draft_object_script` was wrong in a way none of its own tests could see,
because they doubled the backend. Probing the real interpreter took milliseconds and found three
separate faults stacked on each other. All three are FIXED; the sequence is the lesson.

**1. The preview could not parse what it was judging.** Object scripts are `export function
setup(context)`. The dry run evaluates source in the Rust QuickJS realm, which answers
`unsupported keyword: export`. L3 therefore rejected EVERY valid object script with "it passes every
static check but FAILS when run against a copy of the workbook" — the most expensive way a checker
can be wrong, because the model then spends its repair rounds fixing correct code.

**2. Even parseable, an `async` handler silently did nothing.** QuickJS parks everything past the
first `await` on a job queue, and NOTHING in the engine drained it. The cell body ran to its first
`await`, `eval` returned, the grids were read back unchanged, and the run reported `Success` with
`cells_modified: 0`. That is worse than an error: `expectsWrites && totalChanges === 0` would have
told the model to "actually write the cells" about a script that already did.

This one was never AI-specific — it is an engine defect reaching every notebook cell, one-off script
and MCP `execute_script`. `runtime::drain_jobs` now runs the microtask queue for both run paths,
inside the armed deadline (so a promise chain that never settles is cut by the same budget, with no
iteration cap that would cut a long-but-finite one short) and on the error path too (the notebook
session is persistent, so a job left queued by cell N would otherwise resume against cell N+1's
grids). An unhandled rejection now fails the run, via a tracker that is deliberately ASYMMETRIC:
a rejection handled later CLEARS what was recorded, because QuickJS calls the tracker even for an
ordinary `try/catch` around an `await`, and reporting working code as broken is the failure this
whole ladder exists to avoid.

**3. The shape the prompt teaches could not mount AT ALL.** `wrapModuleSource` splices the user body
INSIDE a function, where an `export` declaration is a SyntaxError. It stripped `export default` and
`import`, never a bare `export`. So `export function setup(context)` — the form the docs, the
generated IntelliSense typings, this feature's prompt and every one of its tests use — failed at
mount while passing every static check before it. The production path that works
(`MacroRecorder`'s codegen) emits `function setup(context)` with no `export`, which is why nobody had
hit it. The wrapper now blanks the keyword rather than deleting it, so line AND column numbers
survive for breakpoints and stack traces.

**The rule this produced.** A rung that cannot judge must DECLINE, never guess. `ai_dry_run_script`
returns `applicable: false` with a reason for any source this realm cannot host, having run nothing,
and every consumer branches on it before drawing a conclusion. The honest scope: the Worker realm's
`context` exposes 358 `api.*` members and the interpreter's realm shares NINETEEN of them — of the
16 chains the prompt always shows, only four. A faithful preview of an object script means running
it in the realm it actually runs in, which is a real piece of work and is filed as such; emulating
5% of a surface and reporting the gaps as defects is not a cheaper version of it.

### 5c. The faithful preview — BUILT 2026-08-21

The piece of work filed above is done. `previewObjectScript`
(`app/src/api/scriptHost/scriptPreview/`) runs a draft in a REAL hardened Worker against a copy of
the workbook, and `draftGate` now calls it instead of `ai_dry_run_script` — which had declined 100%
of what that gate handed it, so L3 was dead on the only surface the AI drafts for.

**What the objection above was actually about, and why it does not bite.** "Emulating 5% of a
surface" is about the SURFACE. Nothing here emulates it. Of the five layers a script passes
through, four are the product's own code and one is substituted:

| layer | preview uses |
|---|---|
| realm | a real hardened Worker — `hostPreviewScript`, `spawnWorker()` |
| mount transform | `wrapModuleSource`, verbatim |
| surface | `buildWorkerContext` — the whole `context` |
| policy | the real `brokerCall`: ALLOWLIST lookup, argument validators, tier, R19 ceiling |
| **backend** | **substituted** — an in-memory grid |

The substitution is irreducible: a preview must not write to the document it is previewing. What
the backend cannot serve is not reported as a defect — it GAPS, the run is `applicable: false`, and
no conclusion is drawn. Same decline discipline, one layer finer: it used to be "wrong realm,
always", and is now "this specific member, this run".

**Safety is proved by ABSENCE, not by a flag.** `hostPreviewScript` never calls
`assertMountAllowed` (no Script-Security modal, no session approval, no persistent workbook-trust
record), never calls `buildHandleFromDefinition` (no live grant set, so a source the user once
granted "Always" cannot inherit it), never calls `restoreAndSyncGrants` (nothing reaches the Rust
capability store), never calls `registerMountedHandle` (never appears as a mounted script), never
enters `mounted` (so `hostUnmountScript`, which REVOKES Rust capabilities by script id, is
unreachable), and never calls `executeImpl` (so no call can fall through to a Tauri command). Each
is an absent call rather than a suppressed one — the same discipline `DocumentEffect` uses, run in
reverse: there, possession of the value proves the flag is set; here, absence of the call proves
nothing was granted. The alternative — four conditionals inside `mountWorker` — would have put four
fail-OPEN branches in the most security-sensitive function in the script host.
`previewSafety.test.ts` reads the function body and pins every absence, on comment-stripped source
(its first version failed on the comment that DOCUMENTS one of the protections, which is the same
substring weakness that would have let a real call hide).

**One flag, one branch: `ScriptHandle.preview` suppresses AUDIT only.** A preview mounts nothing
and reaches nothing, so a row attributed to it is not a redaction of a real event but a false
statement about one that never happened. The subtle half is denials — `persistCapabilityAudit`
PERSISTS broker-policy refusals into the workbook's audit log, so without the flag the very
mechanism that keeps a preview harmless would write permanent rows about a script the user never
agreed to run. Only `buildPreviewHandle` can set it, and that function hard-codes empty grant and
declared sets, so possession of a preview handle is proof the ceiling is empty.

**ONE backend, TWO drivers.** The grid, the 39-method backend and the broker's admit/refuse
decision moved out of `scriptEval/harness.ts` into `scriptPreview/` and `brokerPolicy.ts`. The
offline corpus driver and the in-app realm driver now share all three, which is what makes the
corpus evidence about the app: a corpus grading against different semantics than the app previews
with certifies the wrong thing. The extraction also removed a second source of truth the harness
had been carrying — its hand-rolled copy of the policy order, which never checked the tier.
`decidePolicy` is pure and dependency-free precisely so the Node grading subprocess can import it
without dragging Tauri along.

**The document.** `snapshotActiveSheet` copies the active sheet's used range with read-class calls
only, capped at 20,000 cells and clamped by whole ROWS (halving a row hands a script a record
missing its own columns, which reads as corruption rather than as a bound); a capped copy says so
in the report. Each cell carries BOTH halves: the input string (what the diff compares) and the
display (what `api.getCellValue` actually returns in the product — a currency-formatted 42 reads
back "$42.00"). Deriving the input from `display` instead would have made the diff report changes
nothing made.

**Capabilities DECLINE rather than stub, in-app.** The preview declares nothing, so the R19 ceiling
refuses every capability-bearing call; the preview then reports that as a decline, not as the
script's defect. The draft's declarations were already checked by L2, which runs first — so a
capability call reaching here is one the script declared correctly, and the honest answer is that a
preview cannot perform it. Answering from a canned stub would be worse than silence: a script
parsing `{}` as an exchange rate throws, and the preview would report ITS OWN stub as the draft's
runtime error. (The offline corpus does stub them, because its tasks SUPPLY the stub content. Same
rule — serve only what you can serve truthfully — with different amounts of available truth.)

**Three defects found by the E2E tier and by nothing else.** jsdom has no `Worker`, so no unit test
has ever executed a script in the realm this feature is about; the unit tier covers the pure halves
and reads the source for the rest. All three were in the async plumbing, and all three produced the
same misleading verdict — *"it ran and changed nothing"* — about CORRECT scripts:

1. **The host began draining before the event was delivered.** `{t:"event"}` is fire-and-forget and
   `postMessage` is asynchronous, so the host counted quiet turns while the message was still in
   transit, saw nothing in flight because the handler had not run, and declared the realm idle
   before the first write was issued. Every writing script reported 0 changes. Fixed with a
   `ping`/`pong` round trip — a real protocol message — which works because the realm handles
   messages IN ORDER, so a pong proves the handler ran at least to its first `await`.
2. **One drain is not enough.** When a call is refused the host settles it and `inFlight` drops to
   zero, but the WORKER has not seen the result yet; it processes the `callResult` afterwards, the
   continuation throws, and only then is `{t:"error"}` posted. A single drain finishes before all
   of that. `settleRealm` now alternates drain and flush until no new calls appear.
3. **A refused call was invisible.** A refusal the script never awaited neither throws nor changes
   a cell. `PreviewRunResult.refusals` reports them; the preview module decides what each means —
   a capability refusal is a preview limit, any other is a real finding the product would have made
   identically.

The offline harness needs none of this, because it dispatches in-process — which is exactly why
none of it was visible below the E2E tier.

**Stated limits.** A cell the script rewrites loses its cached display and reads back unformatted
(the preview has no number formatter; the backend owns that). Formats are not observable in a diff.
A hook that defers its work to a timer is not waited for — the product has no observation point
there either. And the coverage bound below.

### 5c.1 The three follow-ons — 2026-08-21

**The gap rate was unmeasured, so it was measured.** A rung that declines most of what it sees is
dead again, and "how often does it gap" was being guessed at. `scriptPreview/__tests__/coverage.test.ts`
computes it against the right denominator — *what the model is actually taught*, not the 233-row
ALLOWLIST — using the generated surface's own `chain -> broker` mapping and the reach check's own
`callableAncestorOf` (extracted so the measurement and the validator cannot disagree about what a
script even calls). Findings:

- **`PROMPT_CORE_CHAINS`: 19/19 served**, and asserted. That is the floor shown at every budget,
  so a gap there would decline the most ordinary drafts there are.
- **Every chain the 36 corpus references reach: served**, and asserted. Everything a correct
  solution needs is previewable.
- **Broad exposure at the runner's 8k default: 46.8% of what is OFFERED.** That number drove the
  rest of the work.

The offered-but-gapped tail split into two categories once looked at, and conflating them had made
the number unactionable. `UNPREVIEWABLE` (backend.ts) now names what a preview can NEVER serve, with
a reason each — cross-script calls (`base.callMethod`: a preview mounts one script), other sheets
(`api.setActiveSheet`: it holds one sheet's copy), real objects, print. Capability methods are
identified from the ALLOWLIST rather than listed, so that half cannot drift. Six methods were then
served faithfully — `getRangeFormat`, `clearRangeFormat`, `copyRange`/`pasteRange`, the named-range
family — taking addressable coverage **46.8% → 55.2%**. `pasteRange` GAPS on a range containing a
formula, because the product SHIFTS relative references and this backend has no reference parser:
pasting one unshifted would write a formula the product would never write and present it as the
script's. The assertion is a **ratchet at 0.5, named as one** — chasing a high number would mean 25
approximate implementations, and an approximation is strictly worse than a gap, because a gap
declines while an approximation grades a WRONG script as right.

**The gate previewed every draft as a button.** `object_type` is a REQUIRED field of
`draft_object_script`, and it decides which context the realm builds and which hooks exist —
`draftGate` simply never read it, so a shape or sheet script was mounted against the wrong context
and its own handlers were never fired. It now reads it, and `objectHooksFor` derives the hook list
from the generated surface (`ButtonContext` -> `onClick`) rather than from a hand-written map that
would drift on the first new hook. The gate names no event at all: the preview offers every hook the
type HAS and fires exactly the ones the DRAFT registered, so a script that only does setup-time work
is not failed for declining to handle a click. Its guard immediately caught two wrong entries in my
own list of types-without-a-context (`ColumnContext` and `TimelineContext` both exist).

**Formula VALUES now exist, computed by Rust.** `ai/preview_eval.rs` +
`preview_evaluate_formulas`: pure over the cells handed to it — no `AppState`, no document, no
writes — iterating `evaluate_formula_multi_sheet` to a fixed point over the preview's own grid. A
chain needs one pass per link, so it iterates; a circular reference stops at the budget and reports
`converged: false` rather than presenting a half-iterated number as final. **This is the one thing
TypeScript could not have supplied at any price**: the formula language lives in Rust, and a second
evaluator here would be one that confidently disagrees with the workbook.

It runs at the preview's SETTLE POINTS (after `setup`, after each hook), not per read — a stated
approximation: the product recalculates as part of the write, so a read immediately after a write
sees the new value there and on the next settle here. Per-read would mean an IPC round trip inside a
synchronous backend call, which the backend's shape does not allow. A failure to evaluate is
SILENT: the grid keeps what it had, which is exactly the behaviour before this existed — an
enrichment must not turn a working preview into a failed one.

So the earlier "no formula evaluation, parity with the Rust dry run" limit is now narrower than
parity: a formula the SNAPSHOT supplied carries the workbook's own value, a formula the SCRIPT
writes gets a computed one, and what remains is that dependents settle a phase later than the
product would settle them.

### 5c.2 The adversarial review of 5c/5c.1 — 12 verified findings, ALL FIXED 2026-08-21

A six-lens adversarial pass (28 raw findings, 12 verified: 10 confirmed + 2 partial) over the
preview work found that **each of §5c.1's three features shipped with a false-verdict defect of
exactly the class the rung exists to prevent** — invisible to every unit suite because the defects
live in the seams the tests double. The safety invariant survived all six lenses: no confirmed
path writes the document, acquires a grant, raises consent, or leaves audit residue. What did not
survive, and how each fix holds:

**Hooks (the worst cluster — three findings stacked).** (1) Every non-click hook fired with
`payload: undefined` where the product delivers rich shapes (`onSelectionChange` gets
`{startRow,…,areas}`; `cell.onEdit`'s own SHIM dereferences `payload.changes` before user code
runs) — so a correct destructuring handler threw and the draft was rejected "FAILS when run": the
founding failure mode, reproduced for every type except button. The rule is now the decline
discipline applied to payloads (`SYNTHESIZABLE_HOOK_PAYLOADS`, runShape.ts): a hook whose payload
cannot be synthesized faithfully is never fired — skipped WITH A NOTE when offered
opportunistically, the run inapplicable when named explicitly, a HARNESS GAP in the corpus driver.
(2) The generated surface DEDUPED `on*` chains across interfaces (dedup key omitted `iface`), so
`objectHooksFor` returned NOTHING for slicer/table/timeline/row while the worker really registers
their hooks — a throwing row handler graded clean. The dedup key now carries the interface (894
rows, was 669), the per-type own-member floor for the prompt ranker was rebuilt from per-iface rows
(it had the same single-owner blindness), and `OBJECT_TYPE_CONTEXTS` is emitted into the policy so
the runtime stops deriving interfaces from a naming convention — which (3) was itself wrong for
`textbox` (BaseObjectContext), and the objectHooks guard's `NO_OWN_CONTEXT` list had ENSHRINED the
generator defect for `row` instead of catching it. The guard now pins recovered per-type hook
LISTS against what `contextShims` registers.

**Formula recalc (it was destroying truth to add it).** The settle-point recalc re-evaluated EVERY
formula against a one-sheet, name-less, UDF-less grid and OVERWROTE the workbook's correct cached
displays — `=Sheet2!A1` became `#REF!` where the snapshot carried 250, even for drafts that wrote
nothing. And the flat 8-pass budget was exceeded by ordinary sheets (Jacobi iteration settles one
link per pass; a 50-row running-total column is depth 50 — the depth belongs to the WORKBOOK), so
such sheets ended "unconverged" with partial sums stored and a note blaming a cycle they did not
have. Three rules now hold, each pinned: store only on CONVERGENCE (budget = formulas+1, capped
512); store NOTHING when anything SPILLS (the raw eval API preserves array-ness; `to_cell_value`
would have collapsed a spill to its first element); a computed ERROR never replaces an existing
display (it may fill an empty one — a script-written `=1/0` genuinely errors). Plus:
`seed_cell_value` now types exact TRUE/FALSE as Booleans (as Text, `=IF(A1,…)` computed against a
string), the truncated-copy case skips recalc entirely, and the non-convergence note no longer
latches across a later settle that converged.

**The async truth-holes.** A hook error surfacing during `onSettle`'s IPC await was attributed to
the NEXT hook — or, after the last fire, dropped, grading a throwing script as a clean run; the
error latch is now checked after every phase including a last line before `finish(true)`. And
quiescence-by-calls could not see a handler suspended on `setTimeout`, so `await sleep(100);
write(…)` lost its tail write from the diff. **The first fix for that was itself wrong twice**,
which §5c's method section should remember: requiring the pong's live-timer count to reach zero
wedged every dev-mode preview at the budget — the count includes realm INFRASTRUCTURE (Vite's HMR
client holds a permanent retry timer in dev workers), and timer bookkeeping cannot tell a script's
sleep from the plumbing's. The mechanism is now the realm's own completion signal:
`{t:"eventDone"}` posted when the dispatch promise settles (after every chained await, sleeps
included), awaited before the drain; the timer count survives only as DIAGNOSIS, baselined against
the lowest value seen, to choose between "did not complete" and the undecidable-decline for a
script legitimately waiting on its own timer.

**Mirrors.** Every preview mounted with EMPTY mirror seeds, so mirror-backed members answered
placeholder fallbacks — `context.properties.sheetCount` read 0 against a real 3-sheet workbook —
with NO broker call, the one kind of wrong answer the gap discipline could not see. Previews now
mount STRICT (`MountSpec.snapshot.strict`): what the preview knows is seeded (sheetNames,
sheetCount), and an unseeded mirror read throws a `PREVIEW_MIRROR_GAP`-marked error that the
preview converts into a decline naming the path (a harness gap in the corpus driver).

**Measurement.** The coverage test's `chain -> broker` map let duplicated chains CLOBBER each
other (`setCellValue` routes to `sheet.setCellValue` on SheetContext and `object.setState` on
TableContext; the map kept whichever sorted last) — it is now a multimap and a chain counts served
only when EVERY route is. Corrected numbers: prompt core 19/19 and corpus 100% (unchanged, still
asserted); addressable coverage 55.3% @8k / 74.6% @4k.

Verification: 107,746 unit tests / 839 files, 11 Rust tests (deep-chain convergence, spill
refusal, boolean IF among them), 14 E2E cases — four new discriminators, one per fix cluster —
and three sabotage rounds, each resurrecting the original defect verbatim (the lost tail write,
the error clobber, `Cannot destructure property 'startRow' of 'undefined'`).

**The four review findings left unverified were then verified and closed (same day):**

- **The evaluation cap was a SILENT regression path.** `preview_evaluate_formulas` returned `Err`
  past 20,000 cells, and the TS catch is the "evaluator unavailable" path — silent by design — so
  a script that grew the grid past the cap had its formulas read back empty with no indication
  anywhere: the E2E-proven "total=42" case regressing to "total=" near the cap. A refusal is an
  ANSWER, so it now travels IN the result (`PreviewEvalResult.refused`) and reaches the report as
  a note; only a genuinely missing backend stays silent.
- **The command ran its work on the MAIN thread.** Tauri executes sync commands there, and a full
  batch is real CPU work — every settle point froze the UI for however long the sheet took. Now
  `async` + `spawn_blocking` (the pivot-calc pattern), and the AGGREGATE is bounded:
  `pass_budget(n) = min(n+1, 512, MAX_TOTAL_EVALS/n)`, trading depth for breadth on huge sheets —
  a deep chain on one ends unconverged, which stores nothing and says so. (The per-formula budget
  already existed: `eval_budget::apply` runs inside the raw eval path — the finding was narrower
  than filed.)
- **Preview memory is now watched, best-effort, and the residual is stated.** A preview runs
  un-consented model output in a Worker sharing the RENDERER process, and heap exhaustion there
  can take the whole UI down before the run budget fires; no browser API prevents it. Strict
  mounts arm `armMemoryWatchdog` (256 MB, 250ms poll of `performance.memory.usedJSHeapSize`,
  scheduled on intrinsics captured at module load so a hostile `clearInterval(1..N)` sweep cannot
  disarm it): it catches the GRADUAL case — a draft accumulating heap across awaits — reports the
  breach as the run's error and closes the realm. Two residuals, documented rather than implied:
  a tight synchronous allocation loop never yields to the poll and remains uncatchable in-realm,
  and the memory API is Chromium-specific (absent → silent no-op). The true fix is out-of-process
  isolation, which is the §7 "renderer is the wrong place" question and an owner-scale decision.
- **"Served" was method-granular and quietly flattered.** Several served backend cases gap at
  ARGUMENT granularity (findAll/replaceAll options, sortRange orientation, pasteRange formulas) and
  counted as fully served in the coverage ratio. `PARTIAL_SERVES` (backend.ts) now DECLARES every
  such case with its condition; the exposure printout carries it as a caveat; and a guard walks
  `respond()`'s served cases for `PreviewGapError` throws and fails on any undeclared one — in
  both directions, so a stale declaration overstating the problem also reds.

Verification for the four: 107,753 unit / 840 files, 13 Rust tests (`refused` structure, budget
clamp, async-command source pin), 14 E2E green against the now-async command, and two more
sabotage rounds (an undeclared argument-gap reds the guard; a silenced refusal reds its test).

### The same three shapes, swept for repo-wide — 2026-08-20

Finding three defects stacked on each other is evidence about the CLASS, not just the instances, so
the repo was swept for each shape: async work assumed complete, user source rewritten before
execution, and a checker reporting a verdict it is not entitled to. 17 candidates were raised and
each was handed to an independent verifier told to REFUTE it; 12 survived, 5 did not.

**Four landed on this feature's own fix, and one was a defect IN it:**

- `drain_jobs` returned on the FIRST job error — and the error that reaches that arm is the
  uncatchable one, the deadline interrupt. So "the cell timed out" was precisely the case that
  walked away with continuations still queued, to resume against the NEXT cell's grids and commit
  under its id. It now runs the queue to empty and reports the first error afterwards. It still
  terminates: QuickJS pops a job before executing it, and a job that faults never runs far enough to
  queue another.
- **Debug mounts still rejected `export function setup`.** The instrumentation pass inserts a yield
  point at offset 0, pushing `export` off column 0, so the line-anchored strip never fired. The blob
  threw, `bootstrap.ts` swallowed it and silently recompiled un-instrumented — so every breakpoint
  in the script was dead, reported only as `instrumented: false`. The strip is now applied BEFORE
  instrumentation, which is safe precisely because it blanks rather than deletes.
- **`export { setup };` and `export * from …` still survived** into the function body. The same
  validator-looser-than-the-engine asymmetry: acorn parses with `sourceType: "module"` and accepts
  them, `hasSetupEntryPoint` finds the declaration and calls the script healthy, and the blob import
  throws. Closing the declaration forms and leaving the specifier forms open just narrowed the hole.
- **The `import` / `export default` strips ate the preceding blank line's newline** (`\s` includes
  `\n`, and `^` matches at a blank line under `/m`), so the blob stopped being line-aligned with the
  author's source — contradicting the invariant stated in that file's own header and relied on by
  `debugRuntime.ts`. Every strip now matches horizontal whitespace only.

**Two more landed on this feature elsewhere**, both of the unentitled-verdict shape: the validator
bound the first parameter of EVERY exported function rather than only `setup`'s, so an exported
helper's ordinary JS (`values.reduce(...)`) was reported as an invented API member and the draft
rejected; and `scoreCandidate` never consumed the validator's `no-entry-point` error, so a script
with no `setup` — which mounts and does nothing — scored 1.0 and `passed: true`, inflating the very
`canaryScore` that picks the authoring tier.

### "Fix everything you discover" — the second pass, 2026-08-20

The owner's instruction turned the three FILED families into fixes:

- **`stripModuleSyntax` is now a tokenizer, not five regexes.** One pass tracking string /
  template (`${…}` nesting included) / comment state. The silent-corruption member — blanking
  DATA inside a multi-line template literal — is dead, and so are the five loud ones. A side
  effect worth naming: the DEBUG mount's strip-before-instrument ORDER stopped mattering,
  because a mid-line `export` is still a statement to a tokenizer; the wrong order now compiles
  too, and a test pins that the defect is gone as a class rather than merely dodged.
- **The validator follows the context now.** The literal `context` is bound unconditionally
  (the wrapper's parameter is reachable by closure from anywhere) unless the script declares its
  own, and a helper's parameter is bound when EVERY call site feeds it a context-bound
  identifier and the name is unique — to a fixpoint, so helper-to-helper handoff is followed.
  Every guard errs toward NOT binding: a polymorphic helper or a reused name stays unexamined,
  because a false rejection is the worse failure. That residue is stated in open-items, not
  hidden.
- **The dry run stops guessing for callers that know.** `ai_dry_run_script` takes an explicit
  `surface`: draftGate labels everything `object-script` (declined authoritatively — its drafts
  are object scripts by definition), a labeled `one-off` is judged with no heuristic able to
  suppress the verdict, and the substring heuristics survive only for unlabeled callers.

The remaining six are real but outside this feature; they are filed in `open-items.md` §2.1 rather
than fixed here. The one worth naming: the object-script realm already fixed the "async handler
rejects and nobody hears it" defect and documented it, and its **extension-realm twin never received
the fix** — the same shape, in the same codebase, with the cure already written down next door.

### The fix's own cost, paid rather than filed — 2026-08-20

Draining the job queue made something newly reachable: a continuation can now be INTERRUPTED, and
aborting a job leaves QuickJS holding a bad refcount, so **dropping that runtime kills the process**
(`p->ref_count > 0` -> `STATUS_STACK_BUFFER_OVERRUN`) — after the test harness has already printed a
green result. Before the drain, a queued continuation never executed, so it could never be
interrupted. The trade was still right (a silent no-op that reports success is worse than a loud
crash), but it was not free, and leaving it as a ledger row would have been leaving a crash in the
product.

The measurement that shaped the repair, taken rather than assumed: **a cell that merely times out
during `eval` drops perfectly safely — nothing was ever queued. It is aborting a JOB that corrupts.**
So the flag is narrow. `NotebookSession::is_poisoned()` is set only when a job faulted, and the
executor retires such a session with `std::mem::forget` instead of dropping it — `session = None`
there IS the crash. An ordinary error, and an ordinary eval timeout, keep the session: a user's
notebook globals are the whole point of a persistent one, and nothing corrupted them.

Two residues, stated rather than hidden: a poisoned runtime is LEAKED (bounded by how often an
`async` continuation outruns the cell budget — rare, and always user-visible), and the unwinding bug
itself is upstream in QuickJS. Both directions of the flag are sabotage-verified — a flag that never
fires would drop a corrupt runtime, and one that always fires would leak a runtime on the commonest
notebook mistake there is.

**The first fix covered half the surface — caught by this session's own adversarial review.** The
notebook got the poison flag; the ONE-OFF path (`ScriptEngine::run` → MCP `execute_script`, the
chat's `run_script`, calp, and `ai_dry_run_script` itself) still dropped its runtime
unconditionally, so a drafted script whose `async` continuation outruns the budget crashed the
whole app **during the "safe" preview**. Probed in minutes, reproduced, fixed the same narrow way:
when a job faulted, the `ScriptContext` is recovered through `RefCell::replace` with an empty
placeholder — `Rc::try_unwrap` can never succeed while the runtime is leaked, and the caller still
needs its console output, which is the only clue about where the script got stuck — then runtime and
context are `mem::forget`-ed. Grids are already withheld on every error by design, so nothing is
lost that an error path ever delivered. Guarded by
`a_job_abort_in_a_one_off_does_not_crash_the_process` (`core/script-engine/src/lib.rs`), whose red
under sabotage is the crashed binary itself.

## 6. Making the API surface sliceable

`calcula.d.ts` (35,599 bytes, ~10k tokens estimated) fits a 32k-context model whole but blows an 8k
one. `objectContexts.d.ts` (348,501 bytes) fits nothing.

**SHIPPED 2026-08-19 as M4** — see the build order for the measured numbers and the four things that
came out of building it.

**No vector store and no embedding model are required.** `draft_object_script` already takes
`object_type`, validated against 16 types (`workbook`, `sheet`, `cell`, `row`, `column`, `slicer`,
`chart`, `pivot`, `button`, `textbox`, `timeline`, `shape`, `table`, `namedRange`, `panel`,
`range` — [drafts.rs:93](../../app/src-tauri/src/mcp/drafts.rs#L93)). The target type is known
before generation begins, so retrieval is a dictionary lookup keyed on it.

The work is to emit a **chunked, indexed variant** of the typings alongside the human-facing
`.d.ts`, from the generator that already exists. `declarations.ts` walks member paths per interface
with the TypeScript compiler API and already resolves `extends`, nested type literals, and local
references — the interface name is a natural chunk key and the member set is already computed. The
existing lockstep test (`objectContextsTypings.test.ts`) should be extended to cover the chunked
output, so the slices cannot drift from the surface either.

## 7. Architecture placement

| Piece | Home | Rationale |
|---|---|---|
| `ChatProvider` trait, `anthropic.rs`, `openai_compat.rs` | `app/src-tauri/src/ai/` | Provider translation is backend concern; keeps vendor wire formats out of extensions |
| Runtime discovery + capability probe | `app/src-tauri/src/ai/` | Talks to localhost HTTP; not extension business |
| L0/L1/L2 static validation for **object scripts** | `app/src/api/scriptHost/` | Its ground truth is `allowlist.ts` (§5a), which lives here. A Bridge concern — "validate this source against the policy" is generic, and the transparency panel wants the same answer |
| L0/L1 for QuickJS surfaces, if ever needed | `core/script-engine/` | It owns `OP_MANIFEST` |
| L3 dry-run entry point | `core/script-engine/` + a Tauri command | Same realm, new non-applying entry |
| Chunked typings emission | `app/scripts/scriptTypings/` | Extends the existing generator |
| Generation pipeline orchestration, tier strategies, prompt assembly | AIChat extension | Business logic — Feature, per the Decision Matrix |
| Draft review + edit + mount | `ScriptableObjects` (unchanged) | Already owns this |

The extension must end up speaking Calcula's own chat/draft shape via `@api`, never a vendor's; if
a seam is missing, add one rather than importing across.

### 7a. Provider coverage — one impl gets most of the way

`/v1/chat/completions` is the de-facto interoperability surface. **`openai_compat` is the workhorse
and should be written first**, ahead of even the Anthropic native impl:

| Reached by | Providers |
|---|---|
| **`openai_compat`** | Every local runtime (Ollama, LM Studio, `llama-server`, vLLM) **and** most cloud vendors — OpenAI, Azure OpenAI, Groq, Together, Fireworks, DeepSeek, Mistral, xAI, and Google Gemini through its compatibility endpoint |
| **`openai_compat` + one base URL** | **OpenRouter** — one key, hundreds of models spanning every major vendor |
| Native impl worth writing | **Anthropic** — keeps thinking blocks and prompt-caching fidelity that the compat shim flattens |
| Deferred | AWS Bedrock (SigV4 signing, enterprise-only); native Gemini (the compat endpoint suffices to start) |

**OpenRouter deserves the specific callout.** Pointing `openai_compat` at one base URL with one key
delivers a genuinely any-vendor picker on day one, without a per-vendor integration each. It is the
cheapest possible route to the owner's stated requirement, and it composes with everything else here
— an OpenRouter model is profiled by the same probe as a local one.

Two consequences for storage:

- **Credentials must become multi-slot.** `TARGET` is a fixed const today
  ([ai_chat.rs:30](../../app/src-tauri/src/ai_chat.rs#L30)); it becomes a function of provider id
  (`Calcula:aikey|<providerId>`), so a user can hold an Anthropic key, an OpenRouter key, and a
  local endpoint simultaneously and switch between them without re-entering anything. Same Windows
  Credential Manager mechanism, same never-returned-to-JS guarantee.
- **The selected model is an application preference, not document state.** It belongs with `locale`,
  `calculation_mode`, and `reference_style` in the population `open-items.md` §2.2 records as
  **permanently exempt from `Persisted<T>`** — it is the user's choice, not the workbook's. A model
  id must never be written into a `.cala`, or opening a colleague's workbook would silently
  repoint your AI at a model you do not have a key for.

## 8. Build order

Sequenced so each milestone is independently useful and nothing is blocked on model selection.

**M1 — Wire the draft tools into the in-app chat. SHIPPED 2026-08-19.** 21/21 -> 24/24. The tool
surface moved to `AIChat/lib/chatTools.ts` so `__tests__/chatToolSurface.test.ts` can read
`ai_chat.rs` at test time and diff both directions; sabotage-checked three ways. It also caught a
defect M1 would have introduced — the transcript printed `name(JSON.stringify(input))`, which for a
draft dumps an entire macro into a chat bubble. Closes §3b.

**M2 — L0/L1/L2 static validation. SHIPPED 2026-08-19**, in
`app/src/api/scriptHost/scriptValidation/`. Parse (acorn), reach check, and capability reconciliation
per the asymmetric policy in §11.2, with nearest-neighbour repair suggestions. Useful immediately for
cloud-authored and hand-written scripts too, not only local ones.

**Its ground truth is a THIRD generated artifact**, `scriptHost/generated/scriptSurfacePolicy.ts`,
emitted by the existing typings generator in the same pass as `objectContexts.d.ts` and pinned
byte-for-byte by `objectContextsTypings.test.ts`. **669 rows, 58 capability-bearing**, each carrying
the author-facing chain, the broker method and the capability. Neither `allowlist.ts` nor the probe
alone was enough: the probe records a path RELATIVE to its owning interface (`upsert`, not
`caps.biModel.upsert`), so chains are composed through `NAMED_SUBTREES`, which is the probe's own
answer to "this sub-object is its own interface".

Four things worth carrying forward:

- **Calls are erased on both sides.** `context.api.chart("c1").setSpec(s)` reduces to
  `api.chart.setSpec`, and the generator erases `()` from its prefixes the same way. That is what
  lets a purely syntactic walk follow a handle with no type inference at all.
- **Members with no broker had to be included.** The first cut emitted only policed members, which
  would have made the reach check reject `context.objectId` — a false positive rejects the user's
  work, which is worse than the miss it trades against.
- **A namespace is not a data-returning call.** `api` is both a member in its own right and the
  prefix of hundreds of chains; treating it as data-returning suppressed every finding beneath it,
  so `api.setCellValu` sailed through as "a method on whatever `api` returned". The discriminator is
  `known chain AND NOT a known prefix`.
- **`formula.udf` is a permanent exemption** from "every gated capability is derivable from source".
  It gates `formula.udf.invoke`, which is the HOST calling INTO a script when a worksheet formula
  uses its UDF — the opposite direction from everything else in the allowlist. No context member
  requires it, so a script declaring it will always draw a `declared-not-observed` notice, which
  §11.2 says is the correct outcome.

**One new runtime dependency: `acorn`** (~120 KB, zero deps of its own, what ESLint and Rollup
parse with). Hand-rolling was rejected for the reason `declarations.ts` gives about regex parsing,
and the stakes are higher here: a false positive rejects the user's script.

**M3 — Provider registry, model picker, and runtime discovery. SHIPPED 2026-08-19.**
`ai_chat.rs` is gone; `app/src-tauri/src/ai/` replaces it with `wire.rs` (Calcula's own chat shape
plus both translations), `providers.rs` (the registry), `discovery.rs`, and `tools.rs` (the
dispatcher, moved verbatim). The extension speaks `lib/aiTypes.ts` and no longer knows any vendor's
schema — `input_schema` became `inputSchema`, and a provider now relocates it (Anthropic wants
`input_schema`, OpenAI-compatible servers want `function.parameters`).

**Eight providers, one native impl.** `openai_compat` reaches Ollama, LM Studio, `llama-server`,
vLLM, OpenAI, OpenRouter and any custom endpoint; only Anthropic needs its own wire, for
thinking-block fidelity. A test pins that — if a second native provider ever appears, §7a's claim
needs revisiting.

**The four differences that actually bite**, each with a test that fails when it is reverted:

| | Anthropic | OpenAI-compatible |
|---|---|---|
| System prompt | top-level `system` field | a leading message with role `system` |
| Tool arguments | `input`, a JSON **object** | `function.arguments`, a JSON **string** |
| Tool results | blocks inside ONE user message | ONE message each, role `tool` — so the translation fans out |
| Stop reason | `end_turn` / `tool_use` | `stop` / `tool_calls` |

The last one has a wrinkle worth keeping: **several OpenAI-compatible servers report
`finish_reason: "stop"` while still emitting `tool_calls`.** Trusting the label ends the agentic loop
with the call never run, which reads to the user as the model ignoring them — so the parser consults
whether tool-use blocks are actually present.

**The selection is an application preference**, held in extension settings
(`ext.calcula.ai-chat.*`) and named on every request, so the backend keeps no selected-model state at
all: no `AppState` field, no reset-on-open question, no `Persisted<T>` decision to get wrong, and no
way for a model id to reach a `.cala`.

Two things the move turned up. `ai_provider_delete_key` had to be re-declared in the
object-dependency census — the rename broke the row for `ai_chat_delete_api_key`, and the census
caught it. And the `credentials` denylist in `backendCommands.ts` had never listed the AI key
commands at all; the new ones are there now, along with `ai_chat_complete`, which is not a key write
but is the path that SPENDS one.

**M4 — Sliceable typings. SHIPPED 2026-08-19.** A third generated artifact,
`scriptHost/generated/scriptSurfaceSlices.ts` (**667 entries**), emitted by the same generator pass
and pinned byte-for-byte by the lockstep test; plus `api/scriptHost/scriptPrompt/`, the budget-aware
assembler from §4d.

**Measured, which is what justified the work:**

| | est. tokens | |
|---|---|---|
| `objectContexts.d.ts` | ~96,800 | unusable in any context window |
| signature slices | ~29,000 | **70% smaller** — fits 32k+ |
| one object type | ~24,000 | still too big for an 8k model |

So slicing alone was never going to be enough; something has to **choose**. `buildSurfacePrompt`
ranks by group (`context` → `grid` → `capability` → `other`), promotes hint-matched members ahead of
their group, and fills to the budget. A 4k budget still carries `caps.fetch` when the request says
"download".

Four things worth carrying forward:

- **Truncation is announced.** A silently partial surface is worse than a small one: the model cannot
  tell "Calcula has no such method" from "I was not shown it", so it invents one, L1 rejects the
  invention, and the repair loop burns its rounds rediscovering the gap. The prompt names the number
  omitted and says what to do instead.
- **The fill prices the RENDERED entry**, not the generated `cost`. The latter omits the `context.`
  prefix, comment markers and separators — an ~8% overrun, and a budget exceeded by any margin is
  exactly the truncate-at-a-random-byte failure the module exists to prevent.
- **Signatures must strip comments.** A member whose type is a nested type literal carries that
  literal's own JSDoc: `api.text` dragged 200+ characters of CSV prose into what was meant to be a
  declaration.
- **The artifact emits shared + per-type delta.** Listing all ~530 chains once per object type made
  the file 343 KB — as large as the `.d.ts` it exists to shrink — because ~520 are identical across
  all 17 types.

**M5 — The eval set. SHIPPED 2026-08-19.** **36 tasks** at `tests/eval/tasks.json`, in two layers.

**Layer A needs no model and runs in CI.** Every task carries a `reference` solution, and
`scriptEval/__tests__/corpus.test.ts` puts each one through the real validator. A task whose own
answer does not validate is not a hard task, it is a broken one — it would mark every model wrong for
refusing to reproduce a mistake. Because the references are checked against the LIVE surface, a task
also rots the moment the API moves under it.

**Layer B is `tests/eval/run-eval.mjs`** — opt-in, needs a provider. It bundles the app's OWN scorer
and prompt assembler rather than reimplementing them, so the number describes the pipeline that
actually ships.

### What it found in its first hour

**Two real defects, both in already-"finished" milestones. This is the whole argument for the
milestone.**

1. **M4's ranker put `api.setCellValue` outside a 4k budget.** Ranking was group-then-alphabetical,
   so the most basic operation there is lost to a hundred alphabetically earlier and far more
   obscure members; nine canary tasks were unanswerable by construction. Fixed with an explicit core
   set, tiered hint matching, stopwords (an innocuous "and" in a request tier-0 matched
   `executeCommand` and hoisted junk to the very top), stemming (`"store"` is **not** a substring of
   `"storage"` — that one miss ranked both storage methods 517th of 528), and a **capability index**:
   one representative member per capability, always shown, because lexical matching cannot be relied
   on to surface `caps.fetch` for a request that says "Get JSON from https://…".

2. **M2 passed VACUOUSLY on a script with no `setup` function.** With no recognisable entry point
   nothing was rooted, so the reach check examined nothing and the capability check derived nothing —
   a script calling `context.caps.fetch(...)` reported a clean bill of health. Found on a real 3B
   model's very first answer, which wrote a bare top-level `onClick(...)`. Such a script also mounts
   and does **nothing**: the wrapper tail is
   `typeof setup === "function" ? setup(context) : undefined`. Now a `no-entry-point` error, plus a
   bare-`context` binding fallback so the calls are examined regardless.

**The measured score got WORSE as it got more honest**: `qwen2.5-coder:3b` scored 0.700 mean before
the vacuous-pass fix and **0.550 after**, on the same 12 canary tasks (0/12 passed). A 3B model is
below the bar for this work, which is a legitimate finding rather than a disappointment — it is
precisely the number the picker needs to be able to show.

**M6 — Streaming. SHIPPED 2026-08-19.** `ai/stream.rs` — an incremental SSE decoder plus an
accumulator for both wire formats — and `ai_chat_complete_stream`, which emits deltas on
`ai:chat-stream` (one event, correlated by `streamId`, rather than a listener per turn).

**Streaming stayed a transport detail.** The command returns the same `ChatResponse` the blocking
one does, and the agentic loop is byte-for-byte unchanged; the deltas are for the eye. A provider
that cannot stream therefore changes nothing about how a conversation behaves.

**The hard part is tool calls, not text.** Arguments arrive as JSON FRAGMENTS — Anthropic's
`input_json_delta.partial_json`, OpenAI's `tool_calls[].function.arguments` — and `{"start_ro` is
not parseable on its own. Getting this wrong does not error; it silently hands the tool `{}` while
the model's real arguments are discarded. Two traps, each with a test that reds when reverted:

- **Accumulate by `index`, never by `id`.** Only the FIRST fragment carries an id, so keying on it
  loses every fragment after the first.
- **The SSE decoder must buffer across network chunks.** A boundary falls wherever it falls —
  mid-line, mid-JSON, mid-UTF-8. Parsing per chunk works on a fast local socket and truncates over a
  real network, which is exactly the case streaming exists for.

**Verified against a real server, not just against my model of one.** A stream captured from Ollama
(`qwen2.5-coder:3b`) is pinned verbatim in the test file, and it corrected three assumptions:
`finish_reason` is `null` rather than absent on intermediate chunks, `delta.content` is an EMPTY
STRING alongside a tool call rather than omitted (so it must not become a text block), and Ollama
sends the whole `arguments` in one chunk rather than fragmenting. The same recorded bytes are then
driven through the decoder at chunk sizes 1, 2, 3, 7, 13, 64, 255 and 1024 and must produce an
identical result.

**M7 — Capability probe, tiered strategies, repair loop. SHIPPED 2026-08-19.** Built last, exactly
because M2 and M5 are what make it measurable.

- **`modelProfile/`** — `probeModel` runs the canary tasks through the real scorer and returns a
  `ModelProfile`; `planFor` derives the strategy from the measurement, never from the model's name.
- **`scriptAuthoring/`** — `authorScript`: build the prompt, generate, validate, hand the errors
  back, repeat. This is where M2, M4 and M7 stop being separate pieces and become the feature.
- **`generated/canaryTasks.ts`** — the 12 canary tasks, generated from `tests/eval/tasks.json` and
  pinned by a lockstep test that calls the GENERATOR's own renderer. Vite cannot import across the
  project root, so the subset is generated in rather than imported; §11.3's "both read the same
  definitions" is now a fact rather than a comment.

**Repair rounds go UP as the model gets weaker** — 1 / 3 / 6 across the three tiers. That is
backwards only if you are paying per token; locally a round costs electricity and a few seconds, and
spending them where they are needed is the whole reason a modest machine can produce a usable script
(§1a).

**Two properties the loop must never lose**, each sabotage-verified:

- **Running out of rounds is a FAILURE**, reported with the last draft and the outstanding findings
  so the user can see how far it got. Returning the final attempt as though it had succeeded would
  hand a broken script to the reviewer with a clean bill of health.
- **The repair prompt carries ERRORS ONLY.** Feeding the notices back would teach the model to strip
  capability declarations it cannot prove it needs — the exact opposite of §11.2.

### Measured: what the repair loop does and does not fix

12 canary tasks, 4,000-token surface budget, run against the local Ollama:

| model | mode | passed | mean |
|---|---|---|---|
| `qwen2.5-coder:3b` | one-shot | 0/12 | 0.550 |
| `qwen2.5-coder:3b` | **4 repair rounds** | **1/12** | **0.646** |
| `qwen2.5:7b` | one-shot | 0/12 | 0.613 |

**The repair loop bought more than the bigger model did.** +0.096 from repair on the 3B, against
+0.063 from moving to a model more than twice the size — and the repaired 3B outscores the plain 7B
outright. That is the §1a claim ("a mediocre local model with a verify loop beats a better one
without") holding up on real measurements rather than on argument.

**Read it with the caveat, though:** these are different families (a CODER 3B against a GENERAL 7B),
so it is not a clean scaling experiment. What it does establish is that repair is not a rounding
error next to model choice. **Neither model crosses the bar** — 0/12 and 1/12 — so nothing here says
a local model is ready; it says the loop is worth having when one is.

It works — `trap-browser-fetch` went 0.65 to **1.00** after a single repair, the model having forgotten
the `net.fetch` pragma and been told exactly what to add. But the shape of the residual failures
matters more than the +0.096:

- **Six of eleven failures were VALID scripts that did not do the job.** They parse, invent nothing,
  and declare their capabilities correctly — they simply do not call what the task needs. The loop
  stopped after one round in each case because `validateScriptSource` reported `ok: true`, which was
  the honest answer: **L0–L2 cannot see "correct but useless".** The 7B run shows the same split —
  six of its twelve failures are the same shape — so this is structural, not an artifact of one
  small model.
- **Five were still invalid after exhausting all four rounds** — one never parsed at all. More
  rounds do not rescue a model that cannot hold the API in its head.

**This is the empirical case for L3, the dry-run diff.** §5 lists it and M2 did not build it: the
verification ladder currently ends at static checks, and static checks are structurally blind to the
larger half of what actually goes wrong. A script executed against a cloned workbook, with the diff
compared to what the task expected, is the only thing that catches this class — and it is the piece
that would let the repair loop correct behaviour rather than only syntax and policy.

**A 3B model remains below the bar** either way, which is a legitimate finding rather than a
disappointment: it is exactly the number the picker needs to be able to show.

### One correction to §4b

That section described `contextTokens` as "measured, not what the card claims". **It is not
measured**, and the profile documents it as declared. Establishing a real context limit means
binary-searching with very long prompts: slow locally, and metered on a cloud endpoint. It is a
setting with a conservative 8192 default. Everything else in the profile — `canaryScore`,
`decodeTokensPerSec`, `emitsFencedCode` — is genuinely measured.

`MAX_TOOL_TURNS = 8` ([ChatView.tsx:261](../../app/extensions/AIChat/components/ChatView.tsx#L261))
is sized for Claude and likely too tight for a local model that spends turns re-orienting; revisit
it under M7 with eval data rather than guessing now.

## 9. Model guidance (as of 2026-08 — re-verify before shipping any default)

This landscape moves fast enough that anything here should be treated as a starting point for the
eval set (M5), not as a decision.

**Start with one model for both authoring and any tool use: Qwen3-Coder-30B-A3B.** Apache 2.0, MoE
with roughly 3B active parameters so decode stays interactive, strong on TypeScript/JavaScript. A
competent coder model is also a competent tool caller, and a second resident model is not affordable
on one consumer GPU — the swap costs a full context re-prefill mid-conversation. **Split into two
models only when the eval set shows a single model losing**, not before.

| Role | Candidate | License |
|---|---|---|
| Primary (author + drive) | Qwen3-Coder-30B-A3B | Apache 2.0 |
| Generalist alternative | Mistral Small 3.2 24B — tuned for function calling | Apache 2.0 |
| Agentic code specialist | Devstral Small | Apache 2.0 |
| Smaller tier | Qwen3-14B — viable *with* constrained decoding + skeleton-filling | Apache 2.0 |

**Licensing is a product constraint, not a footnote.** Codestral's MNPL is non-commercial and must
never be a recommended default for a tool people use at work. Llama's community licence carries an
acceptable-use policy and a 700M MAU clause — usable, but prefer Apache-2.0 for anything Calcula
*recommends*. The user's own choice remains theirs; this governs defaults and documentation.

Gemma 3 is capable but weak at function calling; it may still do well at pure script authoring,
which is precisely the kind of question M5 exists to answer.

## 10. Risks and honest limits

**CPU-only users are not excluded, but they will feel it.** A 7B at q4 on CPU runs roughly
5–15 tok/s; a 60-line script is 1–3 minutes. Streaming makes that tolerable rather than broken. The
probe must say so plainly — *"This model scored 4/10 on script tasks and generates at ~8 tokens/sec.
Expect slow generations and several repair rounds."* Stating a measured expectation serves the
transparency pillar; silently shipping worse results would violate it.

**Skeleton-filling should be prototyped early, not last.** If it works it collapses the bottom
tier's requirement from "can author correct code" to "can pick a template and fill parameters",
which small models do reliably. That is the difference between *local models are supported* and
*local models are the default*. It is listed under M7 by dependency, but a throwaway prototype
during M2 would de-risk the whole tier.

**The verifier is now load-bearing for correctness.** L1 rejects anything outside `OP_MANIFEST`, so
a manifest that drifts from the realm becomes a generation bug as well as a transparency bug. The
existing round-trip test guards this; it must not be weakened.

**Quality ceiling is real.** A local 30B handles "flag margin declines", "build a month-end
close macro", "normalise these headers". It will not handle "review this financial model and tell me
what is structurally wrong". Keeping cloud selectable is what prevents that ceiling from becoming
the product's ceiling.

## 11. Owner decisions — DECIDED 2026-08-19

All three were open questions in this document's first draft. They are settled; the reasoning is
kept because each has an obvious-looking simplification that is wrong.

### 11.1 First-run posture: lead with local, never block on it — DECIDED

1. **A runtime already running is the silent happy path.** Probe the four known ports, offer its
   models, say nothing else.
2. **Nothing found: show both routes, local first, reason in one line.** *"No local model found.
   Calcula can run one so your workbook never leaves this machine — [Set up a local model] ·
   [Connect a cloud provider]."* One line, not a setup wall.
3. **Never interrupt a working setup.** A user with a stored key gets their key, and discovers local
   in the picker. A privacy explainer in front of an already-configured feature is pure friction.

Cloud-first would waste the one moment where the privacy claim lands. Local-only would gate the
feature behind a multi-gigabyte download before anyone has seen it work, and contradicts the
any-model principle in this document's header.

### 11.2 Capability pragmas: the model declares, the checker verifies — DECIDED

**The model must write its own `// @capability` lines. We do not write them for it.** But its
mistakes are caught mechanically rather than reaching the user.

**Why not auto-declare, which is friendlier and was the tempting option.** It assumes a scanner can
always see which capabilities a script uses. It cannot — JavaScript reaches methods indirectly:

```js
const method = useBackup ? "fetch" : "log";
await context.caps[method](url);          // no `caps.fetch` appears anywhere
```

Auto-declaring off a scan of that source writes *no* pragma, and per §5b the script then dies at
runtime with `PermissionDenied` the first time `useBackup` is true — after review, after mounting,
possibly on a schedule or inside a distributed report.

**The scanner's reliability is lopsided, and the policy follows the asymmetry:**

| Finding | Treatment | Why it is safe |
|---|---|---|
| Calls something it did **not** declare | **Reject; repair loop** | The scanner saw a real call. No false positives possible. One local round-trip, and the message writes itself: *"line 34 calls `caps.fetch` — add `// @capability net.fetch`"* |
| Declared something the scanner did **not** find | **Never reject. Show the reviewer** | Could be the indirect-call case (correct), could be over-broad (should be trimmed). A machine cannot tell; a person can |

**The reviewer sees the claim next to the evidence**, which is strictly more than either alone:

> **Declared:** `net.fetch`, `storage`
> **Found in the code:** `storage`
> ⚠️ `net.fetch` is declared but no call to it was found.

That warning is not an error — it is the one line worth a human's attention. **This is the actual
argument against auto-declaring:** a generated list always *looks* right, which removes the
reviewer's ability to notice when it is not. Transparency here is not strictness, it is the visible
gap between what was claimed and what was found.

**Do not simplify this back to auto-declaration.** The indirect-call case is the whole reason, it is
easy to forget, and the failure it causes is silent and late.

### 11.3 The eval set ships, in two tiers — DECIDED

- **Full corpus in `tests/`** — a developer/CI artifact, public, no UI and no support promise, the
  same standing as any other suite in the repo. It has to live there for M5 anyway, and withholding
  it would make every compatibility claim unfalsifiable, which is a poor look for a project whose
  pitch is auditability.
- **A small subset is the in-app probe's `canaryScore`** (M7): a handful of tasks, ~2 minutes,
  against whatever model the user selected.

**Both read the same task definitions**, so the number a user sees in the picker and the number CI
reports cannot diverge.

---

## 12. The chat that would not act — post-ship repair, 2026-08-22

Reported from live use against a local model. Prompt:

> create a script that formats the background color of each selected cell, using the content of the
> cell, for example: #FFFF00

The model replied with a fenced json code block containing
`{"name": "format_cells", "arguments": {"cells": ["A1","B3","C5"], "color_map": {...}}}`.
Nothing ran. No script was created. The turn ended looking exactly like a normal conversational
answer.

**Four separate defects in one reply**, and the interesting part is that none of them was in the
tool-use loop, the wire translation or the sandbox — all of which behaved exactly as specified.

### 12.1 It printed a tool call instead of emitting one — and nothing noticed

`push_openai` fills `acc.tool_calls` only from `delta.tool_calls`, so a call written into `content`
produced zero `toolUse` blocks and `stopReason: "endTurn"`; the loop broke and rendered the prose.
Correct behaviour at every layer, and a total product failure.

**Decided: recover it, and say so.** `AIChat/lib/textToolCalls.ts` searches the assistant text for a
tool call when — and only when — the turn produced no native one. Three rules keep the net from
catching prose that merely *discusses* a tool: names are matched EXACTLY against the live surface
(no fuzzy mapping, ever), the object must carry only tool-call envelope keys, and nothing is
evaluated (`JSON.parse` only).

**The prompt is the real fix; the parser is the floor.** `SYSTEM_PROMPT` now opens with the calling
mechanism ("writing a tool call as text does nothing") and names the closed set, interpolated from
`TOOLS` so it cannot drift. A 3B model has "here is the JSON you asked for" heavily represented in
its training data and will regress to it; Calcula's premise is that a local model is a first-class
way to use the product, so the floor is what the user experiences.

**Security posture — the one real decision here.** A salvaged call is dispatched through the same
`ai_chat_run_tool` as a native one, so it inherits the identical window guard, script-security tier
and audit trail: this adds no reach. What it adds is a heuristic in the provenance of the parse, and
a heuristic must not be the sole authority for a silent edit to someone's workbook. So:
`SALVAGE_AUTORUN` (fail-closed) lets read-only tools and `draft_object_script` run — the latter
because it neither mounts nor executes anything, and its entire output is a review-queue entry a
human must then approve — while every mutating tool is confirmed with an awaited `confirmAsync`.
A NATIVE call is never subject to this; the model used the interface built for the purpose.

### 12.2 It invented `format_cells`

A plausible near-neighbour of the real `apply_formatting`. Nothing had ever shown the model the tool
list as CLOSED, and an unknown name reached the Rust dispatcher and came back as a bare
`Unknown tool 'x'.` with no hint. Now: the prompt names the set, and an invented name produces a
repair message naming the closed set and the nearest real tools by edit distance, fed back through
the model's own agentic loop (the same mechanism `draftGate` uses, not a second loop).

### 12.3 There was no way for it to know what "selected" meant

A grep of `chatTools.ts` for `selection` returned nothing: not one tool exposed it, and
`mcp/tools.rs` hardcodes `selection_context: None`. The model's `["A1","B3","C5"]` was not laziness,
it was filling a hole.

**Decided: prompt injection, not a tool.** `AIChat/lib/selectionContext.ts` tracks
`AppEvents.SELECTION_CHANGED` and appends one line to the system string at send time, in BOTH A1 and
0-based coordinates (the tools are 0-based; a drafted script is read by a human in A1, and the
conversion is where a small model goes off by one). A tool would need a Rust arm, a new command, a
backend that does not have the state, and a turn for the model to spend calling it — and, unlike a
prompt line, could be forgotten by a weak model, which is the failure being fixed.

### 12.4 The dry run judged the draft at a tier it will never run at

`previewObjectScript` defaults to `tier: "unlocked"`; `draftToScriptDefinition` mounts every AI
draft `"restricted"`, deliberately. So L3 green-lit scripts reaching `context.api.*`, the user
pressed Save, and the script was refused by a gate the preview had never consulted.

Now previewed at `"restricted"`. **A tier failure is a NOTICE, not a rejection** (§11.2): the second
run at `"unlocked"` makes the diagnosis a DEDUCTION rather than a regex — the tier is the only thing
that changed — and a script that passes there is allowed through with a note telling the user to
raise the access level. Rejecting would teach the model to avoid `context.api.*`, which for a button
is the only route to the grid.

### 12.5 And the user could not see any of it happening

> you just see an empty field and you have no idea of where the progress is at the moment

Measured, not guessed: the earliest event of any kind was emitted from inside the chunk loop, so
everything before the first token rendered as a literal "…" — for up to the full 180-second
timeout, during which a cold local model loading into VRAM and a runtime that is not running looked
identical. Three new `StreamEvent` variants (`Requested`, `Opened`, `ReasoningDelta`) report
transitions that actually happened; none invents a percentage. `reasoning_content` had always been
ACCUMULATED and never emitted, so on a reasoning model the entire visible turn produced nothing.

Also fixed on the same screen: a tool call was announced by the stream AND appended again by the
dispatch loop (two bubbles, neither resolving); a tool that THREW produced no UI at all while the
model was told, so the loop could burn all eight turns in silence; `CONNECT_TIMEOUT_SECS` (10s)
separates "Ollama is not running" from "the model is thinking"; and `ai_chat_cancel_stream` makes
Stop real — it abandons Calcula's side and says plainly that it does not reach the provider.

### 12.6 The probe measured the opposite of what the chat needs

`emitsFencedCode` is TRUE for essentially every model and is a VIRTUE for script authoring. For the
chat it is the failure mode. The probe sent `tools: []`, scored the model at a respectable number,
and said nothing. `emitsNativeToolCalls` is now measured with one trivial tool — **advisory, never
fatal**, since a textual call is now recovered and a false negative must not lock out a working
model.

### 12.7 The draft was created and then unreachable

The editor auto-opens once on `mcp:script-draft`. After that window is closed the only route back
was asking the model in English to call `list_script_drafts` — a tool for the model, not a surface
for the person the draft was written for. `ScriptEditorProvider.openDraftInEditor(draftId)` is a
REQUIRED member of the existing `@api` seam (a missed registration should be a compile error, not a
button that silently does nothing), and the chat renders "Open in Object Script Editor" beside the
call that produced the draft.

### 12.8 What this cost, and the standing lesson

Every layer was individually correct. The tool-use loop, the wire translation, the sandbox, the
draft queue and the review path all did exactly what they were specified to do — and the product
did nothing, twice over: no action, and no report that no action had been taken. **A pipeline of
correct components fails silently at the seam where nobody owns the outcome.** The guards added here
are therefore about OUTCOMES, not layers: does a printed call still get the work done, does an
invented name teach the model, does every tool call reach a terminal state on screen, does a draft
stay reachable.

`ChatView.tsx` had no test of any kind before this — no unit test imported it, no E2E journey drove
it. It is where all four defects met. It now has `__tests__/chatViewSalvage.test.tsx`, and the
logic that can be wrong was moved into pure modules (`textToolCalls`, `toolTimeline`,
`selectionContext`) that are tested without jsdom.
### 12.9 It still did not work — and the cause was none of the above (2026-08-23)

The user retried the same prompt after §12.1-§12.8 shipped and got three red bubbles: two
**native** tool calls naming `formatSelectedCellsBackgroundColor` and `setSelectionForegroundStyle`,
then the model giving up with `{"error": "Unknown tool"}`. So the model WAS emitting real tool
calls through the real interface. It was inventing the names.

Two things were wrong, and only one of them had been guessed.

**The repair was wired to the wrong half.** §12.2's unknown-name message was reachable only from
the SALVAGE path — a native invention went straight to `ai_chat_run_tool` and came back as a bare
`Unknown tool 'x'.` with no list of what exists, which is precisely the input that made the model
invent a second name and stop. Moved into the dispatch loop, so provenance no longer decides
whether the model is told anything.

**And then it was measured, against the live Ollama on this machine.** Replaying the user's exact
request through the real `chatTools.ts`, `qwen2.5-coder:3b`, 4 trials per cell:

| tool surface | temperature | named a real tool |
|---|---|---|
| 24 (all) | provider default | **0 / 4** — 2 invented natively, 2 printed an invented name |
| 24 (all) | 0 | **0 / 4** — deterministically invented `format_selected_cells` |
| 12 (first twelve) | 0 | **4 / 4** — `apply_formatting` |
| 10 (designed core) | 0 | **4 / 4** — `apply_formatting`, natively emitted |

**The surface SIZE is the lever.** Not the prompt — the closed set was already named in it, and the
model invented anyway. Not the temperature — temperature 0 changed 0/4 into a *reproducible* 0/4,
which is worth having for support and for a repair loop that would otherwise thrash, but it fixed
nothing on its own. Two dozen tool schemas is ~14k characters of JSON, and a 3B model handed that
reaches for a plausible name it made up instead of the `apply_formatting` sitting in its own list.

**So the recovery is to give it fewer names, not to repeat the list at it.** `CORE_TOOL_NAMES` (10)
covers orientation, read, write, format and both script paths; `ChatView` narrows to it after a
turn in which EVERY call was invented, tells the user why, and retries. Adaptive rather than a
setting or a profile lookup: it needs no probe the user may never have run, costs a capable model
nothing because it never fires, and reacts to what actually happened instead of to a prediction.
A second all-invented turn stops and names the model as the limit.

`draft_object_script` is in the core set because the naive "first twelve" slice DROPS it — that
slice scored 4/4 on tool names while answering "create a script" by formatting cells. And
`buildSystemPrompt` now takes the surface, because a prompt still naming 24 tools while the request
carries 10 would be worse than the bug it fixes.

**Honest residue.** With the core set the model reliably calls `apply_formatting` — a real, correct,
undoable action that colours the cells. It does not choose `draft_object_script`, so it answers
"create a script that formats X" by formatting X. That is a 3B model failing to distinguish a
request for automation from a request for the outcome, and no prompt wording tested here changed
it. The product now does something real and says what it did, instead of nothing; getting a small
model to prefer the script path is a separate piece of work, and belongs to the eval corpus rather
than to another prompt tweak.

**The method is the lesson.** §12.1-§12.8 were reasoned from the code and every one of them was a
real defect — but the defect the user actually hit twice was decided by a number that took one
script and four minutes to measure against the model on their own machine. Two of the fixes shipped
in that round (the prompt's closed set, temperature) are now known to be worth less than they
looked. Measure the model before theorising about it.
