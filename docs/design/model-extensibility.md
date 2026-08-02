# Model Extensibility — Bricks for the Semantic Layer

**Status:** ALL 4 PHASES SHIPPED v1 (2026-07-16) — engine v22 `extension_data`; lifecycle events (`app:bi-model-changed` / `app:bi-refresh-completed` on the bus, Tauri wire names `bi:*`); `bi.model` capability + `script_bi_model` gateway; `bi.connector` script sources (`bi_script_source` + `connector_secrets` + secretHeader injection); `calcula.modelOverlay` distribution. Implementation deviations from this design are listed at the end of §4.
**Owner docs:** PHILOSOPHY.md ("Never Wait for the Vendor", "Bricks of Every Size", "No First-Class Citizens"), ARCHITECTURE.md, docs/design/wave3-scripting-security.md, docs/design/backend-facade.md, docs/design/granular-bricks.md
**Scope:** the BI semantic model (`bi_engine` DataModel: tables, measures, relationships, calc groups, script functions, sources, …) and every surface that touches it

## 1. Why

Calcula's founding argument is that Power BI took away the user's ability to
build their own solution. Yet on one axis, Power BI is today *more* open than
Calcula: its model layer has a third-party tooling ecosystem (Tabular Editor,
DAX Studio, best-practice analyzers, docs generators) built on XMLA/TOM.
Calcula's equivalent surface is walled off:

- The Model Editor extension is honestly dogfooded — it uses only public
  `@api` `biModel*` functions (`app/src/api/backend.ts`), no backdoors. **A
  trusted extension can programmatically author models today.**
- But every one of those commands — including all mutation — sits on the
  `biData` denylist (`app/src/api/backendCommands.ts:78-135`). A non-trusted
  (third-party / distributed) extension's only sanctioned door is the broker's
  consent-gated, **read-only** `bi.query`. A sandboxed script can query a
  model; it cannot add a measure to one.
- Data connectors are compile-time only (PostgreSQL, SQL Server, CSV, Parquet,
  in-memory). If your data lives in a REST API or a SaaS product, you wait for
  the vendor — the exact trap the philosophy exists to avoid.
- The model has no open metadata (the workbook has a ledgered, `.calp`-carried
  `extension_data` bag; `DataModel` has none) and emits no lifecycle events,
  so annotation-style tooling (lineage tags, lint suppressions, docs) and
  reactive tooling have nothing to build on.

This document extends the brick philosophy to the model layer: four phases,
each independently shippable, each a *governed* door — declared in a manifest
ceiling, granted by consent, recorded in the audit trail, reversible in the
user's undo stack.

## 2. Current state (verified 2026-07-15)

What already aligns with the philosophy:

| Surface | State |
|---|---|
| Model authoring via `@api` | Full CRUD for trusted extensions: measures, calc columns, relationships, hierarchies, KPIs, roles, perspectives, calc groups, contexts, variables, script functions, sources, writeback columns (`app/src/api/backend.ts`, `app/src-tauri/src/bi/model_editor.rs`) |
| Custom code *inside* the model | `script_functions`: sandboxed Rhai, persisted in the model, compiled to scalar UDFs (`engine-core/src/compute/script.rs`); host UDF registry also exists (`engine-core/src/compute/udf.rs`, `Engine::register_udf`) |
| Query layer for scripts | `bi.query` (structured) / `bi.sql` (raw read-only) / `cube.*`, consent + Rust-side grant re-check + always-on audit (`bi/commands.rs:2160`, `:2280`) |
| Engine connector seam | `Connector` trait + `ConnectorCapabilities` (`engine-connectors/src/traits.rs`), closed-enum dispatch macro `define_any_connector!` (`engine-query/src/registry.rs`) — microkernel-shaped, compile-time only |
| Distribution | Dataset `.calp` packages ship the whole serialized model, signed Ed25519+TOFU, credential-free (`calp_commands.rs:670` `calp_publish_model`); subscribed models are read-only (`model_editor.rs:316`) |

What is closed with no door at all:

- **Model mutation for non-trusted callers** — the `biData` denylist (above).
- **Custom data sources** — no runtime connector registration of any kind.
- **Model metadata** — no `extension_data` on `DataModel`
  (`engine-core/src/model/schema/mod.rs:443`; format v21,
  `MODEL_FORMAT_VERSION` at `:436`).
