# Calcula Wave 3 — Scripting & Security Completion

> ## Current as of 2026-08-16 — read this before trusting any security claim below
>
> This is a **wave record**: it describes what Wave 3 delivered, as of 2026-06-14.
> The security model has moved since, in ways that make several of the original
> statements wrong in the *dangerous* direction. A 2026-08-16 documentation audit
> corrected them in place; each correction is marked `[CORRECTED 2026-08-16]` and
> cites the code that closed it. What a reader needs up front:
>
> - **The capability vocabulary is no longer the six ids §0 calls "final".** It is
>   **16**, and the module is authoritative:
>   `ALL_CAPABILITY_IDS` in `app/src/api/scriptHost/capabilityIds.ts:216-233`.
>   Read the module, never this document.
> - **The Rust contract in §1 was wrong and the code says so in its own header.**
>   A capability now needs up to **three** entries, not one. Omitting the Rust one
>   already broke `schedule` — approved in the UI, refused by the backend forever
>   after (`capabilityIds.ts:29-35`).
> - **MCP tools ARE a user-scripting surface with a model provider.** The §5 table
>   said the opposite. `core/script-engine/src/manifest.rs:343-366` carries a
>   `CORRECTED 2026-08-02` note recording that "every mirror repeated 'grid-only'.
>   Both were false." This document was one of those mirrors.
> - **The §9 residual (unverified `codeInventory` reach) is CLOSED** — see §9.
> - **Two security defects were found in this model AFTER it was declared
>   complete**, both now fixed: BUG-0086 and BUG-0092. They are recorded in
>   §10, which is new. A model described as complete that never mentions the
>   holes later found in it is the most misleading thing a security document can
>   do.
> - **"Code from an application runs restricted" gained ONE narrow exception on
>   2026-09-30 (owner decision B), recorded in §11.** An approved application
>   macro that a PERSON runs may read and change cells on any sheet while that
>   run lasts -- the tier stays restricted, nothing else is granted, and a run a
>   script starts gets none of it, in either runtime. Every door the owner named
>   carries it: Developer > Macros > Run, a button click (a button control's
>   link, an in-cell button, a button cell) and the command line's `run`. Rust
>   co-decides the grant and records the door and every cell the run changed,
>   and a granted run that fails part-way is undone whole, like the module
>   runtime. Read §11 before relying on the old rule.
> - **An application's button code runs only through Rust, and an approval
>   counts only on the computer that made it** (BUG-0257 phases 4-5,
>   2026-09-30/10-01). Every button click goes through the Rust button door,
>   which reads the code from its own store and asks the approval of its exact
>   bytes; approvals are sealed to this computer; an application's button-cell
>   COMMAND needs Calcula's list (empty today) and its own approval; and the
>   Promote dialog shows what code a promotion changes. See the last bullets of
>   §9.
> - Still accurate and load-bearing: the §2 UDF architecture, the §4 extension
>   sandboxing design, and the §6-§8 rationale. Those are why this file is kept.
>
> The **live** list of what is open is `docs/design/open-items.md` (corrected
> 2026-10-02: `docs/design/open-decisions-2026-08.md`, which this line used to
> name, is the archive behind it); defects with a reproduction are in
> `tests/regression/bug-ledger.json`; the **live** surface taxonomy is
> `app/src/api/scriptSurfaces.ts`.

**Status:** Complete (2026-06-14). Builds directly on Wave 2
(`docs/design/script-sandbox-architecture.md` — per-script Worker realms, the
tier broker, the capability/consent model, Ed25519 `.calp` signing). This
document is the canonical record of everything Wave 3 added.

**Scope delivered:** C1 (user-defined formula function *evaluation*), S8/C7
(distributed-extension sandboxing — governance **and** worker-realm isolation),
C3 (script-surface unification + taxonomy), the `bi.query` and `bi.sql`
capabilities, signed sidecar extension manifests, worker-extension menus, and
command return values. Nothing in scope was deferred. The single explicitly
out-of-scope item is a future shared audit trail across the Rust QuickJS
surfaces (see §9; since done).

---

## 0. What shipped (summary)

| Area | What | Result |
|---|---|---|
| Shared substrate | One capability vocabulary (`capabilityIds.ts`); shared broker-error → surface-failure map (`errorMap.ts`) | The 3 duplicated capability-id sets collapsed to one; C1 + extensions share one error mapping |
| C1 — UDF evaluation | Registered `formulas.registerFunction` impls now *evaluate* in worksheet formulas (were autocomplete-only → `#NAME?`) | Engine `udf_fn` hook + off-thread pre-fetch + broker-mediated `formula.udf` capability |
| S8/C7 Phase A | Distributed extensions trust-classified + capability-ceiling-bounded (deny-by-default) + transparency-tracked | Governance + provenance groundwork on the main thread |
| S8/C7 Phase B | `workerSupport:true` distributed extensions run **sandboxed** in a hardened worker realm (no ambient DOM/Tauri/network) | True isolation; data-driven async-RPC ExtensionContext subset |
| Signed manifests | Sidecar `<base>.manifest.json` + Ed25519 `<base>.manifest.sig`, verified (TOFU) at scan; authoritative ceiling read WITHOUT importing the bundle | No double-import; tamper/publisher-change detection |
| Worker menus | Worker extensions register real menu items (click relays to the worker handler; torn down on unmount) | — |
| C3 — surface unification | One queryable surface taxonomy (`scriptSurfaces.ts`); design doc corrected; notebooks documented as already-contained | Governance convergence, not a risky execution rewrite |
| `bi.query` | Structured, model-scoped BI queries for scripts (measures/groupBy/filters via the cached engine path) | No raw SQL, no DB-wide access; the last deferred Wave 2 capability |
| `bi.sql` | Higher-trust **raw read-only SQL** as a separate capability | Engine connector-by-index + Rust read-only re-validation |
| Command results | `CommandRegistry.execute` returns the handler's value; surfaced through the worker proxy + `executeCommand` | Worker command results reach the caller |

**Capability vocabulary as Wave 3 shipped it (2026-06-14):** `net.fetch`,
`bi.query`, `bi.sql`, `storage`, `ui.html`, `formula.udf`. All have real
executors, R19 declared-capability ceilings, grant/consent, and audit, across
object scripts **and** worker extensions.

> **[CORRECTED 2026-08-16]** This list was originally published as
> "**Capability vocabulary (final)**". It was not final, and re-typing it here at
> all was the mistake: CLAUDE.md's rule is that the canonical id list is
> `ALL_CAPABILITY_IDS` and is "never re-typed elsewhere". The vocabulary is now
> **16 ids** (`app/src/api/scriptHost/capabilityIds.ts:216-233`) — the six above
> plus `bi.model`, `bi.connector`, `ui.dialog`, `distribution.writeback`,
> `schedule`, `file.picker`, `ui.shortcut`, `grid.read`, `distribution.publish`
> and `distribution.subscribe`. The six are kept above only as the historical
> Wave-3 scope statement. **Read the module, not this paragraph** — the count
> here will drift again and this sentence will not.

---

## 1. The shared substrate

Wave 3 generalized the Wave 2 broker from "object scripts only" to "any
imperative surface."

- **`app/src/api/scriptHost/capabilityIds.ts`** — the SINGLE source of truth for
  the capability vocabulary (`ALL_CAPABILITY_IDS`, `CAPABILITY_ID_SET`,
  `isCapabilityId`). Before Wave 3 the list was duplicated in three places
  (allowlist `CapabilityId` union, capabilities `KNOWN_CAPABILITY_IDS`, broker
  `VALID_CAPABILITY_IDS`); they all import the one set now, so a capability can't
  be half-added.
  - **[CORRECTED 2026-08-16 — the original text here was wrong and unsafe.]**
    Wave 3 documented the Rust contract as: *"a capability with backend reach
    needs Rust enforcement; a purely frontend/in-worker one does not — there is
    no enumerated Rust capability list, only the `net.fetch` origin store."*
    That has been false since the capability store gained
    `GRANTABLE_CAPABILITIES` (`app/src-tauri/src/scripting/capability_store.rs`),
    and the code now refutes it verbatim in
    `app/src/api/scriptHost/capabilityIds.ts:29-35`.
    **The real contract is up to THREE entries, not one:**
    1. `ALL_CAPABILITY_IDS` — `app/src/api/scriptHost/capabilityIds.ts`
    2. `RUST_MIRRORED_CAPABILITIES` — `app/src/api/scriptHost/capabilities.ts`
       (only for ids the backend must know about)
    3. `GRANTABLE_CAPABILITIES` — `capability_store.rs` — **otherwise the mirror
       call is REJECTED by the store's own id allowlist.**
    A frontend-only capability needs (1) alone. Skipping (3) for one that is not
    frontend-only is not a theoretical risk: it **already broke `schedule`**,
    which looked approved in the consent UI and was refused by the backend
    forever after. This document was the last surviving copy of the claim the
    code had already fixed and annotated as harmful.
- **`app/src/api/scriptHost/errorMap.ts`** — `brokerErrorToCellError`,
  `brokerErrorReason`, shared by C1 (UDF cell errors) and extensions.

---

## 2. C1 — User-defined formula function evaluation

**Problem:** `formulas.registerFunction(def)` registered a JS implementation but
it was *never invoked* during calc — a formula `=MYFN(A1)` yielded `#NAME?`.

**The binding constraint:** the Rust recalc is **synchronous and runs under a
giant lock bank** (`data.rs`), so it can never call a JS UDF back
mid-evaluation. The resolution is a **pre-fetch**: resolve the UDF results
off-thread *before* the recalc, then let the evaluator serve them.

**Architecture:**

1. **Engine hook (no parser change).** `core/engine/src/evaluator.rs` gained a
   `udf_fn: Option<&dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>>` field +
   `set_udf_fn` setter, mirroring the existing `gather_fn` closure-injection.
   The pre-existing `BuiltinFunction::Custom(name)` arm — after the `__INVOKE__`
   and LET/LAMBDA-scope checks — evaluates the args and tries `udf_fn` before
   falling through to `#NAME?`. (Unknown names were already `Custom`, not a parse
   error, so no parser change was needed.)
2. **Rust pre-fetch (`app/src-tauri/src/scripting/udf.rs`).** `UdfValue` is the
   tagged-union wire type (`{kind:"number"|"text"|"boolean"|"error"|"array"|
   "empty"}`). `collect_udf_calls` is a **read-only** command: it clones the
   grids, applies the pending edit to the scratch copy, scans formula cells that
   textually name a registered UDF, evaluates them with a *collecting* `udf_fn`,
   and returns the `(name, args)` calls (with a stable `udf_key`). `update_cell`
   and `update_cells_batch` gained an optional `udf_results` param that builds a
   serving `udf_fn`; it is threaded into the primary eval site **and** the
   same-sheet dependent cascade (so `B1=MYFN(A1)` recomputes when `A1` changes).
