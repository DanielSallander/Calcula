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
>   §12, which is new. A model described as complete that never mentions the
>   holes later found in it is the most misleading thing a security document can
>   do.
> - Still accurate and load-bearing: the §2 UDF architecture, the §4 extension
>   sandboxing design, and the §6-§8 rationale. Those are why this file is kept.
>
> The **live** open-defect register is `docs/design/open-decisions-2026-08.md`;
> the **live** surface taxonomy is `app/src/api/scriptSurfaces.ts`.

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
surfaces (see §11).

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
Reuses the exact cached engine path the app's own pivots use
(`engine.query_auto_refresh` with `measures` / `groupBy` / `filters`). Scoped to
the workbook's BI **model**; **no SQL-injection surface** (the script supplies
measures/columns/filter-*values*, not SQL text); **no DB-wide access**. The
executor calls the existing `bi_query` command. No Engine Lib change.
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