- **Model events** — nothing emits on model change or refresh completion
  (`app/src/api/events.ts` has no BI events; `model_editor.rs` never emits).

Mechanics this design reuses (all existing):

- Capability machinery: `capabilityIds.ts` (six ids today: `net.fetch`,
  `bi.query`, `bi.sql`, `storage`, `ui.html`, `formula.udf`), allowlist rows +
  validators (`scriptHost/allowlist.ts`), broker ceiling + JIT consent +
  `SERVER_AUDITED_METHODS` (`scriptHost/broker.ts:189`).
- The single mutation funnel `apply_model_edit` (`model_editor.rs:408`):
  fresh snapshot under the engine lock → pure edit → `build_combined_model` →
  `set_model` → mirror `base_model` onto every connection sharing the
  `ModelKey` → `record_model_undo`. Every `bi_model_*` command flows through
  it (undo/redo/import flow through the sibling install helper at `:380`).
- Model undo stacks keyed by `ModelKey` (`model_editor.rs:348`).
- Workbook `extension_data` precedent (`persistence.rs:3199` get / `:3209`
  set; ledgered variant; carried + merged by `.calp` pulls,
  `calp_commands.rs:1608`).
- Distribution bricks: `registerDistributableObjectProvider`
  (`app/src/api/distributableObjects.ts:63`), package kinds, signed sidecar
  manifests with declared-capability ceilings for distributed scripts.
- Engine seams: `add_in_memory_source_with_id` (host re-supplies data on
  reopen via `SourceCredential::Connector` — `engine/src/source_wiring.rs:229`,
  `SourceKind::InMemory` at `engine-core/src/model/source.rs:34`),
  `RefreshReport` (`engine/src/refresh.rs:53`), `RefreshStrategy` DTO mapping
  (`model_editor.rs:954-1013`).

## 3. Goals / non-goals — what stays kernel

**Goal:** open the semantic layer — what the model *means* (measures,
relationships, calculations, sources, metadata) — to the same tiers of
customization the grid already has: trusted extensions, consented sandboxed
scripts, signed distributed packages.

**Non-goals (closed, permanently or until a dedicated design):**

- **RLS/OLS role definition — read AND write.** Code that can rewrite row
  filters can widen its own reads or sabotage others'. Role definitions do not
  even appear in the sanitized script-facing model info (v1 conservative).
- **Connection & credential management.** `bi_model_connect`,
  `test_connection`, `list_source_tables`, `import_tables`, `create_blank`,
  and the OS credential store reach *new* data targets under the user's stored
  credentials. Scripts never see a secret (Phase 3 designs around this).
- **The trust machinery itself:** broker policy, capability stores, consent
  ledger, signing/TOFU, window guards, audit — never scriptable.
- **Engine closed enums:** native `AnyConnector` variants, aggregation ops,
  built-in function dispatch. Extensibility is *via* script functions / UDFs /
  script-fed sources — not enum injection into the evaluator.
- **Format-version stamping and migration** — host-controlled, explicit.

> Calcula opens the semantic layer — what the model *means* — while keeping
> closed the three surfaces that decide *who may see* (RLS), *as whom*
> (credentials), and *what is trusted* (signing, consent, audit). This is
> "Primitives, Not Policies" applied honestly: every door this design opens is
> a governed door — declared in a manifest ceiling, granted by consent,
> recorded in the audit trail, reversible in the user's undo stack, and
> revocable — and no door grants ambient authority. The kernel is not the
> feature set; the kernel is the guarantee that a user can always answer "what
> ran, what it touched, and who let it." Everything else is a brick.

## 4. Phase overview

| Phase | Front | Size | New Tauri commands | Depends on |
|---|---|---|---|---|
| 1 | Model `extension_data` + lifecycle events | S–M | +1 (`bi_model_extension_data`) | — |
| 2 | Governed model mutation (`bi.model`) | M | +1 (`script_bi_model`) | — (events from 1 are nice-to-have) |
| 3 | Custom script connectors (`bi.connector`) | L | +2 (`bi_script_source`, `connector_secrets`) | 1 (binding persistence), 2 (gateway pattern) |
| 4 | Distributable model customizations | M | +0 | 1–3 (carries their artifacts) |