3. **Frontend orchestration (`app/src/api/formulaUdf.ts`).** A collect → resolve
   → apply loop (bounded for nested UDFs): `collect_udf_calls` →
   `resolveUdfCall` (runs the JS impl **through the broker** under a
   `formula.udf`-declared handle, so it is ceiling-checked + audited) → pass the
   resolved table to `update_cell`. It installs into Core's `updateCell` via an
   **IoC hook** (`setUdfResolveHook`) so Core stays `@api`-ignorant. Enabled in
   the FormulaAutocomplete extension's `activate`.

**Security:** UDFs run under a `ScriptHandle` that must declare + be granted
`formula.udf`. Extension-registered UDFs are trusted today; a future
worker-script-defined UDF carries its own restricted handle, so a pulled
`.calp`'s UDFs can't run without package consent.

> **Update (2026-06-24):** the "future worker-script-defined UDF" path is now
> realized as **Custom Functions (JS UDFs)** — user-authored JS formula functions
> that run in a hardened Worker realm under a `restricted` handle and may call
> `cube.*` under `bi.query`. See
> `docs/design/cube-formulas-and-custom-functions.md` §4.

**v1 limits (documented):** cross-sheet UDF-dependent recalc and string-fallback
paths degrade to `#NAME?` until the cell is re-entered (collect discovers them,
but their apply-cascade isn't UDF-served yet); fill-down works (each filled cell
is a primary update).

> **Refinement (2026-06-24):** a full recalc / `calculate_now` (F9, "Calculate
> Workbook", cube refresh) wires **no** UDF resolver, which previously clobbered
> every UDF cell to `#NAME?`. The engine's `Custom(name)` arm now **preserves the
> cell's last value** (`preserved_udf_value`) when no resolver is wired, returning
> `#NAME?` only when a resolver IS wired but does not recognize the name (a genuine
> unknown), mirroring the cube preserve. See the cube/custom-functions design doc
> §4.4.

---

## 3. BI query capabilities

A script may read the workbook's BI data two ways, deliberately split by trust:

### `bi.query` — structured, model-scoped (default)
Runs the engine's one aggregate query core — the same gates a pivot's
`query_with_meta` runs (row- and object-level security, the multi-role union) —
through `engine.query_auto_refresh` with `measures` / `groupBy` / `filters`. Scoped to
the workbook's BI **model**; **no SQL-injection surface** (the script supplies
measures/columns/filter-*values*, not SQL text); **no DB-wide access**. The
executor calls the existing `bi_query` command; the gate parity itself lives in
the engine (changelog entry "One aggregate query path", 2026-09-18).
`cap.biListConnections` (also `bi.query`-gated) returns a **credential-sanitized**
summary (`toBiConnectionSummary` whitelists `id`/`name`/`connectionType`/
`isConnected`/`tableCount`/`measureCount` — never `connectionString`/`server`/
`database`/credentials).

### `bi.sql` — raw read-only SQL (higher trust)
A separate, more-powerful capability: arbitrary `SELECT`/`WITH` against the
connected database, so it can read **any table the connection's credentials
reach**. Enforcement:
- **Engine Lib:** one accessor — `SourceRegistry::connector_by_index`
  (`crates/engine-query/src/registry.rs`); the `Connector` trait's
  `execute_query` was already public.
- **App `script_bi_sql`:** MAIN-window-guarded; **Rust-side read-only
  re-validation** (single `SELECT`/`WITH`, no embedded `;`) as defense in depth;
  connector execute; 100k-row cap.
- Frontend `vBiSql` validates the same before the broker call.

**Containment note (both):** `bi.*` alone only pulls data *into* the workbook
(which the user sees). To send it anywhere a script also needs `net.fetch`,
which is separately consented — so neither is an exfiltration vector on its own.
No per-script Rust grant re-check (parity with `bi.query`; a compromised renderer
already has BI access via the existing commands and can't exfiltrate without the
separately-gated `net.fetch`).

### 2026-07 — the notebook surface joins `bi.query`/`bi.sql`

Notebook cells (Rust QuickJS) gained a read-only `model.*` API carrying the
SAME two capability classes — the first capabilities on that surface (the C3
"no ambient surface to gate" rationale is retired; see
`script-sandbox-architecture.md` §0 update). Enforcement is entirely
server-side (there is no broker hop — the notebook executes in Rust):
`bi/script_provider.rs::HostModelProvider` re-checks the in-memory
`CapabilityStore` grant per call (key `notebook:{id}`; JIT consent mirrors
via `grant_script_capability` — **[CORRECTED 2026-08-16]** this was originally
written as `grant_script_bi`, a command that no longer exists: it was
generalized to `grant_script_capability` because its id check rejected
everything outside `bi.*` (`app/src-tauri/src/net_commands.rs:123`,
`app/src/api/scriptHost/capabilities.ts:172-178`). A reader greping the old
name finds nothing), funnels through the gate-free cores extracted from
the existing commands (`bi_query_core` — RLS inside the engine lock;
`bi_sql_core` — read-only validation + 100k cap), and records success AND
denial into the always-on `CapabilityCall` audit trail with the same
redaction policy. `model.connections()` applies the same credential-sanitized
whitelist as `cap.biListConnections`. Details:
`docs/design/notebook-analysis-workbench.md`.

---

## 4. Extension sandboxing (S8/C7)

Distributed (third-party) extensions used to load from `%APPDATA%/extensions`
with the **identical full authority** as built-ins, silently. Closed in layers.

### Phase A — governance (main thread)
- **Trust classification:** built-ins = `trusted`; third-party = `distributed`
  (`extensionTrust.ts`, `ExtensionManager`).
- **Declared-capability ceiling** with **deny-by-default**
  (`computeExtensionCeiling`); `ExtensionManifest` gained `capabilities?` +
  `workerSupport?`.
- **Transparency:** distributed extensions register a broker `ScriptHandle` and
  appear in the transparency panel with their declared ceiling.
- Network exfiltration via browser `fetch` is **already** contained app-wide by
  the locked CSP `connect-src` (`'self' ipc: http://ipc.localhost`); the only
  egress is the Rust-gated `script_http_fetch`.

### Phase B — worker-realm isolation
A distributed extension that declares `workerSupport: true` runs **sandboxed in a
hardened worker** with **no ambient DOM / Tauri / network** authority. The bundle
is imported **inside the worker** (never on the main thread); every privileged
effect is broker-mediated and ceiling-checked, exactly like an object script.

- **`worker/workerHardening.ts`** — the single source of truth for neutered
  globals (`NEUTERED_GLOBALS`) + capped timers, shared with the object-script
  `bootstrap.ts` so the two realms can't drift.
- **`extensionProtocol.ts`** — host↔worker envelopes. **Registrations**
  (commands, event subscriptions, menu items) keep their handler in the worker;
  the host installs a proxy that RPCs back. **Capabilities + side effects** route
  through the broker.
- **`worker/extensionWorkerContext.ts`** — the worker-side ExtensionContext:
  `commands`, `events`, `ui.notifications`, `ui.menus`, `capabilities`
  (`fetch`/`storage`/`biQuery`/`biSql`/`listBiConnections`). React-component
  surfaces (ribbon tabs, panels, dialogs, custom cell editors) and synchronous
  grid hooks **throw a clear error** — they can't cross a worker boundary; an
  extension needing them omits `workerSupport` and runs on the main thread (Phase
  A governance).
- **`extensionWorkerHost.ts`** — spawn, authoritative ceiling + handle, host-side
  command/menu/event proxies, broker routing with JIT consent, per-extension
  storage, lifecycle.
- New restricted allowlist methods: `ext.notify` / `ext.log` /
  `ext.executeCommand` / `ext.emitEvent`.

### Signed sidecar manifests
So the host can read `workerSupport` + the ceiling **without executing the
bundle** (fixing the throwaway-worker double-import) AND with verified
provenance:
- `scan_extension_directory` (Rust) reads a sidecar `<base>.manifest.json` +
  detached `<base>.manifest.sig` (directory extensions: `extension.manifest.*`)
  and verifies via the calp Ed25519 + TOFU store (keyed `ext:<id>`), returning
  `trustStatus` ∈ `unsigned` | `invalid` | `publisherChanged` | `firstUse` |
  `verified`.
- `ExtensionManager.loadExtension` routes by the authoritative manifest; the
  declared ceiling is honored **only** for `verified`/`firstUse` (else
  deny-by-default empty). `mountWorkerExtension` takes an `authoritative` param
  that overrides the worker-reported ceiling and **rejects** a bundle whose id
  disagrees with the signed manifest.

### Worker-extension menus
`MenuRegistry.removeMenuItem` + `unregisterMenuItem`; the worker
`ui.menus.registerMenuItem` is data-driven; the host installs a real menu item
(namespaced `ext:<id>:<item>`) whose click runs the extension's command or RPCs
its worker `onClick` handler — torn down on unmount.

---

## 5. Script-surface taxonomy & unified governance (C3)

The app runs user/extension code through several surfaces. They are deliberately
**not** executed by one engine — governance is unified (one capability
vocabulary, one consent/provenance model, one transparency story), but execution
is heterogeneous because the surfaces have different needs. The single queryable
source of truth is **`app/src/api/scriptSurfaces.ts`** (kept in lockstep by a
test):

**[CORRECTED 2026-08-16.]** The table below is the **Wave-3-era** taxonomy: six
surfaces, and two of its rows were wrong even then in the dangerous direction.
The live taxonomy is **eleven** surfaces. The corrected table is first; the
original follows, kept because §5's *rationale* (why notebooks stay on QuickJS)
is still the reason the split exists.

**Live taxonomy (11 surfaces, `app/src/api/scriptSurfaces.ts`, verified
2026-08-16).** Capability columns are the surface *ceiling* — what an
author-declared R19 ceiling may contain — not what any given script holds:

| Surface (`id`) | Runtime | Capabilities | Runs user code? |
|---|---|---|---|
| `object-script` | Per-script worker realm | full broker vocabulary | yes |
| `script-library` | Its OWN worker realm, per library | `declared(library) INTERSECT declared(consumer)` | yes |
| `extension-worker` | Worker realm | 11 ids incl. `grid.read` | yes |
| `formula-udf` | The owning script's worker realm | full broker vocabulary | yes |
| `notebook-cell` | Rust QuickJS (persistent) | **`bi.query`, `bi.sql`** | yes |
| `one-off-script` | Rust QuickJS (ephemeral) | none | yes |
| `chart-transform` | Main thread, pure pipeline | n/a | **no** (declarative) |
| `chart-transform-sandbox` | Worker realm | full broker vocabulary | yes |
| `chart-mark` | Worker realm | `ui.html` | yes |
| `writeback-validator` | Rust QuickJS (host globals deleted) | none | yes |
| `mcp-tool` | Rust QuickJS | **`bi.query`** | **yes** |

