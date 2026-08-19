# Local-model script authoring — hardware-independent AI that writes Calcula scripts

**Status:** DESIGN. Nothing in this document is implemented. Written 2026-08-19, code
inventory verified against the tree the same day.

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
| **Object-script policy** | `api/scriptHost/allowlist.ts` | **The ground truth for what this feature drafts.** 237 methods, **54 capability-bearing**, mapped to the 16 ids. Its own header: consumed by broker dispatch, the transparency panel, and consent-dialog text, "so drift is impossible" |
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
| **Object scripts** — what `draft_object_script` produces | per-script hardened **Worker** | **`api/scriptHost/allowlist.ts`** (237 methods, 54 capability-bearing) |
| notebook-cell, one-off-script, mcp-tool | Rust **QuickJS** | `core/script-engine/src/manifest.rs` (`OP_MANIFEST`, 130 entries) |

`SURFACE_PROFILES` in `manifest.rs` names its three surfaces explicitly, and `object-script` is not
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

**L3 must be a true dry run.** The interpreter already executes over cloned grid state
(`ReachClass::Grid` in `manifest.rs` is explicit that nothing escapes the clone), so the substrate
exists. The new work is an entry point that runs and reports **without applying the writeback** —
`tools::execute_script` today is undoable-and-applied, which is not the same thing.

## 6. Making the API surface sliceable

`calcula.d.ts` (35,599 bytes, ~10k tokens estimated) fits a 32k-context model whole but blows an 8k
one. `objectContexts.d.ts` (348,501 bytes) fits nothing.

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

**M4 — Sliceable typings** from the existing generator, with the lockstep test extended (§6).

**M5 — The eval set.** 30–50 golden tasks: intent in, sandbox assertions out. This is the asset that
makes the whole design durable — **when a new model lands we run the eval, we do not redesign.** It
is also what gives `canaryScore` its meaning and what lets us publish an honest known-good model
table instead of vibes.

**M6 — Streaming.** `ai_chat_complete` is one blocking POST with a 120 s timeout
([ai_chat.rs:170](../../app/src-tauri/src/ai_chat.rs#L170)). Cloud latency hides that; a local model
generating a 60-line script does not. Watching code get written is also a genuinely better
experience than a spinner.

**M7 — Capability probe, tiered strategies, repair loop.** The adaptive machinery from §4b/§4c,
built last because M2 and M5 are what make it measurable.

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