Command budget matters: the app has ~660 Tauri commands and a /STACK:32MB
main-thread reserve baked into the PE header (see MEMORY: stack-overflow
gotcha). Every new surface here is **one multiplexed command**, never a
command per operation. Total: **+4**.

Phase ordering rationale: Phase 1 is cheapest and load-bearing — Phase 3
persists connector bindings in the model `extension_data`, and Phase 4 gets
distribution "for free" because the bag rides the model serialization that
`calp_publish_model` already ships. Phase 2 is the highest value-per-cost:
every mechanism it needs (broker ceiling, JIT consent, Rust grant re-check,
model undo, subscribed-read-only guard) already exists.

**Implementation deviations (v1, shipped 2026-07-16):**

- **Event bus names follow the repo's `app:` convention** (guarded by the
  api-contract tests): `AppEvents.BI_MODEL_CHANGED = "app:bi-model-changed"`,
  `BI_REFRESH_COMPLETED = "app:bi-refresh-completed"`. The Rust-emitted Tauri
  wire names stay `bi:model-changed` / `bi:refresh-completed`; the Shell
  bridge maps them.
- **The change DOMAIN is diffed, not threaded.** `apply_model_edit` derives
  the domain (+ object name when cheaply determinable) by comparing the
  before/after models (`changed_domain`), instead of every command passing it
  in — exactly-once with no per-call-site bookkeeping to forget. `source:
  "script"` + scriptId ride a tokio task-local set by the gateway.
- **The Phase-2 gateway dispatches into the existing command fns directly**
  (they remain plain callable Rust functions) rather than an inner-fn
  refactor — same single implementation, zero duplication.
- **Connector refresh scheduling** lives on the binding record
  (`refreshEverySecs`, min 30s, host `setInterval`) rather than reusing the
  table `RefreshStrategy` DTOs — simpler v1; strategies can supersede later.
- **Connector scripts are object/workbook scripts** (they `context.expose`
  a `fetchTable` method the trusted host calls). Worker-EXTENSION connectors
  are deferred (extensions lack the expose channel).