Two corrections in that table are the whole reason this note exists:

- **`mcp-tool` — the original row below says "Not a user-scripting surface",
  capabilities "n/a". Both are false.** `execute_script` runs
  **agent-authored** code with a `HostModelProvider` injected and a hard-coded
  `MCP_SCRIPT_CAPABILITIES = ["bi.query"]` grant
  (`app/src-tauri/src/mcp/tools.rs:1085, 1206, 1220`).
  `core/script-engine/src/manifest.rs:343-352` records this as
  `CORRECTED 2026-08-02` and says explicitly that *"every mirror repeated
  'grid-only'. Both were false."* **This document was one of those mirrors and
  was never corrected until now.** `bi.sql` is deliberately withheld there
  (`manifest.rs:358-363`).
- **`notebook-cell` — "none (no ambient surface)" contradicted this document's
  own §3** ("the notebook surface joins `bi.query`/`bi.sql`", 2026-07). Code:
  `scriptSurfaces.ts:253` and the `notebook-cell` `SURFACE_PROFILES` row
  (`manifest.rs:329-337`), `granted: ["bi.query", "bi.sql"]`.

Also new since Wave 3: `script-library`, `chart-transform-sandbox` and
`chart-mark`. Chart transforms are consequently **no longer only** the
non-executing declarative pipeline the last row describes — the sandboxed
variant is a full worker realm with an author-declared ceiling.

<details>
<summary>Original Wave-3 table (2026-06-14) — superseded, kept for the record</summary>

| Surface | Runtime | Containment | Capabilities | Gate |
|---|---|---|---|---|
| Object scripts | Per-script Web Worker | Hardened; no DOM/Tauri; broker-mediated | `net.fetch`, `bi.query`, `bi.sql`, `storage`, `ui.html`, `formula.udf` | Tier broker + per-package consent |
| Formula UDFs | The owning script's worker realm | Same; pre-fetched before the sync recalc | `formula.udf` | Broker (declared + granted) |
| Notebook cells | Rust QuickJS (persistent) | Isolated interpreter over CLONED grid state; grid-only, no net/fs/Tauri | none (no ambient surface) | Coarse session approval |
| One-off scripts | Rust QuickJS (ephemeral) | Same isolation, grid-only | none | Coarse session approval |
| Chart transforms | Main thread, pure pipeline | `evalArithmetic` (recursive-descent; no `eval`/`new Function`) — NOT an execution surface | n/a | n/a (pure declarative) |
| MCP tools | Rust (first-party tool bodies) | Not a user-scripting surface | n/a | Window-label guard |

</details>

**Why notebooks/one-off stay on Rust QuickJS, not the worker realm:** (1) they
are already well-contained — an isolated interpreter over a *clone* of grid state
with no network/filesystem/Tauri reach (worst case: mutate the grid, undoable);
a capability ceiling would gate nothing. (2) The worker realm compiles user code
as blob-ESM under a no-`unsafe-eval` CSP and cannot `eval` arbitrary incremental
cell strings with shared mutable scope — the notebook REPL model fundamentally
needs an interpreter (QuickJS, outside the browser CSP). So the correct
unification is **governance convergence**, not execution relocation. The original
"notebook-as-worker" idea is recorded as **not pursued** for these reasons.

---

## 6. Command return values

`CommandRegistry.execute` now **returns the handler's result** (`CommandHandler` +
`ICommandRegistry.execute`/`register` widened `void` → `unknown`,
backward-compatible). The worker-extension command proxy returns the worker
handler's result, and the `ext.executeCommand` / `api.executeCommand` executors
return the command's value — so a worker command's return value flows back
through the host to the `execute()` caller (or a script calling `executeCommand`).

---

## 7. Key files

**Created:** `scriptHost/capabilityIds.ts`, `scriptHost/errorMap.ts`,
`scriptHost/biQuerySupport.ts`, `scriptHost/extensionProtocol.ts`,
`scriptHost/extensionWorkerHost.ts`, `scriptHost/worker/workerHardening.ts`,
`scriptHost/worker/extensionWorkerContext.ts`,
`scriptHost/worker/extensionBootstrap.ts`, `api/formulaUdf.ts`,
`api/scriptSurfaces.ts`, `shell/registries/extensionTrust.ts`,
`src-tauri/src/scripting/udf.rs`.

**Added 2026-09-30 / 2026-10-01 (§11, owner decision B):**
`app/src/api/explicitMacroRun.ts` (the one-time pass a person's door mints),
`app/src/api/scriptHost/explicitRunGrant.ts` (the closed table of cell rows,
its refusal sentences, and the pre-flight scan),
`app/extensions/_shared/lib/buttonClickDoor.ts` (the click's one answer
dispatcher and the `ButtonGesturePass` a gesture hands down),
`app/src-tauri/src/scripting/explicit_run_audit.rs` (the grant ledger, the
write report and the pre-flight refusal row), and the undo savepoint doors in
`app/src-tauri/src/undo_commands.rs` (`begin_undo_savepoint`,
`roll_back_to_undo_savepoint`: a granted run that fails is taken back whole).

**Added 2026-09-30 / 2026-10-01 (§9, BUG-0257 phases 4-5):**
`app/src-tauri/src/consent_seal.rs` (approvals sealed to this computer, the one
writer and the verified reader), `app/src-tauri/src/scripting/control_action.rs`
(the button door `run_control_action`, its pure planners, and
`authorize_button_command`), `app/extensions/CellTypes/lib/buttonCommandRun.ts`
(the page's half of an application's button command), and
`core/calp/src/code_summary.rs` (the promotion code summary).

**Changed (TS):** `scriptHost/allowlist.ts`, `validators.ts`, `capabilities.ts`,
`broker.ts`, `host.ts`, `worker/bootstrap.ts`, `worker/contextShims.ts`,
`scriptHost/index.ts`, `api/commands.ts`, `api/contract.ts`, `api/ui.ts`,
`api/formulaFunctions.ts`, `core/lib/tauri-api.ts`,
`shell/registries/ExtensionManager.ts`, `extensions/.../ScriptConsentDialog.tsx`,
`extensions/ScriptableObjects/index.ts`,
`extensions/BuiltIn/FormulaAutocomplete/index.ts`.

**Changed (Rust):** `core/engine/src/evaluator.rs`, `src-tauri/src/lib.rs`
(UDF eval helpers + `scan_extension_directory` signing),
`src-tauri/src/commands/data.rs`, `src-tauri/src/bi/commands.rs`
(`script_bi_sql`); Engine Lib `crates/engine-query/src/registry.rs`
(`connector_by_index`).

---

## 8. Verification

- **Rust:** `cargo check` clean; engine `cargo test udf` (4); app
  `cargo test --lib udf` (13) + `ext_manifest` signing tests (4).
- **TS:** typecheck clean; **full unit suite 101,855 pass as of 2026-06-14**
  (this is a dated wave snapshot, not a current number — the suite stands at
  ~107,155 across 808 files as of 2026-08-16) (incl. new
  `capabilityIds`, `formulaUdf`, `extensionTrust`, `scriptSurfaces`,
  `extensionProtocol`, `biQuery`, `commands` tests).
- **e2e (Playwright/WebView2):** `udf-evaluation` (2), `worker-extension` (1),
  `worker-extension-biquery` (1), `worker-extension-followups` (4: menus,
  authoritative manifest + id mismatch, command return value, `bi.sql` wiring).

---

## 9. Remaining / future (none blocking)

- **Audit trail across the Rust QuickJS surfaces (DONE).** notebook cells,
  one-off `run_script`, and MCP `execute_script` record an always-on, structured
  `ScriptExecuted` entry (surface kind + id + sheet + cell count + mutated range
  for the diffed path) into the per-workbook audit log, surfaced as a "Scripts"
  category in the viewer. Always-on = recorded even when the opt-in distribution
  audit log is disabled (the Transparency pillar requires script grid mutations
  visible by default).
- **Capability-call audit (DONE — the "one transparency story").** Capability use
  also persists now (`AuditEvent::CapabilityCall`, always-on): `net.fetch` /
  `bi.query` / `bi.sql` record authoritatively server-side in their Rust gates
  (origin / SQL-prefix only — no PII), and the rest (storage / ui.html /
  formula.udf + broker-side policy denials) write through from the broker ring via
  the `audit_record_capability` command, deduped so backend-reaching caps aren't
  recorded twice. Surfaced as a "Capabilities" category. The in-memory broker ring
  stays the live panel feed; the persisted log is the system of record across
  reload. ~~Residual: `codeInventory`'s grid-only "reach=[]" is asserted by
  surface taxonomy, not verified against the QuickJS host.~~
  **[RESOLVED 2026-08-16 — verified closed by this audit.]** The reach is now
  *derived* and drift-guarded, not asserted. `core/script-engine/src/manifest.rs`
  provides `enumerate_registered_surface()` (:523) — the live op list from the
  interpreter itself — plus `OP_MANIFEST` (:130) classifying every path into a
  `ReachClass`, `SURFACE_PROFILES` (:325) recording how each host surface builds
  the realm, and `surface_reach()` (:402) / `surface_capability_ids()` (:412)
  computing reach per surface. The manifest is diffed against the live
  interpreter **in both directions** by
  `op_manifest_matches_the_live_interpreter_surface` (:668) — a new op the
  manifest does not admit fails the build, and so does a stale row the
  interpreter no longer registers — and mirrored to the TS taxonomy by
  `interpreterReachDrift.test.ts`. The sibling
  `script-sandbox-architecture.md` §14.7 had already recorded this as resolved;
  this document had not, which is the drift this audit was looking for.
- **Application code run gate (DONE — BUG-0257 phase 3, 2026-09-30).** The two
  Rust doors every run of an application's (distributed) code passes --
  `run_script` for the module runtime and `check_distributed_mount_consent` for
  worker-realm mounts -- now share one gate,
  `app/src-tauri/src/scripting/application_code_gate.rs`. It asks, in order:
  the hash-keyed consent, unchanged (`distributed_module_refusal` /
  `distributed_mount_refusal`, the same refusal text); the working-copy
  private-sheet rule (`APPLICATION_CODE_BESIDE_PRIVATE_SHEETS` -- in a workbook
  holding a working-copy link, the module runtime and the `object-script` and
  `lib` mount surfaces refuse while any sheet outside the application's holds a
  cell; every other consent surface is listed exempt with its reason, and a
  census makes a new surface choose); and, when a button asked, the `trigger`
  (`RunScriptRequest.trigger` / the mount's `trigger`, `{kind:
  buttonControl|buttonCell, sheetIndex, row, col}`), verified against the
  control or cell-type store (`APPLICATION_CODE_TRIGGER_MISMATCH`; a claim can
  only narrow what runs). Two new always-on events, `ApplicationCodeRun` and
  `ApplicationCodeRefused` (`notConsented` / `privateSheets` /
  `triggerMismatch`), name the application, the macro and -- when storage backs
  the click -- the button, and show in the audit viewer. `run_script` records
  every run and refusal of distributed code; a mount records them when a button
  asked, and otherwise only a private-sheet refusal (standing chart and
  function mounts would drown the trail). Local and ad-hoc code is neither
  gated nor recorded here. The renderer-side half is `runMacroByRef`'s
  `requirePackage`: a held button link runs only its own application's macro
  (the confused-deputy guard). Residual: the renderer can OMIT the trigger --
  the run is still gated and audited, without the button. Since phase 4 inline
  button code and button cells go through the Rust button door instead, which
  reads the button from its own store (below); a macro LINK keeps this route,
  so for links the residual stands. Design: `calp-workspace-collaboration.md`
  §3 invariants 14 and 15.
- **Approvals sealed to this computer (DONE — BUG-0257 phase 4's
  prerequisite, 2026-09-30).** An approval is a record in the workbook's
  `.calcula/script-consent.json`, which travels inside the `.cala` with the code
  it approves, so a handed-over workbook could carry its own pre-approval. Each
  record is now sealed (HMAC-SHA256 over its canonical bytes) under a 32-byte key
  that exists only on this computer, in Windows Credential Manager
  (`Calcula:consent-seal`, per Windows user -- never in a workbook, never in a
  file the page can read), and every Rust gate that asks an approval -- the run
  gate, the mount door, notebooks, writeback validators, the button door --
  reads only the VERIFIED view (`consent_seal::verified_view`): records this
  computer sealed whose every field still matches. Unsealed, other-computer and
  altered records count for nothing and are reported (Code in This File names
  them by application and reason, never by key). Only `record_script_consent`
  writes (main window, denylisted), computing every hash from the code itself;
  the virtual-file doors refuse to create or rename the consent file. It guards
  a HANDED-OVER file, not a compromised renderer, which could call the writer
  as the approval screen does. No "reset approvals on this computer" yet.
  Design: `calp-workspace-collaboration.md` §3 invariant 17.
- **The button door (DONE — BUG-0257 phase 4, 2026-10-01).** Every click of a
  floating button, an in-cell button control and a button cell goes through
  `run_control_action` (`app/src-tauri/src/scripting/control_action.rs`, main
  window, denylisted). The page names the BUTTON, never code; Rust reads the code
  from its own store, asks the approval of its exact bytes (an application's
  inline code: `buttonAction:<sha256>` in its record; a `Name()` call or a cell's
  script action: that module's approval), the working-copy private-sheet rule
  and Script Security, records every run and refusal (surface `button`;
  `startedBy` and `door` since the M6b review), and runs it in the interpreter.
  The page-composed routes are deleted. A held `Name()` reaches only its own
  application's modules; a macro LINK still answers `link` and runs through the
  phase-3 route above. Who may call the door at all is pinned by a census
  (`explicitMacroRun.test.ts`, "only the three button gestures reach the button
  door"), because Rust cannot ask who clicked. **The backstop:** held code run
  from anywhere but its button -- an ad-hoc `run_script`, a notebook cell of the
  user's own, a floor-only mount, an AI or MCP script -- is refused and recorded
  (`APPLICATION_CODE_OUTSIDE_ITS_BUTTON`, reason `heldCodeOutsideButton`): an
  exact match at any length; inside a longer program only held code of 40+
  characters over 2+ lines; never code one of the user's own modules carries.
  "Make this my own" (`controls::adopt_held_button_code`, denylisted) moves held
  code into the user's slot only as the confirm showed it, undoably, always
  audited (`ButtonCodeAdopted`). Design: invariants 16 and 18.
- **An application's button-cell COMMAND (DONE in code — BUG-0257 phase 5,
  M8, 2026-10-01; live proof pending).** A button cell from an application may
  run a Calcula command only when the command is on Rust's list
  (`button_cells::DISTRIBUTABLE_BUTTON_COMMANDS`, EMPTY by owner decision, so
  none does today), its live registration opts in (`distributableTrigger`, not
  shadowed, enabled) and the person approved it under its own key
  `button-commands:<application>` -- never the application's bare record, which
  is the object-script mount floor's key. The door asks
  `application_code_gate::button_command_gate`: the list, the approval, the
  private-sheet rule; every refusal is an always-on `ApplicationCodeRefused`
  row with surface `buttonCommand`, the `commandId` and the button, reason
  `notAllowlisted`, `notConsented`, `privateSheets` or `stateUnavailable`, and
  no run row is written yet. The page checks the live registration, then asks
  `authorize_button_command` (main window, denylisted), which refuses a claim
  the stored cell does not back (`triggerMismatch`, with `claimedTrigger`), asks
  the gate again and writes the `ApplicationCodeRun` row; only then does the
  command run. It makes an honest click listed, approved and audited; it does
  not stop a compromised renderer, which can execute commands directly. An
  application's command is answered whatever the Script Security level, like
  the user's own commands (a test pins it). Design: invariant 9.
- **The promotion preview shows the code (DONE in code — M8, 2026-10-01; live
  proof pending).** The transparency rule says the user must know what code
  reaches them; the promoter decides that for a whole environment. The Promote
  dialog now lists, before the cell diff and on a first promotion too, every
  piece of code that changes for that environment's subscribers and what each
  means for them (asks for approval again, stops running, never runs, refuses
  the version ...), read through the authorised and verified readers with every
  artifact checked against its signed checksum (`core/calp/src/code_summary.rs`).
  Not yet in the Inspector's Compare or the push preview. The version diff's own
  "gains / loses <capability>" note reads the signed manifests since BUG-0274
  (fixed 2026-10-02). Design: invariant 19.
- **Script Security gate over the object-script surface (DONE — B1).** The global
  setting (disabled/prompt/enabled) now governs the object-script surface at its
  single mount chokepoint, `ObjectScriptManager.mountScript` (`@api/scriptableObjects`),
  via `ensureScriptsAllowed` (`@api/scriptSecurity`). Previously only the primary
  workbook-load path consulted it; the other mount paths — cross-window
  save-and-apply, the manual toggle in the Object Scripts pane, code-editor remount,
  and component/shape template stamping — all funnel through the chokepoint, so
  "disabled" blocks every one and "prompt" asks once per session before any object
  script runs. The workbook-load path keeps its batch gate (nicer UX + avoids N
  no-op mount attempts when disabled); the chokepoint gate is a quiet no-op there
  after the session grant. (`objectScriptMountGate.test.ts`.)
- **Script Security gate over ALL worker-realm surfaces (DONE — the master switch).**
  The setting now governs *every* user-authored Worker mount, not just object
  scripts. `hostMountScript` (`@api/scriptHost/host`) — the universal mount
  chokepoint for object scripts, custom **chart marks**, custom **chart transforms**,
  and JS **UDF libraries** — calls `assertMountAllowed` (`@api/scriptHost/mountGate`,
  a light module over `ensureScriptsAllowed`, extracted so the gate is unit-testable
  without host.ts's worker/render graph) BEFORE spawning any worker. "disabled" now
  means "no custom code at all"; "prompt" asks once per session (the session grant
  is cached, so an N-mark install batch yields one confirm; all surfaces share the
  grant). On a declined/disabled mount it throws `ScriptSecurityBlockedError` before
  the worker spawns and callers degrade gracefully — chart marks/transforms roll
  back to the previously-installed library (the chart falls back to its built-in
  painter) and a blocked UDF library isn't registered, so `=MYFUNC()` shows `#NAME?`.
  The crash-respawn path calls the internal `mountWorker` directly (already-consented
  code recovering from a crash must not re-gate or re-prompt). Object scripts keep
  their own earlier gates (load-time batch + `ObjectScriptManager.mountScript`), so
  they reach the host already-allowed with an object-specific prompt; the host gate
  is the universal floor behind them. (`mountGate.test.ts`.) Note: script
  *validation* (`hostValidateScript`, a compile-only blob wrap that executes nothing)
  is intentionally NOT gated, so a user can still edit/validate code while the
  setting is "disabled". Minor wart: re-installing a chart/UDF library from its
  authoring dialog while in unconfirmed "prompt" mode and *declining* re-prompts once
  during rollback (no prior-good library exists at workbook open, so the common path
  is unaffected).
- **Script Security lockdown over distributed extensions (DONE — the second worker
  chokepoint).** An adversarial review of the change above found that installed
  3rd-party extensions run arbitrary JS in a SEPARATE worker realm
  (`extensionWorkerHost`), reached via `ExtensionManager.loadExtension`, NOT through
  `hostMountScript` — so the master switch did not cover them. Closed: `loadExtension`
  (the single chokepoint every extension mount funnels through, including the
  manager's "Allow"-button re-entry via `grantConsentAndActivate`) now checks
  `getScriptExecutionStatus`; when "disabled" it blocks the mount and LISTS the
  extension via `recordBlockedExtension` (visible + reasoned in the manager) instead
  of importing its bundle. "prompt"/"enabled" deliberately fall through to the
  extension's OWN signing-trust (B2) + per-extension consent (B3), which already ask
  before first run — so there is no double-prompt and no app-startup hang from a
  master-switch confirm (only a non-throwing status check runs in the scan path).
  With both chokepoints gated, "disabled" is now a true lockdown: no worker-realm
  custom code (object scripts, chart marks/transforms, UDFs, OR distributed
  extensions) runs anywhere. (Behavioral coverage belongs in
  `e2e/tests/extension-consent.spec.ts`; the gate decision itself is covered by
  `scriptSecurity.test.ts`.)
- **UDF coverage:** cross-sheet UDF-dependent recalc + string-fallback paths
  (today degrade to `#NAME?` until re-entered).
- **Extension signing pipeline:** the *verification* + sidecar format ship now;
  a first-party tool to *produce* signed extension packages is future.

---

## 10. Defects found in this model AFTER it was declared complete

**Added 2026-08-16.** Wave 3 closed on 2026-06-14 declaring the scripting
security model complete, and everything above is written in that voice. Two real
holes were found in it later. Both are fixed, and both are recorded here because
a security document that describes a model as complete, and never mentions the
defects subsequently found in it, teaches the next reader to trust the model
further than the evidence supports. The ledger entries are the primary record
(`tests/regression/bug-ledger.json`).

### The standing rule this model did not originally state

> **A script may REFERENCE media already in the document; it may never
> INTRODUCE bytes.**

This is now a property of the code, not a paragraph. `shape.setProperty`'s `src`
slot accepts a `media:{sha256}` handle or `""` and refuses a `data:` URI, a file
path and a URL alike (`app/src/api/scriptHost/validators.ts:4072-4086`, with
`MEDIA_REF_RE` at :3937 deliberately mirroring Rust's `parse_media_ref`).
`vCreatePicture` (:4116) has **no bytes parameter at all**. Bytes enter only
through the picker, validated host-side by `inspect_media` behind
`cap.fileImportMedia` / `file.picker`.

Note the structural trap that made this reachable, because it is still live for
the next aspect anyone adds: `vSetState` in `validators.ts` ends in
`return true`, so **a new `object.setState` aspect with no matching row defaults
to unvalidated at restricted tier with no capability.** That default is exactly
how `shape.setProperty` became a route for a distributed script to persist a
multi-megabyte `data:` URI into a signed `.calp`.

### BUG-0086 — a refused image was still delivered to the decoder (fixed)

`MAX_MEDIA_PIXELS`, the decompression-bomb defence and the entire reason the
image header is parsed, **protected nothing on the inline path.** Both
migrations (`migrate_legacy_data_urls` for `.cala`, `rewrite_inline_images` for
`.calp`) decoded each payload, ran `inspect_media`, and on ANY error counted it
`refused` and **left the string exactly where it was.** That tolerance was
designed for FORMAT refusals — an SVG the old picker accepted must not be
destroyed by a later, narrower allowlist — and was wrongly applied to CAP
refusals too. A 30,000 x 30,000 single-colour PNG (a few KB on the wire,
3.6 GB of RGBA at decode) was refused entry to the media store, kept its place
in the control property, materialized into the subscriber's `controls.json`, and
was handed to the WebView as `<img src="data:...">` — the one component with no
caps at all.

**The lesson worth more than the fix:** the existing test named this exact case
and passed. `a_correctly_signed_decompression_bomb_inline_is_refused_not_admitted`
asserted only `bytes.is_empty()` — the store was clean and the renderer still got
the bomb. A test that asserts the *guard ran* is not a test that asserts the
*payload did not arrive*.

### BUG-0092 — an imported file chose the privilege tier of the code it installed (fixed)

`importTemplate` was `JSON.parse(json) as ObjectTemplate` — a **cast, which
validates nothing** — and the parsed object was persisted verbatim,
`accessLevel` included. That field is load-bearing: `stampFromTemplate` copies it
onto the stamped definition and `buildHandleFromDefinition`
(`app/src/api/scriptHost/broker.ts:85-97`) turns `accessLevel === "unlocked"`
into `tier: "unlocked"` — in allowlist terms whole-workbook reach
(`getCellValue`, `setCellValue`, `updateCellsBatch` over 100,000 cells,
`executeCommand`). Object scripts run on their object's events, so no further
gesture was needed to execute it. Worse, the import carried no `provenance`, so
`isDistributed` was false and the script landed in the **most** trusted bucket
rather than the consent-gated distributed one.

Fixed in `app/extensions/ScriptableObjects/lib/templateManager.ts:209-263`,
which is now a field-by-field validator: garbage is refused with
`TemplateImportError`, the id is a fresh `crypto.randomUUID()` *"so an imported
file cannot choose the identity that a capability grant or a source hash is keyed
to"*, and `accessLevel` is hard-coded `"restricted"` under the comment
**"NEVER `raw.accessLevel`."** Pinned by
`app/extensions/ScriptableObjects/__tests__/templateImportTier.test.ts`.

The user-facing framing is the part to carry forward: the dialog invited the user
to "import a `.calcula-template` file", so the user believed they were choosing a
**document** and were in fact choosing **executable code and the privilege level
it runs at**. See `scriptable-objects.md` §3, which is where that framing lived.

---

## 11. Explicit-run cell access for application macros (owner decision B, 2026-09-30)

**Status (2026-10-01).** Built through every door the owner named, unit-proven
end to end, and recorded on the persistent trail; every follow-up the decision
raised (F1-F15) is closed in code. What is still owed before the owner item can
be called done is the LIVE run of the journey (11.12): everything below is
proven by unit and Rust tests and by type-checked journey steps, not yet by a
launched app.

**The rule this section amends.** Code that arrives inside an application runs
at the RESTRICTED tier and reaches a capability only through that application's
consent record, never through the local just-in-time prompt
(`accessLevelForOrigin`, `app/src/api/scriptHost/scriptOrigin.ts`;
`runObjectScriptOnce` refuses a caller that asks for `"unlocked"` on such code).
That rule still holds, without exception, for the TIER. The owner added one
narrow grant beside it:

> "An APPROVED application macro that the user runs EXPLICITLY -- a button
> click, Developer > Macros > Run, the command line -- gets the same CELL access
> in either runtime (the module runtime, Calcula.setCellValue, already has it
> after approval). Standing object scripts, and any run a script starts on its
> own, stay restricted."

and, for a run that fails part-way (follow-up F9, the recommendation the owner
approved): it is UNDONE as one step -- all or nothing, like the module runtime --
and the user is told it stopped and that nothing was changed.

**Why.** The Macro Recorder saves macros in the object-script style
(`context.api.setCellValue`). At the restricted tier `context.api` is null, so a
recorded macro shipped in an application could not change a single cell for the
people it was shared with, while the same macro written for the module runtime
(`Calcula.setCellValue`) could after approval. Which of the two a macro was
written in -- a setting nobody sees -- decided whether a shared button worked.
The grant removes that difference for the runs a person starts and for nothing
else. It grants no new power: an approved module macro already had this access.

### 11.1 Which doors carry it

A door carries a person's one-time PASS (11.2) or it does not. Every door the
owner named carries one:

| Door | Pass | Where it is minted, and the route it takes |
|---|---|---|
| Developer > Macros > Run | `"macrosDialog"` | `MacroLibraryDialog.tsx` `run` -> `runMacroModule` -> `runObjectScriptOnce` |
| A floating button control linked to the macro | `"button"` | `Controls/index.ts` `handleButtonPress` (the release inside a pressed run-mode button) hands down a `ButtonGesturePass` (`_shared/lib/buttonClickDoor.ts`) through `Controls/lib/controlClick.ts` to `applicationMacroLink.ts` `runButtonMacroLink`, which calls it ONCE, right before `runMacroByRef`, beside the `buttonControl` trigger |
| An in-cell button control linked to the macro | `"button"` | `Controls/Button/interceptors.ts` `buttonClickInterceptor`, then the same route |
| A button CELL whose action names the macro | `"button"` | `CellTypes/types/button.ts` `buttonCellType.onClick`; the Rust button door answers `macro` (`ControlActionOutcome::Macro`, `scripting/control_action.rs`), and `runCellMacro` runs it through the macro seam with the `buttonCell` trigger (follow-up F6) |
| The command line (`run <macro>`) | `"commandLine"` | `CommandLine/cli/appWriters.ts` `runMacro`, AFTER the resolution gates and the "whose code this is" notice, for the line the person typed; `appGateway.ts` only forwards it (follow-up F2) |

Every click first goes through the Rust button door (`run_control_action`): the
page names the button, never code, and the door decides what a click may run.
Only when the door answers `link` (a control's macro link) or `macro` (a button
cell's object-script macro) does the route mint -- and only through the closure
the GESTURE handler handed down, so any other caller of the shared click
(`clickButtonControl` with no gesture) runs the same macro restricted.

Two related doors, outside the object-script grant:

- **A view bookmark** runs its script in the workbook script runtime only
  (`BuiltIn/CellBookmarks/index.ts`, `runWorkbookScript`). An application's
  module macro runs there when YOU activated the bookmark (the list, or the
  `bookmarks.activateView` command, which is not `scriptSafe`) and is refused
  when a script activated it (11.9).
- **The Object Script Editor's Run and Debug** mount the stored bytes with no
  pass (`hostStartModuleScriptDebugSession`): restricted, `context.api` null.
  The editor's tier chip says so, and says what a run you start gets instead
  (`ObjectScriptEditorApp.tsx` `macroTierChipTitle`, follow-up F5).

### 11.2 The pass: how a run is known to be a person's

`app/src/api/explicitMacroRun.ts`. The door the person used mints a pass:
`mintExplicitMacroRun(door, macroId)`, door one of `"macrosDialog" | "button" |
"commandLine"`. A pass is a frozen live object recognised **by identity** in a
module-private `WeakMap`; `claimExplicitMacroRun` reads the door and the macro id
from that record, never from the object handed in. It is **single use** (spent
by the first claim, whatever happens next) and **bound to one macro id**.

Nothing a script produces can be a pass. Everything a realm sends reaches the
host as a COPY -- `postMessage` is a structured clone, an event detail is data,
JSON is text -- and a copy is never the minted object. On top of that the
script's own door forwards nothing: the dispatcher's `case "api.runMacro"`
(host.ts) passes the reference alone to `executeRunMacro`, which calls the
provider with the resolved id alone, so whatever extra arguments a realm sends
never reach the macro-run seam. The seam (`MacroRunOptions.explicitRun`), the
Macro Recorder's provider (`runMacroByRef`, `runMacroModule`) and the one-off
runner FORWARD a pass and never create one; every path that runs nothing spends
it unused.

**Where a pass is minted is the proof.** For the button door the Rust gate
verifies that a button running that macro sits at that cell, not that anyone
clicked it. So the pass is minted in the pointer GESTURE handlers themselves --
never in a shared helper a future script-reachable "press this button" path
could inherit -- and a census pins both the mint sites and who can reach them
(`app/src/api/__tests__/explicitMacroRun.test.ts`):

- the six files that may name `mintExplicitMacroRun` (the five doors above and
  the pass module), counted by IDENTIFIER -- an aliased import or a reference is
  a mint site too -- with every opaque reach of the module (namespace import,
  star re-export, dynamic `import()`) refused;
- each gesture file minting EXACTLY once, a `"button"` pass, INSIDE its handler;
- who reaches each handler: `floatingObject:bodyDragStart` is raised in
  production only by Core's `overlayMoveHandlers.ts`; `buttonClickInterceptor`
  only as a registered cell click interceptor, called only by Core's
  `useSpreadsheetSelection.ts` mouse-down; a button cell's `onClick` only from
  `src/api/cellTypes.ts`;
- the command line's chain: the mint once inside `runMacro`, after its refusals
  and its notice; `runMacro` has one caller; `createAppDomain` is hosted only by
  `AppCliPanel` (nothing replays a `run` line on its own);
- the two places a pass is CLAIMED: `host.ts` (the mount) and
  `workbookScripts.ts` (the module runtime, 11.9);
- that no script-facing module imports a gesture route;
- **who reaches the button door itself** (review of M6b). The Rust door
  (`run_control_action`) RUNS an application's approved held inline code, and a
  button cell's module-runtime macro, with the module runtime's full reach --
  and it cannot ask who clicked. So its callers are pinned like the mint: the
  shared click `clickButtonThroughDoor` is named only by `controlClick.ts`,
  `CellTypes/types/button.ts` and itself; the wire call `runControlAction` only by
  the shared click and `workbookScripts.ts`; the command name only by
  `workbookScripts.ts` and the facade denylist -- each by identifier, so an
  aliased caller counts, and each call inside the route the gesture census pins.

### 11.3 Where it is decided -- by the page AND by Rust

In `admitMount` (`app/src/api/scriptHost/host.ts`), the one place a realm is
admitted:

1. The pass is **claimed first**, before any gate, so a refused run cannot be
   retried with it.
2. The page's half, `explicitRunCellsFor`, holds only when ALL of these do: a
   live pass was claimed; the mount is an explicit run (`consentRun`); the code
   came in an application; it runs `restricted`; it has the one-off runner's
   shape (surface `object-script`, a `workbook` context, no instance -- never a
   standing object's realm); there is exactly ONE consented artifact, its id the
   pass's macro and its source the very source this realm runs; and the door
   agrees with the trigger (the button door needs a `buttonControl` or
   `buttonCell` trigger; every other door needs none).
3. Only when that holds is the Rust mount gate SHOWN the claim
   (`ExplicitRunClaim { door, macroId }`, `scripting/types.rs`) -- so Rust is
   never asked for a grant the page would withhold. The gates run unchanged and
   in order: `runCheck` on the EXACT bytes about to run, Script Security, then
   `runAdmitted`, which also re-verifies a button trigger against the store.
4. **Rust co-decides** (follow-up F3). On `runAdmitted`,
   `application_code_gate::explicit_run_cell_access` grants only when everything
   Rust can see agrees: a claim; the object-script surface; exactly one approved
   artifact, its id the claim's macro, its source the bytes the realm runs; the
   door agreeing with the trigger (the button door = a button the store
   verified; any other door = no trigger). Yes opens a GRANT in a bounded ledger
   (`ScriptState::explicit_run_grants`, 64, closed with its document) and
   answers `cellAccess: true` with a `grantId`; every other phase and case
   answers no grant.
5. The realm gets cell access only when BOTH said yes (`cellGrant` needs
   `runAdmitted`, the claim it sent, `cellAccess === true` and a safe-integer
   `grantId`; an old backend that says nothing is no grant).

**The always-on run row names it.** `application_code_run` says either "you
started it from Developer > Macros > Run | its button | the command line, so it
could read and change cells on any sheet while it ran" (extra `cellAccess:
true`, `startedBy: "you"`, `door`, `grantId`), or, for an object-script run
without the grant, "restricted, without cell access, because <why>"
(`cellAccess: false`, `startedBy: "script"`, `noCellAccess`, and `claimedDoor`
when the page claimed a door Rust could not honour). `startedBy` is `"you"`
only for a door Rust vouches for, on every row. The module runtime's run row
names its door the same way -- and so, since the review of M6b, does the BUTTON
DOOR's (`record_button_run`: held inline code and `Name()` calls, "... -- you
started it from its button", `startedBy: "you"`, `door: "button"`; its
Script-Security refusal row carries the same two fields).

**Nobody else can write these rows** (review of M6b). The mount door
(`check_distributed_mount_consent`) and the two audit doors of 11.9 and 11.10
are on the backend facade's DENYLIST under `codeExecution`
(`app/src/api/backendCommands.ts`): the script host and the one-off runner are
their only callers, and a third party that reached them could forge a "you
started it ... with cell access" row or spend a live grant. A grant id is RANDOM
(the OS generator, a safe integer, never 0, never one still open): a sequential
id let any caller of the report door name the NEXT grant and spend it with an
empty report before the run reported, so the run's real writes never reached
the trail.

Fails closed: an unreadable consent record, an unverifiable trigger, an edited
macro (refused by the hash), a missing stamp, a copied, spent or mismatched pass,
a Rust no -- each ends in "restricted" or "refused", never in cell access.

### 11.4 What it grants: a narrow flag, not a tier

The realm keeps tier `restricted` and the application's origin, so there is
still no just-in-time capability prompt, capabilities still come only through
the consent record, and every other tier site in the host behaves exactly as
for any restricted realm (the `sheet.*` cross-sheet clamps, form and pane
bindings, `clampChangesToTier`, same-origin trust, the stamp the pull writes).
One flag on the host-side identity, `ScriptHandle.explicitRun.cells`
(`buildHandleFromDefinition`, `broker.ts`, attached only to a granted
distributed restricted handle), is read in these places:

- `decidePolicy` (`brokerPolicy.ts`) admits the closed table
  `EXPLICIT_RUN_CELL_METHODS` (`explicitRunGrant.ts`) and nothing else from the
  unlocked tier; anything else is refused with a sentence saying what cell
  access covers. A realm without the flag gets the old refusal byte for byte.
- `decidePolicy` also REFUSES a few RESTRICTED rows to a realm carrying the flag
  (`explicitRunRestrictedRefusal`): the run-only rows (11.7) and the two
  restricted formatting writes, `sheet.setRangeFormat` and
  `sheet.clearRangeFormat` (`EXPLICIT_RUN_REFUSED_FORMAT_METHODS`). The reason
  is a COMPOSITION: every restricted `sheet.*` row is clamped to the LIVE active
  sheet (`clampSheetIndex`), and the grant includes `api.setActiveSheet`, so
  without this the run could switch to each sheet in turn and format or strip
  the formatting of all of them -- reach no restricted realm has on its own
  (only the user moves the sheet on screen) and not cell access. It costs a
  macro nothing it can reach through its own context: a workbook-context realm
  has no `context.sheet` object, and the recorder formats through
  `api.setRangeFormat`, already excluded. The broker is the barrier, not the
  shim -- a realm can post a broker call directly (`postMessage` is not
  neutered). The restricted cell rows and format READS stay admitted.
- `fillRangeFromScript` (host.ts) is told `moduleParity` (11.5).
- `buildBase` (`worker/contextShims.ts`) gives the realm the normal
  `context.api` object, so a recorded macro runs unchanged; enforcement stays
  host-side.

The restricted tier is walked exhaustively too: every capability-free
`restricted` row is classified for a granted run (admitted as for any
restricted realm, or refused with its reason), so a new restricted row fails
the test until someone decides whether `api.setActiveSheet` turns its "sheet on
screen" into "every sheet" (`explicitRunGrant.test.ts`, "EXHAUSTIVE: every
capability-free RESTRICTED row").

The table -- twenty broker rows, each paired with its module-runtime twin from
the one-off profile in `core/script-engine/src/manifest.rs`. None carries a
capability.

| Grant row | Module-runtime twin |
|---|---|
| `api.getCellValue`, `api.getCellData`, `api.getCellFormula` | `Calcula.getCellValue`, `Calcula.getCellFormula` |
| `api.getRangeValues` | `Calcula.getRange` |
| `api.getUsedRange`, `api.getCurrentRegion`, `api.getRangeEdge` | the same three `Calcula.*` reads |
| `api.getSheetNames`, `api.getSheets`, `api.getActiveSheet` | `Calcula.getSheetNames` / `getSheetVisibility` / `getActiveSheet`, `Calcula.workbook.sheets` |
| `api.setCellValue` (any sheet), `api.updateCellsBatch`, `api.setCellFormula` | `Calcula.setCellValue`, `Calcula.setRange` |
| `api.fillRange` | `Calcula.fillDown`, `Calcula.fillRight` (see 11.5) |
| `api.setActiveSheet` | `Calcula.setActiveSheet` (a recorded macro's first statement) |
| `api.recalculate`, `api.getCalculationMode` | `Calcula.application.calculate`, `.calculationMode` |
| `api.beginBatch`, `api.commitBatch`, `api.cancelBatch` | a module run is one transaction -- and so is a granted run: the run's own undo step is opened before it starts, and these JOIN it (11.8) |

**Excluded, with the owner's words ("the same CELL access") as the test:**
`api.runMacro` (a macro started from inside the run is script-started, and it
could reach the user's own unlocked macros); `api.executeCommand`,
`api.emitEvent`, `api.onEvent` (drive other code; the module runtime has none);
the file methods (`api.workbookSave` / `SaveAs` / `FileName` / `IsDirty`) and
`api.userName`; the protection family (distributed code never lifts or imposes
protection); every formatting row including `api.setRangeFormat`, which can set
`locked`/`formulaHidden`, the restricted `sheet.setRangeFormat` /
`sheet.clearRangeFormat` (above), and named styles (formatting is not cell
access -- this is LESS than module parity, which has `applyNamedStyle`; the
owner's rule is a ceiling, not a target; the one formatting a granted run does
is the style a fill copies from its band, 11.5); all structure (insert/delete,
merge, sort, sheets, sizes, panes, outline, filters, page setup); every object
(charts, tables, pivots, shapes, notes, comments, names, validation,
conditional formats); the view; operations that are cell-equivalent but wider
in shape (`clearRange`, `copyRange`/`pasteRange`, `replaceAll`, `findAll`,
`evaluate`, `setCalculationMode` -- an owner call to widen later); and every
`cap.pkg*` row (application publishing and pulling, which rely on the tier as
their only barrier against a self-propagating code channel). The exhaustive
test walks EVERY `ALLOWLIST` row with every capability id granted and declared,
so a new row is refused unless someone adds it here on purpose
(`app/src/api/scriptHost/__tests__/explicitRunGrant.test.ts`).

### 11.5 `api.fillRange`: held to its module twin

`api.fillRange` is the drag-fill (`fillRangeFromScript`, host.ts). It writes
values and shifted formulas and copies the source band's STYLES onto the target
-- which is parity: `Calcula.fillDown` / `fillRight` go through the backend
`fill_range` (`app/src-tauri/src/commands/data.rs`), whose own doc says
non-formula cells are "cloned verbatim (value + style)". Both paths check sheet
protection over the target, so a fill cannot lift protection; on an UNPROTECTED
sheet a fill can carry an unlocked style onto a cell, which an approved module
macro could already do. This style copy is the one formatting a granted run
does, and both the Macros dialog and the approval screen say so.

The drag does two more things the module twin does not, and a GRANTED realm's
fill does neither (`fillRangeFromScript(..., { moduleParity: true })`, passed
by the `api.fillRange` case whenever the handle carries `explicitRun`):

- it repeats the source band's MERGE pattern inside the target
  (`replicateMergeRegions`) -- structure, which cell access is not;
- it emits `FILL_COMPLETED`, whose listener in the Sparklines extension
  (`extensions/Sparklines/handlers/fillHandler.ts`) CREATES sparkline groups for
  the filled cells -- objects, which cell access is not either.

The user's own scripts keep the drag's full behaviour. The row itself stays in
the grant because the recorder records every fill as `api.fillRange`; dropping it
would refuse most recorded macros that fill. Widening a granted fill back to the
drag's merges and sparklines is an owner decision (follow-up F14), not a fix.

### 11.6 What still applies to every granted write

The grant opens the broker; it does not bypass the backend. Sheet protection is
checked on every path a granted write takes: the active-sheet write
(`update_cell_impl`, `data.rs` `check_sheet_protection_cells`), another sheet
(`update_cell_on_sheets`, reached through `writeOffSheetCellTyped`, which checks
every targeted sheet), the batch (`update_cells_batch`) and the fill target
(`fill_range`). The writeback draft gate captures a write into a `.calp` input
form exactly as it captures a keystroke, and a canvas sheet refuses cell writes
as it does for everyone. In a WORKING COPY the private-sheet rule still runs
before every call: the grant is decided after the standing check in
`handleCall`, and the BUG-0267 ordering (`callsAtGate` holds "mounted" behind
gated calls) is unchanged.

### 11.7 How long it lasts: a run-only realm

- **Until setup settles.** `wireWorker` switches `explicitRun.cells` off when the
  realm reports "mounted" (in arrival order, after any call still waiting at the
  standing gate has been handed to the broker -- whose check is synchronous).
  The one-off runner unmounts right after.
- **Once.** `mountWorker` honours an admission's grant for the FIRST realm built
  from it (`spentCellGrants`): a debug session re-presenting the admission
  mounts without it. A crashed run is never respawned at all (follow-up F11):
  `crashWorker` tears a `consentRun` realm down and rejects its run with the
  crash, instead of re-running `setup` with no one starting it.
- **Nothing left behind.** A granted realm may not register hooks (the shim's
  `registerHook` throws and the host refuses to wire a `hookRegistered`),
  expose methods or subscribe to events (`RUN_ONLY_REFUSED_METHODS`, refused for
  any realm carrying the flag, even after it expired), so no other code can call
  into it and borrow the access while it runs.
- **Nothing handed on.** The same set refuses the OUTBOUND door,
  `base.callMethod`. Without it a granted run could read every sheet -- the
  subscriber's own included -- and pass the result in one call to an exposed
  method of a standing script from the same application, which needs no
  `public` flag to be called (R7 same-origin trust) and may hold a consented
  capability such as `net.fetch` or `distribution.writeback`. The module
  runtime has no channel to other scripts at all. `base.callImport` stays
  admitted: `authorizeImportCall` caps every library call by the CALLER's own
  grants. The one remaining channel is the indirect one every restricted script
  shares: cells the run writes, which another script may read.

### 11.8 All or nothing: a run that fails part-way is undone (follow-up F9)

The module runtime runs a macro on a clone and applies nothing when it throws.
A granted object-script run writes LIVE, one ordinary cell command at a time --
so without more, a macro that threw after two writes left them written, and
`api.cancelBatch` dropped their undo record and KEPT them. Now:

1. **A savepoint before it runs.** For a granted realm, `mountWorker` asks
   `begin_undo_savepoint` (`app/src-tauri/src/undo_commands.rs`) BEFORE the
   realm is told to run: it opens the run's own undo transaction, or JOINS the
   one a caller holds open (a command-line run of several lines is one step, and
   its `run` line joins it), and names the point it is at -- the open
   transaction's ticket and how many changes it holds -- under one stack lock. A
   run whose point cannot be named does not start ("did not start: ... Nothing
   was changed"; `describeGrantedRunNotStarted`), and a transaction that begin
   opened is closed. The recorder's own `api.beginBatch` then joins the run's
   step, so its commit and cancel close nothing.
   **One run per step** (review of M6b): a second granted run started while the
   first holds its step -- two quick clicks are two runs -- would JOIN that step,
   and the first run's rollback would then take the second's writes back while
   the second reported success. So granted runs TAKE TURNS: each waits, before
   it marks its savepoint, until every granted run started before it has ended
   (`waitForGrantedRunTurn`, host.ts; a turn that has not come after 30 seconds
   is a run that did not start, "Nothing was changed"), and Rust refuses the
   join on its own side too -- `begin_undo_savepoint` never joins a step a
   savepoint OPENED (`IssuedUndoTicket::by_savepoint`) and answers why
   (`refused`), which the person then reads.
2. **The end waits for the run's calls.** When the run ends -- "mounted", or the
   realm's teardown (the deadline, a crash, a standing-gate refusal) -- the host
   waits for every call the run made to finish (`endGrantedRun`), so no write
   of the run lands after its step is closed.
3. **Committed, or taken back.** A run that completed is committed as ONE step
   (the ticket its begin was handed). One that did not is TAKEN BACK:
   `roll_back_to_undo_savepoint` splits exactly the changes recorded after the
   savepoint out of the open transaction and reverts them through the restore
   Ctrl+Z uses (`apply_changes_with(.., keep_inverse: false)`), leaving no undo
   step and no redo step -- the restore's inverse is never pushed (pushing it
   and removing it afterwards evicted the user's OLDEST redo step whenever the
   redo stack was at its cap; review of M6b) -- and the user's own redo history
   untouched. A savepoint is honoured only while
   the slot still holds that very transaction and holds at least as many
   changes; a sheet structure change or a document swap ends the history, and a
   rollback then moves nothing and says why. The host repaints what came back
   (`showRolledBackRun`: the cells, `MUTATION_REFRESH`, and the sheet the
   restore switched to).
4. **The person is told.** The one-off runner waits for the ending
   (`hostSettleExplicitRun`, after the realm is gone) and says: `"<macro>"
   stopped before it finished: <why>. Every change it had made was undone, so
   nothing was changed.` -- or, when it could not be taken back, why, and that
   its cells need checking (`describeRunFailure`, `objectScriptRunner.ts`). When
   the rollback also took back cells somebody else wrote while it ran (below),
   it never says only "nothing was changed": "Every change it had made was
   undone -- and so were N other cell changes made while it ran (yours or
   another script's) ... Check those cells." The
   10-second deadline and a crash say the same about the outcome; a crash's own
   sentence no longer sends the user to check the cells of a run that was taken
   back (`describeRunRealmCrash(..., takenBackWhole)`).
5. **The trail says it.** The run's write report (11.10) carries `rolledBack`,
   and its rows read "the run stopped with an error before it finished, and
   every change it made was undone" (or "... could not be undone").

**What a rollback takes back besides the run**, named rather than hidden: the
backend has ONE open undo slot, so a write somebody else makes WHILE the run
lasts -- a cell the user types meanwhile, a standing script reacting to the
run's writes -- is recorded after the savepoint and is taken back too, exactly
as Ctrl+Z of the step would. Since the review of M6b it is no longer SILENT:
the rollback answers exactly which cells it took back (`takenBackCells`, the
`SetCell` changes after the point -- never a dependent a recalculation
repainted; spilled cells are never recorded for undo), the host counts those
that are not the run's own writes (`countOthersUndone` against the run's
counted cells, its bounds once the count was capped), and the person and the
trail are told how many (`othersUndone`). A run lasts until its `setup` settles
(at most the 10-second mount deadline). The sheet on screen is left where the
restore put it.

### 11.9 No half-runs before it starts, and no reach for a run a script starts

**The pre-flight.** Before anything mounts, `runObjectScriptOnce` scans an
application macro that carries a pass (`ungrantedApiCalls`,
`explicitRunGrant.ts`). A macro that also calls an unlocked method outside the
grant -- the recorder emits `api.setRangeFormat`, `api.sortRange`, inserts,
merges and sheet changes for formatting and structure -- is refused with those
calls named and "Nothing was changed", instead of starting a run that would
fail at its first excluded call. It names a `callMethod(` call too
(`base.callMethod`, 11.7). The scan reads text, so it cannot see a method
reached dynamically or a broker call posted directly; every such miss is a false
NEGATIVE that the broker still refuses when the call is made -- and since F9 the
run's earlier writes are then taken back (11.8). The refusal is on the
persistent trail (follow-up F8): `audit_explicit_run_refusal`
(`scripting/explicit_run_audit.rs`) reads the APPLICATION from the module store
and records an always-on `ApplicationCodeRefused` row (reason
`outsideCellAccess`, the method names that appear in the source, the source
hash); if it cannot be recorded, the refusal the user reads says so. **The
approval first** (review of M6b): the pre-flight runs before the mount gate, so
the door asks the macro's approval before anything else, for the bytes the store
holds -- an UNAPPROVED macro is recorded `notConsented` ("its code is not
approved", no methods) and the person reads the approval's own refusal, never
"when you run such a macro yourself it may read and change cells ... adapt it
into a macro of your own", which speaks of approved code and invited copying
unapproved publisher code into a macro of their own.

**A run a script starts gets no reach, in either runtime** (follow-up F10).
The object-script route was already restricted (a script's `api.runMacro`
carries no pass), and the recorder's scaffold now THROWS when it has no
`context.api` (follow-up F12: "it needs cell access, and this run has none. Run
it yourself -- from Developer > Macros > Run, a button that runs it, or the
command line ... Nothing was changed.") instead of returning, which made a run
that changed nothing read as "ran". The MODULE runtime cannot run a macro with
less than its full reach, so it refuses: `RunScriptRequest.started_by`
(`{kind:"you", door}` | `{kind:"script"}`; missing = a script) is required on
the page (`runWorkbookScript`'s `startedBy`), only a live pass minted for that
very macro names a person's door, and `application_code_gate::
distributed_run_gate` refuses an APPROVED application module macro that no
person started (or whose door contradicts its trigger) with
`APPLICATION_MACRO_NOT_STARTED_BY_YOU` and an always-on `ApplicationCodeRefused`
row (reason `notStartedByYou`). The module runtime's doors are the three above
plus `viewBookmark` (a bookmark YOU activated). The user's own and ad-hoc code
is never asked.

### 11.10 What a granted run wrote is on the persistent trail (follow-up F15)

A module-runtime run leaves structured, always-on grid-mutation rows because
Rust applies its writes. A granted object-script run writes through the broker,
so the host counts what it writes -- per sheet: distinct cells and their bounds,
at the one hook every broker write passes (`recordScriptWrite` ->
`noteGrantedRunWrite`) -- and, once its calls have finished, sends ONE report,
`audit_explicit_run_writes({ grantId, completed, rolledBack, failedCalls,
countsCapped, sheets })`. Rust takes the grant (unknown, already reported or
evicted -> nothing recorded), validates the report's shape BEFORE taking it
(inverted bounds, a sheet twice, a count the bounds cannot hold, a completed
run claimed to be taken back -> refused, grant kept), and writes one always-on
`ScriptExecuted` row per sheet in the module runtime's shape (surface
`object-script`, the macro as the surface id, sheet, count, bounds) plus
`application`, `macroId`, `startedBy: "you"`, `door`, `cellAccess`, `grantId`
(which joins the run row), `completed`, `rolledBack` (when not completed),
`othersUndone` (cells somebody else wrote that the rollback took back with it,
only for a run that was taken back; review of M6b), `failedCalls` /
`countsCapped` when set, and the button -- the application, macro, door and
button FROM THE GRANT, never from the page. A run that DID NOT COMPLETE and
wrote nothing -- it never started (no savepoint, a superseded mount), or stopped
before its first write -- still leaves one row, "changed no cells: it stopped
before it finished, or never started" (`cellsModified: 0`, no sheet), so the run
row that said it ran with cell access is never the last word (review of M6b); a
COMPLETED run that wrote nothing records nothing more. Fail-soft but loud:
a report the trail cannot take never fails the run, and the user sees a warning.
A report pending when the workbook is replaced is dropped, and Rust closes its
grants with the document.

What Rust vouches for is WHICH grant and that it is reported once; the sheets
and bounds are the page's account of the writes it brokered. A hostile renderer
could misreport its own writes -- as it can write cells without any script.

### 11.11 What every screen says

The decision is a promise, so each place a person reads about such a macro says
the same thing, and the doors it names are read from the mint census by a test:

- **The approval screen** (`ScriptConsentDialog.tsx`, follow-up F4): a macro
  WRITTEN AS AN OBJECT SCRIPT (the payload's `objectScriptMacroIds`, by the
  runtime marker the run routes read) gets its own paragraph
  (`describeObjectScriptMacroReach`): it runs once, in a restricted space of its
  own, not in the interpreter; when you run it yourself -- Developer ▸ Macros ▸
  Run, a button that runs it, or the command line -- it may also read and change
  the cells of any sheet (a fill also copies the formatting of the cells it
  fills from), and nothing more; if it stops part-way every change it made is
  undone; started by another script it has only the sheet on screen. The
  interpreter paragraph is shown only when a macro for the workbook script
  runtime or a button action is in the grant, and then names that runtime.
  Pinned by `macroSurfaceReachHonesty.test.tsx`.
- **The Macros dialog** (`describeMacroProvenance`, `macroLibrary.ts`): the same
  doors and limits; `macroProvenance.test.ts` derives the doors from the census
  and binds the limits to the broker's own answers.
- **The Object Script Editor's tier chip** (follow-up F5): Run and Debug there
  are restricted; what a run you start gets instead, by runtime.
- **Code in This File** (`codeInventory.ts`, follow-up F7): a macro written as
  an object script is listed on the `object-script` surface it runs on -- tier
  from its origin, no interpreter reach -- with `module.cellAccessWhenYouRunIt`
  and an "Any sheet when you run it" badge for an application's; per-workbook
  trust keeps keying every module by the module store.
- **The command line**: the pre-run notice and `help run` say a run you start
  may read and change cells on any sheet.

### 11.12 What stays restricted, and what is still owed

**Restricted:** standing object scripts (a realm with handlers or timers); every
run a script starts (`api.runMacro`, an event handler, a timer, a view bookmark
a script activates); the Object Script Editor's Run and Debug; notebooks,
custom functions, shared libraries, chart marks and transforms, writeback
validators. **An AI assistant's or MCP client's script** (`execute_script`, the
in-app AI chat's `run_script` tool, `mcp/tools.rs run_script_isolated`) is a run
a SCRIPT starts too: since the review of M6b it asks `distributed_run_gate` as
`RunStartedBy::Script` after the MCP access ceiling, so an application's module
macro run verbatim is refused (for its approval when that is missing, else as
not started by you) and an application's held button code by the backstop, each
on the trail. The agent's own code is the agent's, governed by that ceiling --
like every such rule this one matches bytes.

**"Make this my own" keeps the macro the application's** (review of M6b). An
adopted macro link is LIVE, and a live link runs whatever module carries its id
with no application asked for; at a checkout every link is held, ids the
application never shipped included. So `adopt_held_button_code` adopts a held
link only when it names a macro of the STAMP'S application in this workbook
(refused, nothing changed, when it names the user's own macro, another
application's, none, or the stamp cannot be read), which keeps the confirm's
promise true: the macro it runs stays the application's and still runs only
after its approval.

**Still owed, or the owner's to decide:**

- **The live run.** `app/e2e/journeys/calp-macro-buttons.spec.ts` "M4-7 (owner
  B)" exercises every door, the run rows, the write report, the script-started
  refusals and the pre-flight refusal row in a launched app; it is type-checked
  and has not been run live yet. Neither has a live step for 11.8 (a recorded
  macro that throws after writing), nor for the review of M6b's fixes (two
  quick clicks taking turns, the button door's run row naming its door).
- **A view bookmark the user activates** runs an application's MODULE macro
  (bookmarks are wiring of the user's own, like their own button). If the
  owner reads "the three doors" as exhaustive, the narrowing is one line in
  Rust (drop the `viewBookmark` door).
- **A granted fill's merges and sparklines** (11.5, follow-up F14).
- **Writes others make during a run** are taken back with a failed run (11.8)
  -- now said, with a count, to the person and on the trail; whether to take
  them back at all is the owner's call (the recommendation kept it: Ctrl+Z of
  the step would do the same).

**Tests.** `app/src/api/__tests__/explicitMacroRun.test.ts` (the pass and its
census: mint and claim sites, by identifier and opaque module reach, the gesture
handlers and who reaches them, the command line's chain);
`app/src/api/scriptHost/__tests__/explicitRunGrant.test.ts` (the table,
exhaustive over the unlocked AND the restricted `ALLOWLIST` rows, the run-only
and formatting refusals, the handle flag, the pre-flight);
`explicitRunAdmission.test.ts` (admission incl. the `consentRun` and
object-script-surface conditions, first-realm-only, expiry, run-only, the
`setActiveSheet` + `sheet.setRangeFormat` composition, `callMethod`, the
module-parity fill, the standing recheck, no crash respawn (g2-g3), Rust's
claim and grant (q), the write report (s), all-or-nothing (t1-t7), and -- review
of M6b -- runs taking turns (t8, t8b, t9), the other changes a rollback took
back (t10, t10b) and Rust's reason for no savepoint (t11));
`fillRange.test.ts` (module parity); `explicitRunShim.test.ts`;
`explicitRunNotFromScripts.test.ts`; `runScriptStartedByWire.test.ts`;
`app/src/api/__tests__/objectScriptRunner.test.ts` (forwarding, pre-flight and
its trail row, the sentence a stopped run says);
`app/extensions/MacroRecorder/__tests__/macroProvenance.test.ts`,
`scriptStartedModuleRun.test.ts`; `CellTypes/__tests__/buttonCellObjectScriptMacro.test.ts`;
`Controls/__tests__/buttonGesturePass.test.ts`;
`BuiltIn/CellBookmarks/__tests__/viewBookmarkActivator.test.ts`;
`ScriptableObjects/__tests__/macroSurfaceReachHonesty.test.tsx` and
`packageConsentLoadPath.test.ts` (the approval screen),
`objectScriptEditorMacros.test.tsx` (the chip); `src/api/codeInventory.test.ts`
and `src/api/__tests__/workbookTrust.test.ts` (the inventory);
and `app/extensions/MacroRecorder/__tests__/explicitRunEndToEnd.test.ts`, which
composes the real provider, runner, host, broker and worker shim over source the
recorder itself generates -- the Macros dialog, a click on a button control and
on a button cell through the real gesture handlers, and a typed `run` through
the real command-line engine write the cell; a local script's `api.runMacro` of
the same macro does not; and a recorded macro that throws after TWO writes is
taken back whole, with the person told nothing was changed. In Rust:
`application_code_gate_tests.rs` (the gate, the claim, the run rows, the
script-started refusal), `control_action_tests.rs` /
`control_action_door_tests.rs` (the button cell's `macro` answer and the trigger
it builds), `explicit_run_audit_tests.rs` (the write report incl. a taken-back
run, the pre-flight row, the ledger) and `undo_savepoint_tests.rs` (the
savepoint: a run that throws after two writes taken back entirely, one inside a
command-line batch taking back only its own changes, a history that ended, a
forged point, the user's redo history left alone). Each was proven by a
sabotage that turned it red (2026-10-01). The review of M6b added, each
sabotage-proven: the button-door caller census (`explicitMacroRun.test.ts`);
`undo_savepoint_tests.rs` `a_second_savepoint_never_joins_a_step_another_run_holds`,
`a_rolled_back_run_at_the_redo_cap_evicts_none_of_the_users_redo_steps`,
`the_rollback_names_exactly_the_cells_it_took_back`;
`explicit_run_audit_tests.rs` `grant_ids_are_random_safe_integers_and_never_sequential`,
`a_run_that_never_wrote_and_did_not_complete_leaves_a_row`,
`a_rollback_that_took_back_other_changes_says_how_many`,
`an_unapproved_macro_is_refused_for_its_approval_not_for_what_it_calls`;
`control_action_door_tests.rs` (the button door's rows name their door);
`held_button_code_tests.rs` `adopting_a_held_link_refuses_one_that_does_not_name_the_applications_macro`;
`application_code_gate_tests.rs` `the_mcp_script_route_asks_the_run_gate_as_a_run_a_script_started`;
`backendCommands.test.ts` (the three trail doors denylisted);
`objectScriptRunner.test.ts` (b3) and the others-undone sentence;
`buttonCellObjectScriptMacro.test.ts` / `controlActionDoor.test.ts` (the
runner's own sentence said once; a repaint after every button run).