- **Secret slot origin-binding** is v1-coarse: a slot is usable only by the
  OWNING script (binding record) toward origins that script's `net.fetch`
  consent covers — not per-slot origin lists (open question #1 stands).
- **Overlays carry workbook calculated MEASURES only** (the workbook layer
  has no calc-group store yet); "shadowed" collisions are logged, not yet a
  ledger flag. Connector-binding visibility for pulled datasets =
  `biModelExtensionDataGet(conn, "calcula.scriptConnectors")` (a dedicated
  ledger panel is follow-up UI).

---

## 5. Phase 1 — Model `extension_data` + lifecycle events

### 5.1 The bag: an engine-side field, not an app sidecar

Add to `DataModel` (`engine-core/src/model/schema/mod.rs:443`):

```rust
/// Open, namespaced metadata for host applications and their extensions
/// ("vendor.feature" keys, opaque JSON values). The engine never interprets
/// entries; they travel wherever the model travels. Empty by default and
/// skipped on serialization when empty.
#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
extension_data: BTreeMap<String, serde_json::Value>,
```

- **Format bump v21 → v22**, with a versioning-note entry following the v21
  doc-block convention. Hard bump on write-when-present: an older engine
  refuses a v22 file (`ModelFormatTooNew`) rather than silently dropping
  third-party metadata on resave — same rationale the v21 note records.
- **`BTreeMap`, not `HashMap`** (the workbook bag uses HashMap): model bytes
  feed `.calp` artifact SHA-256 checksums and signatures, so serialization
  must be deterministic.
- **Why not an app-side sidecar keyed by connection id:** connection ids are
  per-machine while a model is shared across connections (`apply_model_edit`
  mirrors every edit onto all connections sharing the `ModelKey`) — a
  connection-keyed sidecar desyncs; and `calp_publish_model` serializes the
  live engine model as the entire dataset package — a sidecar would need a
  parallel artifact plus id remapping to travel at all. Wrong grain, wrong
  carrier.

Rules (mirroring the workbook bag): namespaced keys (`vendor.feature` — the
`calcula.` prefix is reserved), opaque JSON, additive, **256 KB per key**
(matching `cap.storageSet`'s quota), writes rejected on package-subscribed
models with the existing read-only error (`model_editor.rs:316`).

### 5.2 Command + `@api`

One multiplexed command, window-guarded `MAIN_AND_MODEL_EDITOR`, on the
`biData` denylist like its siblings:

```
bi_model_extension_data { connectionId, op: "get"|"set"|"delete"|"list", key?, value? }
```

`set`/`delete` route through `apply_model_edit` (so they mirror + land on the
model undo stack like any other model edit). `@api` wrappers:
`biModelExtensionDataGet/Set/Delete/List` in `backend.ts`. Sandboxed access
arrives in Phase 2 (`kind: "extensionData"` through the gateway).

### 5.3 Lifecycle events

Two new `AppEvents` entries (`app/src/api/events.ts`), emitted Rust-side via
`app_handle.emit` from the mutation funnel and re-emitted on the `@api` bus by
a thin frontend bridge (same pattern as the `MUTATION_REFRESH` fan-out):

- `bi:model-changed` — `{ connectionId, domain, objectName?, source, scriptId?, revision }`
  - `domain`: `"measure" | "calcColumn" | "relationship" | "hierarchy" | "kpi"
    | "calcGroup" | "scriptFunction" | "table" | "column" | "context"
    | "variable" | "perspective" | "metadata" | "extensionData" | "bulk"`
  - `source`: `"user" | "script" | "extension" | "undo" | "package"`
  - `revision`: monotonically increasing per `ModelKey`, so subscribers can
    cheaply detect missed events and re-read.
- `bi:refresh-completed` — `{ connectionId, tables: [{ name, ok, error? }], durationMs }`,
  sourced from the engine `RefreshReport` (`engine/src/refresh.rs:53`).

**Emission choke points:** `apply_model_edit` (`model_editor.rs:408`) after a
successful install, and the sibling install helper (`:380`) for the
undo/redo/import paths — every mutation route already funnels through these
two, so emission is exactly-once by construction.

**Payloads are metadata-only.** Never expressions, row data, or role
definitions — a subscriber re-reads through its own sanctioned read path, so
events can never become an un-capability-checked read channel. Subtlety: even
object *names* are model metadata that today requires `bi.query` to
enumerate. Therefore: the trusted main-thread bus gets the full payload
(with `objectName`); when these events are added to
`SCRIPT_SUBSCRIBABLE_APP_EVENTS` (`allowlist.ts:119`), the worker bridge
forwards a **thinned** payload — `{ connectionId, domain, revision }` only.
No new capability is needed for the thinned form; it leaks nothing `bi.query`
wouldn't already gate.

### 5.4 Open questions (Phase 1)

- Subscriber-local overlay bag for read-only subscribed models (annotate a
  model you can't edit)? Deferred — Phase 4's workbook-layer overlays cover
  most of the need.
- Should `bi:model-changed` coalesce during bulk operations
  (`bi_model_import_tables`)? Proposal: emit one `domain: "bulk"` event per
  command invocation rather than per object.

---

## 6. Phase 2 — Governed model mutation: the `bi.model` capability

### 6.1 One capability, policy-data granularity

Add `"bi.model"` to `ALL_CAPABILITY_IDS` (`capabilityIds.ts:36`) — the
seventh id. **Not** per-object-type capabilities: the consent vocabulary must
stay human-sized ("this script may modify BI model definitions"). Which object
kinds are reachable is enforced by the allowlist row validators
(`allowlist.ts`) — the single object already consumed by broker dispatch, the
transparency panel, and consent text — and re-checked in Rust.

### 6.2 The open/closed split

**Open under `bi.model`** (consent + audit + undo): measures, calculated
columns, relationships, hierarchies, KPIs, calculation groups, contexts +
context columns, global/table variables, calculated tables, date-table /
default-lookup-resolution settings, descriptive metadata, `extension_data`,
**perspectives** (the schema documents them as "purely presentational — NOT a
security boundary", `schema/mod.rs:526-529`), and **script functions**.

Script-function justification: Rhai script functions already travel inside
dataset packages — a subscriber already executes publisher Rhai inside the
engine sandbox (no I/O, compiled to scalar UDFs). A consented script adding
one is the same trust class; the sandbox is the boundary, not the author.

**Stays privileged** (on the `biData` denylist, no broker route):

| Surface | Why |
|---|---|
| RLS role upsert/delete/read | The "who may see" boundary; also self-widening risk |
| Connection/source management (`bi_model_connect`, `test_connection`, `list_source_tables`, `import_tables`, `create_blank`, source upsert/bind) | Reaches new data targets under the user's stored credentials |
| Storage mode / refresh policy / refresh trigger | Cost levers — flipping DirectQuery→InMemory triggers bulk fetches against corporate databases; revisit with rate limits (open question) |
| Undo/redo commands | Undo is a user gesture. The guarantee is the inverse: every script mutation lands on `ModelUndoStacks`, so the **user** can always undo what a script did |

### 6.3 One gateway command, not forty

Do **not** lift `bi_model_*` off the denylist. Add a single multiplexed
command mirroring the `script_bi_sql` precedent:

```
script_bi_model { scriptId, connectionId, action: "upsert"|"delete"|"info", kind, payload }
```

The Rust handler, in order:

1. Re-checks the grant server-side exactly as `bi_query` does
   (`record_capability_call(..., "bi.model", ...)` denial path,
   `bi/commands.rs:2160` pattern; extend the `grant_script_bi` store).
2. Enforces the allowed-kind set **in Rust** (frontend validators are UX;
   Rust is authority). RLS/connection kinds are rejected here regardless of
   what the frontend asked.
3. Rejects package-subscribed models with the existing read-only error.
4. Dispatches into the same logic the `#[tauri::command]` wrappers use —
   refactor: extract inner `fn`s from the command wrappers so both doors share
   one implementation (and one `apply_model_edit` funnel).
5. Writes the always-on Rust audit record with `scriptId`.
6. Lands on the model undo stack (via the funnel — free).
7. Emits `bi:model-changed` with `source: "script"` (via the funnel — free).

Broker rows (3, following `cap.biQuery` naming): `cap.biModelUpsert`,
`cap.biModelDelete` (class `mutate`), `cap.biModelInfo` (class `read`) — all
`tier: "restricted"`, `capability: "bi.model"`, `desc` strings written as the
consent text. Added to `SERVER_AUDITED_METHODS` (`broker.ts:189`) since the
Rust gate records them authoritatively.

Callers by tier: built-in (trusted) extensions keep calling `biModel*` `@api`
directly — status quo. Sandboxed object scripts and distributed
worker-extensions go through the broker → gateway. The notebook surface stays
read-only for now (its design doc declares model mutation an anti-goal);
revisiting that is an open question below, not a silent change.

### 6.3a As shipped (2026-07-31) — three action families, not one

The gateway grew past the sketch above. What `script_bi_model` accepts today
(`app/src-tauri/src/bi/model_editor.rs`):

| Family | Actions | Rate bucket |
|---|---|---|
| WRITE | `upsert`, `delete` over `GATEWAY_MUTABLE_KINDS` | `BI_MODEL_MUTATIONS_PER_MINUTE = 30` |
| READ (diagnostics) | `info`, `validateMeasure`, `validateContext`, `validateModel`, `dependencyGraph`, `measureLineage`, `dependents` | `BI_MODEL_READS_PER_MINUTE = 120` |
| BATCH (atomic) | `batchBegin`, `batchEnd`, `batchCancel` | `batchBegin` spends one MUTATION token; closing is free |

The two buckets are keyed `(script_id, bucket)` so a spent mutation budget can
never block the diagnostic that explains why the edit failed.

**Kinds: 17, not the prose list.** `GATEWAY_MUTABLE_KINDS` is one const that
both backs the rejection message and is asserted by tests on both sides — the
TS mirror `BI_MODEL_SCRIPTABLE_KINDS` (`scriptHost/validators.ts`) is checked
for set equality by a test that parses the Rust const directly, so the two
cannot drift: `measure`, `calcColumn`, `relationship`, `hierarchy`, `kpi`,
`calcGroup`, `perspective`, `culture`, `scriptFunction`, `calculatedTable`,
`tableVariable`, `context`, `contextColumn`, `writebackColumn`, `metadata`,
`dateTable`, `extensionData`. The §6.2 "stays privileged" table is unchanged
and is asserted absent by test.

**Response sanitization is mandatory, not only on `info`.** Every arm that
returns a `ModelOverview` goes through `overview_value()` (= the `info`
projection). Returning the raw overview from a *mutation* would have let any
script read `securityRoles` and `sources` through the response that the
request whitelist refuses. Engine error text is scrubbed too
(`scrub_privileged`): a whole-model rebuild can fail *on* a role predicate and
name it.

**Batches.** The undo stacks' `in_batch` flag is the interlock (a second begin
fails at source); only the opening script may end/cancel; the trusted
`batch_end`/`batch_cancel` refuse while a script batch is live. An abandoned
batch is reclaimed by a wall-clock deadline (`SCRIPT_BATCH_MAX_SECS = 30`)
checked at the head of `apply_model_edit` — the funnel every mutation passes —
and is **rolled back, not committed**. A crashed worker cannot deliver an
unmount signal, which is exactly why the deadline, not a hook, is the guard.

### 6.4 Sanitized read

`cap.biModelInfo` returns a new, smaller DTO than `bi_model_get_overview`:
tables/columns/measures/relationships/hierarchies/KPIs/calc-groups metadata —
**no `security_roles` at all** (not even names, v1 conservative), no
connection targets (host/database), no credential-adjacent fields. Precedent
for treating the full overview as sensitive: it is window-guarded to
`MAIN_AND_MODEL_EDITOR` (`model_editor.rs:2106`).

### 6.5 Open questions (Phase 2)

- Per-minute mutation rate limit — recommend yes: `limits: { perMinute: 30 }`
  on the allowlist rows (a linter fixing 200 measures asks the user once per
  minute-window, not never).
- Storage-mode / refresh knobs under `bi.model` with rate limits — revisit
  after v1 telemetry.
- Notebook `model.upsert*` — would reverse a documented anti-goal
  (notebook-analysis-workbench.md); needs its own decision.
- Should JS `formula.udf` registration count as `bi.model`? Recommend no —
  worksheet functions are a workbook concern, not a model concern.

---

## 7. Phase 3 — Custom data connectors (sandboxed script connectors)

### 7.1 Shape: host-orchestrated script feed

**Rejected alternative:** a `ScriptConnector` variant inside `AnyConnector`
implementing the `Connector` trait. The engine would call back *into* a JS
worker from `fetch_data` — inverted async control across two workspaces (the
engine has no JS runtime and must not grow one), across the Tauri boundary,
with cancellation and mutex-across-callback deadlock hazards (the same engine
mutex `calp_publish_model` already has to `try_lock`-probe). And the payoff —
engine-driven pushdown — is void: a REST/SaaS source is
`ConnectorCapabilities::fetch_only()` anyway; there is nothing to push down.
Recorded as future work if a script source ever wants filter pushdown.

**Chosen shape:** a connector is a script (existing script registry; worker /
QuickJS; existing `net.fetch` broker path) exporting:

```ts
export async function fetchTable(request: {
  table: string;            // logical table name being refreshed
  params: Record<string, unknown>; // user-configured connector params
}): Promise<{
  columns: { name: string; type: "string"|"number"|"boolean"|"date" }[];
  rows: unknown[][];        // v1: JSON columns; Arrow IPC bytes = fast-path option
}>
```

The **host** materializes the result via `InMemoryConnector` →
`add_in_memory_source_with_id` (`engine/src/source_wiring.rs:229`) →
`bind_table`. The engine sees a perfectly ordinary in-memory source. Row/byte
limits bound the transfer (open question: the hard ceiling).

### 7.2 Persistence: zero engine changes

The source persists as `SourceKind::InMemory` — already documented as "cannot
be reconstructed from persisted descriptors alone; the host re-supplies at
load" via the `SourceCredential::Connector` seam (`source_wiring.rs:225-229`).
The *binding* — "source S is fed by script X, table T, params P" — lives in
the Phase-1 model `extension_data` under `calcula.scriptConnectors`. No
`SourceKind::Script` variant, no v23 bump, and the binding travels inside
dataset packages automatically.

### 7.3 Credentials: secrets vault + server-side header injection

The script never reads secrets:

1. A connector declares named secret slots (`"apiKey"`).
2. The user fills them in a host dialog; values stored via the Windows
   Credential Manager pattern already in `bi/credential_cache.rs`
   (target `Calcula:connector:<id>`).
3. At fetch time the script calls
   `net.fetch(url, { secretHeader: { slot: "apiKey", header: "Authorization", format: "Bearer {}" } })`.
4. The Rust gate (`script_http_fetch`) resolves the slot server-side and
   attaches the header. Each slot is **origin-bound at grant time** — the
   consented origins are recorded with the grant, so a script cannot replay a
   secret to a different host.

The secret never enters the JS realm. Residual risk: a malicious *server*
echoing the secret back in the response body — flagged as an open question
(candidate mitigations: response-body secret scrubbing; restricting slots to
allowlisted well-known auth headers).

### 7.4 Refresh, cancellation, errors

"Refresh" = re-run the script → replace the `InMemoryConnector` data →
`Engine::refresh_table`. The model's existing `RefreshStrategy`
(interval / dailyAfter — DTO mapping in `model_editor.rs:954-1013`) is
evaluated by a **host scheduler** for script sources. Failures surface exactly
like engine refresh failures (`RefreshReport` collects per-table errors
instead of aborting) plus the Phase-1 `bi:refresh-completed` event and the
audit trail. Cancellation rides the existing per-script timeout/termination in
the worker host. v1 is full-replace; an incremental
`{ mode: "append", watermark }` handshake is an explicit open question, not a
promise.

### 7.5 New surfaces

- Capability `"bi.connector"` (eighth id) — gates *registering/binding* a
  connector, so consent names it distinctly from plain `net.fetch` ("this
  script feeds tables into your data model" ≠ "this script may call
  api.example.com").
- Broker rows: `cap.connectorRegister`, `cap.connectorRemove`.
- **+2 commands:** `bi_script_source { op: "install"|"replace"|"removeBind"|"feedRows", ... }`
  (multiplexed) and `connector_secrets { op: "list"|"set"|"delete", ... }` —
  the latter privileged, user-UI only, added to the `credentials` denylist
  group.

### 7.6 Open questions (Phase 3)

- Secret-echo exfiltration (7.3).
- Hard memory ceiling for materialized script sources — a script can feed
  unbounded rows; need a cap + deny/spill decision.
- Background scheduled refresh of a *distributed* connector script: only
  after standing consent recorded in the ledger, and never on first open
  before the consent dialog. Exact UX to be designed with the scheduler.

---

## 8. Phase 4 — Distributable model customizations

### 8.1 Two carriers, both existing

**Whole-model (dataset packages):** already done, and Phase 1 widens it for
free — `calp_publish_model` ships everything embedded in the model, which
after Phases 1–3 includes `extension_data` and connector bindings. Signed
Ed25519+TOFU, semver-pinned, credential-free ("subscriber connects with their
own credentials, so RLS is preserved"). New work: surface connector bindings
in the subscriber's consent ledger so "this dataset pulls from a script
connector" is visible before first refresh.

**Overlays (add measures/calc groups to a model the subscriber already
has):** a new distributable-object kind `calcula.modelOverlay` via
`registerDistributableObjectProvider` (`distributableObjects.ts:63`).
Crucially, overlays materialize into the **workbook layer**, not the base
model — reusing the exact layering that already exists for workbook
calculated measures (`build_combined_model` re-applies them on top of the
base). The publisher's base model is never edited, so the
read-only-subscribed-model rule is preserved *structurally*, and overlay
objects re-apply on package refresh like any other workbook-layer object.

### 8.2 Connector scripts in packages are distributed scripts, full stop

They inherit the entire existing distributed-script pipeline: manifest-declared
capability ceiling, signing, consent dialog naming `bi.connector` + the
`net.fetch` origins, per-script audit. **Secrets never travel** (consistent
with the no-credentials package rule); the subscriber is prompted to fill
slots on first materialization.

### 8.3 Approval split: declarative auto, code gated

- Pure declarative overlay payloads are inert data (signed, hash-verified,
  not executable — the security note in `distributableObjects.ts:13-18`):
  auto-apply on package refresh with a ledger entry.
- Anything carrying **code** (connector scripts, script functions inside
  overlays) goes through the publisher-baseline/approval gate the
  writeback-validator flow established: a changed version shows a diff before
  it re-applies.
- Name collision (overlay measure vs a measure the publisher later adds):
  publisher wins; the overlay object is flagged "shadowed" in the ledger.
  Whether to hard-reject instead is an open question.

Package-kind registry gets nothing new in v1 — `dataset` + overlays inside
any kind suffice. +0 commands.

---

## 9. Cross-cutting

- **Audit taxonomy.** Broker-ring entries for consent-time decisions;
  authoritative Rust-side records for everything the gateway commands do
  (`record_capability_call` pattern) — matching how `bi.query`/`bi.sql`
  already split. Model mutations by scripts appear under the existing
  "Scripts"/"Capabilities" audit-viewer categories with `scriptId`, `kind`,
  and object name.
- **Format versioning.** One engine bump for the whole roadmap: **v22**
  (`extension_data`). Phases 2–4 add no model fields. Host stamps explicitly
  at `.cala` save + `.calp` publish per the existing stamp-helper chain
  (…v20 → v21 → v22).
- **Stack headroom.** +4 commands total, all multiplexed (see MEMORY:
  ~660-command `generate_handler!` vs /STACK:32MB).
- **Naming.** TS `camelCase` / Rust `snake_case` via
  `#[serde(rename_all = "camelCase")]` on every new DTO (`api_types.rs` /
  `types.ts` mirroring), per CLAUDE.md.

## 10. Open questions (consolidated)

1. Secret-echo exfiltration mitigation (7.3): scrub vs allowlisted headers.
2. Memory ceiling + deny/spill policy for script-fed sources (7.6).
3. Background refresh consent UX for distributed connectors (7.6).
4. Storage-mode/refresh knobs under `bi.model` with rate limits (6.5).
5. Per-minute mutation rate limit default (6.5 — recommend 30/min).
6. Notebook surface mutation (6.3/6.5 — currently a documented anti-goal).
7. Overlay name-collision: shadow vs hard-reject (8.3).
8. Incremental (append/watermark) refresh handshake (7.4).
9. Event coalescing for bulk import; subscriber-local annotation bag (5.4).

## 11. Appendix — file & command inventory

**New commands (4):** `bi_model_extension_data` (P1), `script_bi_model` (P2),
`bi_script_source` (P3), `connector_secrets` (P3, privileged).

**New capabilities (2):** `bi.model` (P2), `bi.connector` (P3).

**New events (2):** `bi:model-changed`, `bi:refresh-completed` (P1).

**Files touched per phase:**

| Phase | App | Engine |
|---|---|---|
| 1 | `bi/model_editor.rs` (command + emission), `api/events.ts`, `api/backend.ts`, `api/backendCommands.ts` (denylist), `scriptHost/allowlist.ts` (subscribable events) | `engine-core/src/model/schema/mod.rs` (field + v22) |
| 2 | `scriptHost/capabilityIds.ts`, `allowlist.ts`, `broker.ts`, `bi/commands.rs` (gateway), `bi/model_editor.rs` (inner-fn refactor), consent/transparency UI strings | — |
| 3 | `bi/script_provider.rs`-adjacent host orchestration, `net_commands.rs` (`secretHeader`), `bi/credential_cache.rs` (connector targets), scheduler, `scriptHost/*` (bi.connector) | — (uses existing `source_wiring` seams) |
| 4 | `distributableObjects.ts` provider kind, publish/pull ledger surfacing, approval-gate wiring | — |

**Prior art this composes with:** granular-bricks.md (two-tier discipline),
wave3-scripting-security.md (capability vocabulary + audit),
backend-facade.md (denylist stays intact — gateways, not exemptions),
calp-distribution.md (signing, no-credentials rule, approval gates),
calculated-tables.md + engine-host gotchas memory (format-version chain).
