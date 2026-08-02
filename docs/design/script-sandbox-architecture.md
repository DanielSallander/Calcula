# Calcula Wave 2 — Object-Script Sandbox Architecture (Final, Synthesized)

**Status:** Approved for implementation. Synthesized from three independent designs (A: compatibility-first, B: security-first, C: simplicity-first) by the architecture judge, 2026-06-12.

**Skeleton choice: Design C** (per-script workers, one allowlist table, one protocol file, minimal concept count — the right base for a solo maintainer), **grafted with** Design B's policy schema, threat model, fail-closed reshapes, and capability set, and Design A's compatibility machinery (blob-import compilation, stale-while-revalidate render cache, mirror getters, broker-before-worker phasing, data-driven window-guard map). Every contradiction between the designs is resolved explicitly in §1.

**Scope:** S2 (script isolation), S3 (`withGlobalTauri` flip), S4 (tier broker), C9 (capabilities), S10 (CSP), plus interaction points with S5 (signing), S6 (iframes), S7 (MCP).

---

## 0. Wave 3 status update (2026-06-14) — supersedes stale rows below

Wave 2 is complete. **Wave 3 is complete** and is recorded in full in
**`docs/design/wave3-scripting-security.md`** — UDF evaluation (C1),
extension-sandboxing Phase A **and** Phase B (S8/C7) with signed sidecar
manifests + worker-extension menus, script-surface unification (C3), the
`bi.query` and `bi.sql` capabilities, and command return values. The capability
vocabulary lives in ONE place — `app/src/api/scriptHost/capabilityIds.ts`
(`ALL_CAPABILITY_IDS`) — and has since grown past Wave 3's set: `net.fetch`,
`bi.query`, `bi.sql`, `storage`, `ui.html`, `formula.udf`, `bi.model`,
`bi.connector`, `ui.dialog`. Read the module, not this list.

> **Post-Wave-3 (2026-06-24):** two features build directly on this substrate and
> are recorded in `docs/design/cube-formulas-and-custom-functions.md` — the
> **CUBE formula family** (7 worksheet functions over BI models, plus a `cube.*`
> script API under `bi.query`), and **Custom Functions (JS UDFs)**, the
> user-authored worker-script-defined UDF path (a `restricted` handle, may call
> `cube.*`) anticipated under `formula.udf`. No new capabilities were added.

Two corrections to the roadmap below, recorded here so the
historical planning text is not mistaken for current state:

- **R14 / Phase 5 / Residual-risk #1 are RESOLVED, but NOT as written.**
  `chartTransforms.ts` no longer uses `new Function`/`eval`; it uses
  `evalArithmetic`, a pure recursive-descent arithmetic parser (the migration
  target became a parser, not blob-ESM `import()`). `'unsafe-eval'` is already
  dropped from both `csp` and `devCsp` in `tauri.conf.json`. CSP v2 shipped.
- **Residual-risk #5 (third-party extensions run fully trusted) is now
  ADDRESSED in two layers.** Phase A: distributed extensions are
  trust-classified, bounded by a declared-capability ceiling (deny-by-default),
  and surfaced in the transparency panel (`extensionTrust.ts`,
  `ExtensionManager`). Phase B (v1): a distributed extension that declares
  `workerSupport: true` runs SANDBOXED in a hardened worker realm with NO
  ambient DOM/Tauri/network authority — the bundle is imported inside the worker
  (never on the main thread) and every privileged effect is broker-mediated and
  ceiling-checked, exactly like an object script. Files:
  `extensionWorkerHost.ts`, `worker/extensionBootstrap.ts`,
  `worker/extensionWorkerContext.ts`, `extensionProtocol.ts`, shared
  `worker/workerHardening.ts`. The worker ExtensionContext is a data-driven /
  async-RPC SUBSET (commands, events, notifications, capabilities); React-
  component surfaces (ribbon tabs, panels, dialogs, custom cell editors) and
  synchronous grid hooks cannot cross a worker boundary and throw a clear error
  — an extension needing them omits `workerSupport` and runs on the main thread
  (Phase A governance). Browser-`fetch` exfiltration is already contained
  app-wide by the locked `connect-src`. **Follow-ups now DONE:** signed sidecar
  manifests (`<base>.manifest.json` + `.sig`, Ed25519 + TOFU, verified at scan —
  so `workerSupport` + the ceiling are read WITHOUT importing the bundle, with
  tamper/publisher-change detection) and worker-extension menu registration. See
  `wave3-scripting-security.md` §4.

### Script-surface taxonomy & unified governance (C3)

The app runs user/extension code through several surfaces. They are deliberately
NOT executed by one engine — the governance is unified (one capability
vocabulary, one consent/provenance model, one transparency story), but execution
is heterogeneous because the surfaces have different needs and constraints. The
single source of truth is `app/src/api/scriptSurfaces.ts` (kept in lockstep by a
test); this is the prose mirror:

| Surface | Runtime | Sandbox / containment | Capabilities | Gate |
|---|---|---|---|---|
| **Object scripts** | Per-script Web Worker ("worker realm") | Hardened worker; no DOM/Tauri; all privileged calls broker-mediated | `net.fetch`, `bi.query`, `bi.sql`, `storage`, `ui.html`, `formula.udf` (R19 ceiling, grant/consent) | Tier broker + per-package consent |
| **Formula UDFs** | The owning script's worker realm | Same as object scripts; invoked via `formula.udf.invoke`, pre-fetched before the synchronous recalc | `formula.udf` | Broker (declared + granted) |
| **Notebook cells** | Rust QuickJS (`NotebookSession`, persistent, on a dedicated executor thread) | Isolated interpreter over CLONED grid state; grid ops + read-only `model.*` (host-provider, Rust-gated); NO network / filesystem / Tauri | `bi.query`, `bi.sql` (read-only model access; 2026-07 notebook-analysis-workbench.md) | Coarse session approval (`check_script_security`) + JIT per-notebook capability consent (Rust `CapabilityStore`, key `notebook:{id}`) |
| **One-off scripts** | Rust QuickJS (ephemeral) | Same isolation as notebooks; grid-only over cloned state (no model provider injected) | none | Coarse session approval |
| **Chart transforms** | Main thread, pure data pipeline | `evalArithmetic` (recursive-descent arithmetic; no `eval`/`new Function`) — NOT an execution surface | n/a | n/a (pure declarative) |
| **Writeback validators** | Rust QuickJS (ephemeral, publisher-authored) | Empty cloned grid with `Calcula`/`model`/`display`/`console` deleted before the publisher's code is evaluated; the body comes from the Ed25519-verified version manifest | none | Per-package consent keyed by SHA-256 of the exact body; the Rust submit path fails closed |
| **MCP tools** | Rust (tool bodies first-party) + Rust QuickJS for the `run_script` tool | The `run_script` tool runs AGENT-authored JS in the same isolated interpreter as one-off scripts (cloned state, grid-only — no model provider); other tools are first-party Rust; sensitive commands stay main-window-guarded | none | Window-label guard + AI access ceiling (`check_mcp_access`: read / mutate / script) + session approval for the script tier |

**Why notebooks/one-off stay on Rust QuickJS rather than moving to the worker
realm:** (1) they are well-contained — an isolated interpreter over a
*clone* of grid state with no network/filesystem/Tauri reach. (2) The worker
realm compiles user code as blob-ESM under a no-`unsafe-eval` CSP, which cannot
`eval` arbitrary incremental cell strings with shared mutable scope — the
notebook REPL model fundamentally needs an interpreter (QuickJS, outside the
browser CSP). So the correct unification is governance convergence (one
vocabulary + consent + provenance + transparency), not execution relocation.
The original "notebook-as-worker" idea is recorded as not pursued for these
two reasons.

> **2026-07 update (notebook analysis workbench):** the original third reason —
> "a capability ceiling would gate nothing because there is no ambient
> surface" — is RETIRED. Notebook cells now carry exactly one ambient surface:
> the read-only `model.*` API (`bi.query`/`bi.sql` classes) injected as a host
> `ModelDataProvider` and enforced SERVER-SIDE per call in the same Rust
> `CapabilityStore` + gate-free query cores (`bi_query_core`/`bi_sql_core`,
> RLS applied inside the engine lock) that the worker-realm gates use, keyed by
> the `notebook:{id}` surface id, with JIT consent and always-on capability
> audit. The containment story is now: worst case = mutate the grid (undoable)
> + read granted model data (consented, audited). Still no network/filesystem/
> Tauri reach. The notebook session also moved off the command thread onto a
> dedicated executor thread (deleting the old `unsafe impl Send` wrapper).
> Details: `docs/design/notebook-analysis-workbench.md`.

**Audit trail across the Rust QuickJS surfaces (DONE):** notebook cells, one-off
`run_script`, and MCP `execute_script` now record an **always-on**, **structured**
`ScriptExecuted` entry into the per-workbook audit log (`core/calp/src/audit.rs`;
`scripting/commands.rs::record_script_grid_mutation`): surface kind, surface id,
sheet, cell count, and (for the diffed run_script/MCP path) the mutated
active-sheet range. "Always-on" means script activity records even when the
opt-in distribution audit log is disabled — the Transparency pillar requires
script grid mutations to be visible by default. Surfaced as a "Scripts" category
in the audit-log viewer.

**Capability-call audit (DONE — the "one transparency story"):** capability use
now persists into the same per-workbook trail as `AuditEvent::CapabilityCall`
(always-on). The split avoids double-recording: `net.fetch` / `bi.query` /
`bi.sql` record authoritatively **server-side** in their Rust gates
(`net_commands::record_capability_call`; success + the gate's own denial; net.fetch
logs the origin only, bi.sql a short SQL prefix — never full URL/query), while the
frontend-only caps (storage / ui.html / formula.udf) and broker-side policy
denials write through from the broker ring via the `audit_record_capability`
command (`broker.ts` skips the backend-reaching caps' invoke results so they
aren't recorded twice). The in-memory `auditRing.ts` remains the live
transparency-panel feed; the write-through mirrors it into the persisted log so
it survives reload.

### Transparency: the reach claim is DERIVED, not asserted (DONE — closes the last residual)

Transparency is a product pillar: the user must always be able to answer "where
does code reside, and what can it touch?". The first half was settled by the
per-file code inventory (`app/src/api/codeInventory.ts`). The second half had a
residual that was named in `CLAUDE.md` and in the §8 review for months:

> the codeInventory "reach" for grid-only surfaces is **asserted**, not verified
> against the interpreter.

Concretely: the panel said a notebook / one-off script / MCP script was
"grid-only" because a TypeScript constant said so. Nothing checked that against
the QuickJS realm, so an op module that grew a new privileged reach would have
widened those sandboxes while the panel kept reassuring the user. That is the
one failure direction a transparency surface must never have.

**The chain of custody now runs from the interpreter outward.** Every link is
mechanically checked; none of them is a promise.

| # | Link | Where | What proves it |
|---|---|---|---|
| 1 | The realm's ACTUAL registered surface | `core/script-engine/src/manifest.rs::enumerate_registered_surface()` | Boots a real QuickJS runtime through the same `runtime::execute_script` entry point a one-off run uses, subtracts a bare realm's built-ins, and walks what is left — including the `Sheet`/`Range` objects the canonical object model hands out from function calls, which a static walk of the globals cannot see |
| 2 | Classification of every path into a `ReachClass` (+ the capability id the host gate demands) | `OP_MANIFEST` in the same file | `op_manifest_matches_the_live_interpreter_surface` diffs 1 against 2 in **both** directions. A new op fails the build and the message names `manifest.rs` as the fix site |
| 3 | HOW each host surface builds the realm — is a `ModelDataProvider` injected? are the host globals deleted first? | `SURFACE_PROFILES` in the same file | `without_a_model_provider_every_model_op_throws` proves the mechanism BEHAVIOURALLY: the `model.*` ops are registered on **every** surface, so "one-off scripts are grid-only" rests entirely on the provider being `None`. The companion test proves the other direction (with a provider injected, the ops resolve), so the notebook row is not overstated either |
| 4 | Per-surface reach + capability ceiling | `surface_reach()` / `surface_capability_ids()`, derived from 2 + 3 | Derivation, not a constant: `writeback-validator` gets an EMPTY reach because its harness deletes the host globals; `notebook-cell` gets `bi.query`/`bi.sql` because a provider is injected; `one-off-script` and `mcp-tool` get nothing because one is not |
| 5 | The TypeScript mirror the UI reads | `QUICKJS_SURFACE_REACH` / `QUICKJS_SURFACE_CAPABILITIES` in `app/src/api/codeInventory.ts` | `app/src/api/__tests__/interpreterReachDrift.test.ts` reads `manifest.rs` at test time (same instrument as the `include_str!` guard that pins `KNOWN_CAPABILITY_IDS` against `capabilityIds.ts`) and diffs 4 against 5, and the `rust-quickjs` rows of `scriptSurfaces.ts` against 4 as well |

The direction of the diff is fixed and non-negotiable: **Rust states what the
realm registers and how each surface builds it; TypeScript must match.** The
renderer can be compromised; the interpreter is where the sandbox actually is,
so a TS constant claiming "no BI reach" means nothing if the realm has a working
`model.query`.

Two consequences worth naming:

- `scriptSurfaces.ts` already derived its **worker-realm** rows from the enforcing
  code (`brokerGatedCapabilities()` reads the `ALLOWLIST`), but its `rust-quickjs`
  rows were self-asserted, with a comment saying "Rust policy cannot be derived
  from TS". It can now — by reading the Rust — so that asymmetry is gone.
- The panel distinguishes **holding** reach from **being able to be granted** it.
  `codeUnitReachesBeyondGrid` answers "right now" (declared ceiling or live
  grant); `codeUnitMayReachBeyondGrid` answers "after a prompt this surface is
  allowed to raise". A notebook with no grant answers *false* then *true* — and
  showing only the first would let a user conclude a notebook cannot touch the BI
  model when one click stands between it and the data.

**Drift guards inventory.** The same class of silent drift shipped three times in
this program (`ui.dialog`, `distribution.writeback` and `schedule` were each
stripped by a Rust pragma parser whose list had fallen behind), so every
remaining hand-maintained cross-language or cross-layer list is now either
compiler-enforced or covered by a guard whose failure message names the fix:

| List | Lives in | Enforced by |
|---|---|---|
| `KNOWN_CAPABILITY_IDS` ↔ `ALL_CAPABILITY_IDS` | `core/persistence/src/lib.rs` ↔ `capabilityIds.ts` | `include_str!` mirror test (pre-existing) |
| Broker method layers (policy / validator / executor / shim) | `scriptHost/*` | `scriptHost/__tests__/allowlistCoverage.test.ts` (pre-existing) |
| `PRIVILEGED_BACKEND_COMMANDS` ↔ the Tauri command set | `backendCommands.ts` ↔ `src-tauri/src/lib.rs` | `__tests__/backendCommands.test.ts` — typed `Record<PrivilegedCapability, …>` + a fail-closed heuristic for new dangerous-looking commands (pre-existing) |
| Interpreter op surface ↔ `OP_MANIFEST` | `core/script-engine/src/manifest.rs` | `manifest::tests::op_manifest_matches_the_live_interpreter_surface` |
| `OP_MANIFEST` ↔ `QUICKJS_SURFACE_*` ↔ `scriptSurfaces.ts` rust-quickjs rows | `manifest.rs` ↔ `codeInventory.ts` ↔ `scriptSurfaces.ts` | `__tests__/interpreterReachDrift.test.ts` |
| Writeback-validator harness global deletion ↔ the realm's roots | `calp_commands.rs::run_validator_batch` | `__tests__/interpreterReachDrift.test.ts` — a NEW realm global must be deleted or explicitly acknowledged as inert |
| `ScriptSurfaceId` ↔ the inventory's `SURFACE_ORDER` | `codeInventory.ts` | **Compile-time** exhaustiveness type (no test); an unlisted surface would have its units dropped from the panel |
| `DeferredAction` / `BookmarkMutation` Rust enums ↔ their TS unions | `script-engine/src/types.rs` ↔ `workbookScripts.ts` | `__tests__/crossLayerConstantDrift.test.ts` — variant names **and** camelCased field lists |
| `GRID_COMMAND_MAP` ↔ `SCRIPT_SAFE_GRID_COMMANDS` | `commands.ts` | `__tests__/crossLayerConstantDrift.test.ts` — every bridged command must be script-safe or listed as denied with a reason |
| MCP `#[tool]` set ↔ the AI access-tier policy | `mcp/server.rs`, `mcp/objects.rs` | `__tests__/crossLayerConstantDrift.test.ts` — every tool tier-classified, every mutate/script tool proven to reach a gate, `required_tier`'s fail-closed fallthrough pinned |

---

## 1. Contradiction resolutions (binding)

| # | Question | Resolution | Sided with | Why |
|---|---|---|---|---|
| R1 | Worker topology | **One Worker per mounted script.** Port = identity, set at spawn from the authoritative store. | **C** over A (per trust domain) and B (per trust unit + per-script ports) | Identity is structural, not bookkeeping: capability grants are *per script*, so forgery inside a shared restricted realm (A's domain worker) is a real escalation — a script without a `net.fetch` grant impersonating one that has it. B solves this with per-script `MessagePort`s but pays for it with in-worker teardown protocols, port maps, and beacon-based blame. Per-script workers get all of that for free: unmount = `terminate()` (timers, listeners, heap all die), watchdog blame is exact with zero heuristics. A's headline benefit — sync intra-package `expose`/`callMethod` — is moot because all three designs make `callMethod` a Promise anyway. Cost: O(10) workers × ~1–2 MB on a Windows 11 desktop. Irrelevant. |
| R2 | Script compilation in worker | **ESM-wrap user source → `Blob` → dynamic `import()`** inside a URL-loaded module worker. | **A** over B (bet on URL-worker CSP independence + `new Function`) and C (keep `'unsafe-eval'` forever) | A's approach works under *both* possible WebView2 CSP-inheritance behaviors (page CSP already needs `script-src blob:` for the extension loader at `ExtensionManager.ts:500–519`), so the no-`unsafe-eval` end state (CSP v2) doesn't hinge on B's unverified platform bet, and we don't accept C's permanent residual. Bonus: the ESM wrapper puts ALL user code inside the exported function, so `import()`-time executes nothing user-authored — validation becomes side-effect-free. B's `new Function`-in-worker remains the documented fallback if blob `import()` fails the Day-1 spike (see Risks). |
| R3 | Cell `onRender` | **Callback signature preserved; host-side memoized cache with stale-while-revalidate.** B's declarative `style.rules()` StyleProgram is **deferred post-Wave-2** (recorded as the future fast path). | **A** (SWR) + **C** (purity contract, `render.invalidate()`); B's new API deferred | A's SWR (serve the old override while re-evaluating) beats C's value-in-key cache, which flashes unstyled on every edit. B's StyleProgram is a genuinely good idea (no script code in the per-cell path at all) but it's a second authoring model — one new concept too many for Wave 2; nothing in its design is foreclosed by shipping the compat cache first. |
| R4 | Slicer/shape canvas hooks | **Real `OffscreenCanvas` in the worker; host blits cached `ImageBitmap`.** User function signature unchanged. | **C** over A (display-list record/replay) and B (declarative DrawList) | A itself flagged display-list fidelity as its riskiest item, and its `measureText`-against-mirrored-metrics is a hack; B's DrawList breaks every existing renderer. C gives full Canvas2D fidelity (`measureText`, gradients, paths) with zero op-whitelist matrix to maintain. Security is equivalent: the host receives only pixels, blitted inside `save()/translate/clip/restore`. A's display list is the documented fallback if the platform spike fails. |
| R5 | `emitEvent` | **Force-prefix `userscript:` on both emit and subscribe** (transparent to scripts using custom names); `onEvent` may additionally subscribe to a read-only allowlisted subset of `AppEvents`. | **B** over A (denylist of internal namespaces) and C (reserved-prefix denylist) | Denylists drift — every future internal event name is a new hole (today a script can emit `shape:setCanvasRenderer` and hijack another shape, `Controls/index.ts:656`). Force-prefixing fails closed forever. Applied symmetrically on emit *and* subscribe, existing scripts that emit/listen to their own custom names see no behavior change. |
| R6 | `executeCommand` | **Opt-in `scriptSafe: true` metadata on `CommandRegistry` registrations; scripts may only execute flagged commands.** Signature fixed to `execute(commandId, args?)` (forwards full args — fixes `commands.ts:149`). | **B** over A (opt-out `dangerous: true`) and C (any command) | The vision holds every feature to "sandboxed by default." Opt-out fails open for every command anyone adds next year; opt-in forces a deliberate audit. Cost: a one-time flag pass over built-in command registrations (Phase 2). |
| R7 | `callMethod` cross-tier | **Cross-tier/cross-package calls require the target to have been exposed with `expose(name, fn, { public: true })`** (additive option). Same-tier same-origin calls unaffected. Returns `Promise<unknown>`. | **A/B** over C (document the confused-deputy as "by design") | Today a restricted .calp script can invoke an unlocked local script's exposed method with no check (`scriptableObjects.ts:1032`) — that's a privilege-laundering primitive, not an authoring convenience. The `public:true` opt-in costs one option argument. |
| R8 | Timers | **Ambient in the worker — NOT a consent capability.** Silent caps: min interval 16 ms, ≤32 live timers per script. Listed informationally in the transparency panel. | **C** (ambient) + **B** (caps) over A/B (grant-gated) | With per-script workers, timers cannot jank the host and cannot outlive the script (`terminate()` kills them). A consent checkbox for "may use setTimeout" trains users to click through; the checkboxes that exist must all matter. Timers + network is the dangerous combo, and network is gated. |
| R9 | `net.fetch` enforcement | **Rust-side `script_http_fetch` command (reqwest)**; origin grants stored backend-side, written only on consent-grant from the main window, **re-checked in Rust** per request. Page/worker CSP `connect-src` stays locked. | **A/C** over B (host-side `capFetch`) | A host-side fetch either violates the locked `connect-src` or forces it open for the whole page, losing exfiltration containment. Rust-side check also survives a fully compromised renderer. B's parameters adopted: https-only, no credentials, 5 MB response cap, 30 s timeout, 10 req/min/script, audited with URL. |
| R10 | Local-script grants | **Just-in-time grant dialog** on first `CapabilityRequired` denial ("Allow once / Always / Deny"); "Always" persists. | **B** over C (auto-grant: "the user typed the pragma") and A (editor toggle) | C's assumption fails for the paste-from-the-internet case — "local" does not mean "authored." JIT is low-friction for genuine authors and a real checkpoint for pasted code. Grants are visible and revocable in the transparency panel. |
| R11 | Backend window guards | **Data-driven map `command → allowed window labels`** with exception rows, not a blanket `require_main`. | **A** over B/C | Verified in-repo: `ObjectScriptEditorApp.tsx` (running in the `object-script-editor` window) calls `save_object_script` directly (lines 395–621 via `objectScriptBackend.ts:80`). B's and C's blanket `require_main` on object-script CRUD would break the editor's save path. The map costs ~20 lines more and encodes the exceptions as reviewable data. |
| R12 | S3/S10 ordering | **Flip `withGlobalTauri:false` and land CSP v1 (with `'unsafe-eval'`) FIRST, before S2.** CSP v2 (drop `'unsafe-eval'`) lands after S2 + chartTransforms migration. | **C** over A/B (S2 first) | The flip is independent of S2 (zero `__TAURI__` consumers in `app/src`/`app/extensions`; verified `tauri.conf.json:13` is currently `true`). CSP v1's `connect-src` lockdown kills script exfiltration and remote code injection *today*, while scripts still run on the main thread. Free security, day one, each step shippable. A/B were right only about `'unsafe-eval'` removal, which is exactly what CSP v2 is. |
| R13 | Dead hooks | **Prune** `slicer.onDataRefresh`/`onResize`, `chart.onClick`/`onResize`, `pivot.onLayoutChange`/`onResize`. **Wire** `cell.onEditStart` and `pivot.onRefresh`. | **B/C** (prune) + **A/B** (wire onEditStart) | Verified in-repo: `slicer:dataRefreshed` has exactly one reference — the subscription itself (`scriptableObjects.ts:1381`); zero emitters. Dead surface lies to users about what scripts can observe. `AppEvents.EDIT_STARTED` exists (`events.ts:46`) and is emitted nowhere outside tests — one emit line in `useEditing.ts` makes a declared, useful hook honest. `pivot:refresh` has 15+ live emitters (FilterPane, Slicer bridge, Pivot context menu, manifest.ts:211); the bridge subscribes to the wrong name — one-line fix. |
| R14 | `chartTransforms.ts:307` `new Function` | **Migrate to blob ESM `import()`** (same technique as R2, in-page), enabling CSP v2. | **A** over B (route through script-host worker — heavier, makes transforms async across a boundary for no isolation gain: chart specs are user-trusted) and C (defer forever) | Minimal diff, removes the last page-realm eval. **[RESOLVED Wave 3 — see §0: the migration target became `evalArithmetic` (a pure recursive-descent parser), not blob-ESM; CSP v2 shipped.]** |
| R15 | Sync getters (`workbook.properties`, `shape.getProperty`, `slicer.getSelectedItems`) | **Stay synchronous via worker-side mirrors**, seeded in MountSpec, updated by host `mirror` pushes on change events. | **A** over C (reshape slicer getters to Promise) | The mirror mechanism is required anyway (workbook/shape properties are already cache-based today, `scriptableObjects.ts:1093/1725`); making one getter async while keeping others sync is gratuitous inconsistency. |
| R16 | Wire-level method surface | **Per-type context methods collapse to `object.getState`/`object.setState` at the wire**, dispatched by the *mount-pinned* `(objectType, instanceId)`; the script-visible typed surface (`slicer.setSelectedItems`, `chart.updateSpec`, …) is preserved as worker-side shims. Restricted sheet scripts' `getCellValue`/`setCellValue` are clamped host-side to the bound sheet. | **C** (collapse + clamp) + **B** (`ownInstanceOnly` principle) | The worker physically cannot name another instance — scoping is structural, closing the whole `callMethod`-style cross-object class. Allowlist stays small. |
| R17 | Capability set | `net.fetch`, `bi.query`, `storage`, `ui.html` (grantable); timers ambient (R8). | **B**'s set (minus timers), over C's two-capability minimum | `storage` (per-script KV on the virtual FS, broker-rewritten paths, 256 KB quota) pre-empts the "scripts want localStorage" pressure that would otherwise erode the realm boundary. `ui.html` gates the phishing surface of `setHtmlContent` for *distributed* scripts (ambient for local). |
| R18 | Watchdog | Per-script `ping`/`pong` (5 s when the script has hooks/renderers/timers); 2 misses → toast naming the script with **[Terminate] [Open editor]**; terminated-unresponsive scripts are marked **faulted** (excluded from auto-remount, re-enable affordance in the panel). Mount timeout 10 s. | **C** (mechanism, user-in-the-loop) + **B** (fault registry) over A (auto-disable blame-the-last-dispatched) | Per-script topology makes blame exact, so A's heuristics are unnecessary; a runaway per-script worker burns one core, not the UI, so user-prompted termination is safe and less surprising than auto-kill. |
| R19 | Capability declaration | **Pragma in source** (`// @capability net.fetch https://api.example.com`), parsed at registration; `calp_publish` lifts pragmas into a manifest `capabilities` field for pre-consent display; broker rejects undeclared capability use even if a stale grant exists. | **C** (pragma, hash-keyed tamper detection) + **A** (manifest lift) + **B** (manifest-is-ceiling rule) | SHA-256 consent keying (`consentStore.ts:29,82`) means an upstream pragma edit automatically re-prompts — declaration tampering is structurally caught with zero new mechanism. |

---

## 2. Threat model (what each layer stops)

| Attacker capability | Stopped by |
|---|---|
| Script calls `invoke` / reads `window.__TAURI__` | Worker realm never has Tauri (shim doesn't import it); `withGlobalTauri:false` removes it from the page too (S3) |
| Script uses `fetch`/`WebSocket`/`XHR`/`sendBeacon` to exfiltrate | Bootstrap deletes them pre-eval (belt); CSP `connect-src 'self' ipc: http://ipc.localhost` (suspenders) — even a re-acquired fetch reaches nothing external |
| Script touches DOM / `localStorage` / opens windows | Workers have no DOM by construction |
| Script forges another script's identity to escalate tier or steal a grant | Per-script worker: the port the message arrived on IS the identity; tier/grants resolved host-side from the registry, never from message content |
| Script prototype-pollutes the realm to subvert the RPC shim | Bootstrap captures intrinsics into closures before any user byte evaluates; uses only captured refs |
| Script infinite-loops | Render loop never calls into scripts; watchdog names and kills exactly that worker |
| Dangerous Tauri command invoked from a compromised editor window | Rust window-label guards (§7) — independent of all frontend code |
| Hostile .calp auto-runs on open | Existing consent gate (kept) + capability grants + signature status (§8) |
| Upstream silently swaps code or expands capabilities after consent | SHA-256 consent keying — code or pragma change → consent stale → grants revoked → re-prompt |
| Shape HTML iframe scripts the parent | `sandbox="allow-scripts"` only (drop `allow-same-origin`) |

Accepted residual blast radius for a hostile script: burn CPU in its own worker until terminated; mis-style cells; mis-draw its own shape. That is the correct blast radius.

---

## 3. Topology & lifecycle

```
Main window (trusted)                              N script workers (one per mounted script, untrusted)
┌────────────────────────────────────────┐        ┌────────────────────────────────────┐
│ ObjectScriptManager (registry, consent, │        │ bootstrap.ts: capture intrinsics,  │
│   mount orchestration — surface kept)   │  port  │   neuter ambient authority         │
│ ScriptHost (spawn/terminate, watchdog,  ├───────►│ blob ESM import() of wrapped source│
│   event forwarding, mirrors)            │        │ context shims (typed surface over  │
│ Broker (ALLOWLIST, grants, audit ring)  │        │   object.* / api.* RPC)            │
│ RenderCache (style SWR + bitmap caches) │        │ ambient capped timers              │
│ Rust: window guards, script_http_fetch, │        │ OffscreenCanvas rendering          │
│   capability store                      │        └────────────────────────────────────┘
└────────────────────────────────────────┘         ... one per mounted script
```

- **Worker file:** `app/src/api/scriptHost/worker/bootstrap.ts`, spawned via `new Worker(new URL("./worker/bootstrap.ts", import.meta.url), { type: "module" })` (Vite-emitted URL asset; module worker ⇒ no `importScripts`).
- **Bootstrap hardening (first statements, before any script source arrives):** capture intrinsics (`postMessage`, `Promise`, `JSON`, `Object.freeze`, `setTimeout`) into closures; then delete/overwrite-with-throwing-getter: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `navigator.serviceWorker`, `indexedDB`, `caches`; replace `setTimeout`/`setInterval` with rate-capped shims (16 ms min, 32 live); `Object.freeze` the context surface handed to scripts.
- **Compilation:** wrap the (regex-cleaned, now purely cosmetic) source as
  `export default function(context) { ${cleaned}; return typeof setup === "function" ? setup(context) : undefined; }`
  → `new Blob([wrapped], {type:"text/javascript"})` → `import(URL.createObjectURL(blob))`. Import-time executes nothing user-authored.
- **Mount:** host posts `mount` with MountSpec; worker compiles, builds the typed context, calls `setup(context)`, replies `mounted`/error (host emits `objectscript:error` exactly as today — editor console at `ScriptableObjects/index.ts:392` untouched). Entry points unchanged: `loadAndMountScripts()` gate (`index.ts:93`, consent gate `:117–148`), editor save → terminate + respawn (`CodeEditorDialog.tsx:540` flow), AFTER_OPEN/BEFORE_CLOSE/AFTER_NEW → `ScriptHost.resetAll()`.
- **Unmount = `worker.terminate()`** + host-side cleanup (forwarder subscriptions, cache entries, exposed-method registry rows, audit attribution).
- **Validation:** `validate` message to a short-lived scratch worker (same wrapper ⇒ syntax errors surface, nothing executes). **Delete `lib/scriptWorker.ts`.** Debugger `instrumentSource` works unchanged — it injects `context.log(...)`, which is an RPC.
- **Watchdog & faults:** per R18. `worker.onerror` → one free respawn; second crash within 30 s faults the script.

---

## 4. RPC protocol

`app/src/api/scriptHost/protocol.ts`. `PROTOCOL_VERSION = 1`, carried in MountSpec; mismatch = refuse mount. All payloads structured-clone data; `ImageBitmap` is the only transferable. One implicit port per worker; FIFO per port, so `mount` always precedes events.

```ts
// ---- host → worker ----
type H2W =
  | { t: "mount"; spec: MountSpec }                                  // once per worker
  | { t: "validate"; source: string }                                // scratch workers only
  | { t: "event"; hook: string; payload: unknown }                   // fire-and-forget
  | { t: "mirror"; path: string; value: unknown }                    // sync-getter state push (R15)
  | { t: "renderCells"; reqId: number;
      cells: { row: number; col: number; sheetIndex: number; value: string }[] }
  | { t: "renderDraw"; reqId: number;
      target: { kind: "shape" | "slicerItem"; key: string; item?: SlicerItem };
      w: number; h: number; dpr: number }
  | { t: "callResult"; callId: number; ok: boolean; value?: unknown; error?: RpcError }
  | { t: "methodCall"; callId: number; methodName: string; args: unknown[] } // relayed callMethod
  | { t: "ping"; seq: number };

interface MountSpec {
  protocolVersion: number;
  scriptId: string;
  objectType: ScriptableObjectType;
  instanceId?: string;
  tier: "restricted" | "unlocked";        // display + shim shaping; ENFORCEMENT IS HOST-SIDE
  capabilities: string[];                 // granted caps; display + shim shaping; ditto
  apiVersion: string;
  source: string;
  snapshot: { properties?: Record<string, unknown>;
              selection?: unknown };      // mirror seeds (workbook/shape/panel props, slicer selection)
}

// ---- worker → host ----
type W2H =
  | { t: "mounted"; ok: boolean; error?: string }
  | { t: "validated"; valid: boolean; error?: string }
  | { t: "call"; callId: number; method: string; args: unknown[] }   // EVERY api/object/cap/base call
  | { t: "hookRegistered"; hook: string }                            // subscription pruning
  | { t: "renderCellsResult"; reqId: number; styles: (StyleOverride | null)[] }
  | { t: "renderDrawResult"; reqId: number; bitmap: ImageBitmap | null }  // transferred
  | { t: "methodResult"; callId: number; ok: boolean; value?: unknown; error?: RpcError }
  | { t: "console"; level: "log" | "warn" | "error"; args: unknown[] }
  | { t: "error"; hook?: string; message: string; stack?: string }   // → objectscript:error
  | { t: "pong"; seq: number };

interface RpcError {
  code: "PermissionDenied" | "CapabilityRequired" | "ValidationError"
      | "Timeout" | "HostError" | "UnknownMethod";
  message: string;
  detail?: { capability?: string };   // lets scripts degrade gracefully / editor offer "request grant"
}
```

**Rules:**

1. **Calls:** `callId` monotonic per worker; host guarantees exactly one `callResult` per `call` (broker exceptions become `HostError`, never a hung promise). Worker-side safety timeout 30 s; backend invokes get class-based host deadlines (read 10 s, mutate 30 s, `bi.query` 120 s) — expiry rejects `Timeout`; the backend call is *not* cancelled (documented). In-flight cap: 32 per script; excess rejects `HostError{detail:"rpc-saturated"}`.
2. **Events:** fire-and-forget. The host forwards only hooks the worker declared via `hookRegistered` — scripts subscribing to 1–2 hooks never see CELL_VALUES_CHANGED traffic at all. Existing debounce (`cellEvents.ts:134`) kept. Per-worker outbound queue, high-water 256: coalesce-latest-per-key for `*Changed`/`onDataChange`/`onSelectionChange`/`onResize`; queue-all for discrete hooks (`onClick`, `onEdit`); overflow drops oldest + one `event{hook:"__overflow"}` so well-behaved scripts can resync.
3. **Render requests:** single-flight per worker per kind. New misses accumulate host-side while a request is in flight; flushed as the next batch on response. Stale `reqId` responses (post-invalidation) dropped. No response in 2 s → drop the in-flight flag, log once; cells render base-styled, shapes skip a frame (graceful degradation is the point).
4. **Filters move host-side:** the row/col/range/instance filtering currently inside context builders moves into the host's subscription table. Script-visible semantics identical.
5. **`methodCall` relay:** 5 s deadline; target resolution + `public:true` policy checked by the broker before relay.

---

## 5. Tier broker (S4)

`app/src/api/scriptHost/broker.ts` is the **only** module in the script path that imports `invokeBackend`. Scripts physically cannot reach `invoke` (wrong realm, no global, CSP-pinned); the broker is policy, the realm is mechanism.

**Enforcement per call, in order:** port → `{scriptId, tier, objectType, instanceId, grants}` from the host registry (never from the message) → method exists in ALLOWLIST (else `UnknownMethod`, audited) → static arg validation (shape, numeric finiteness, string-length caps — *before* tier check, so error messages can't probe) → tier check → instance scoping (R16: `object.*` dispatches on the mount-pinned instance; restricted sheet cell access clamped to the bound sheet) → capability check against grant store → limits → execute via `IMPL` → audit-ring append `{ts, scriptId, method, class, ok}` (ring 2000, rendered in the transparency panel).

### 5.1 Allowlist format

`app/src/api/scriptHost/allowlist.ts` — a typed TS const (C's delivery, B's schema). **This one object is consumed by (1) broker dispatch, (2) the transparency panel, (3) consent-dialog text** — the policy users see is the object the broker executes; drift is impossible.

```ts
export type Tier = "restricted" | "unlocked";
export type CapabilityId = "net.fetch" | "bi.query" | "storage" | "ui.html";
export type MethodClass = "read" | "mutate" | "emit" | "net";

export interface MethodPolicy {
  tier: Tier;                     // minimum tier ("restricted" = every script)
  capability?: CapabilityId;      // additionally required grant
  class: MethodClass;
  validate: (args: unknown[]) => true | string;
  limits?: Record<string, number>;
  desc: string;                   // rendered verbatim in panel + consent UI
}

export const ALLOWLIST: Record<string, MethodPolicy> = {
  // ---- base: every script ----
  "base.log":              { tier: "restricted", class: "emit",   validate: vAny,      desc: "Write to the script console" },
  "base.notify":           { tier: "restricted", class: "emit",   validate: vNotify,   desc: "Show a toast notification" },
  "base.expose":           { tier: "restricted", class: "emit",   validate: vExpose,   desc: "Expose a method to other scripts" },
  "base.unexpose":         { tier: "restricted", class: "emit",   validate: vUnexpose, desc: "Withdraw a method it had exposed to other scripts" },
  "base.callMethod":       { tier: "restricted", class: "emit",   validate: vCall,     desc: "Call a method exposed by another script (cross-tier requires the target to be public)" },
  "events.subscribe":      { tier: "restricted", class: "read",   validate: vHook,     desc: "Listen to its object's events" },
  // ---- own-object scope (instance pinned at mount; worker cannot name another instance) ----
  "object.getState":       { tier: "restricted", class: "read",   validate: vGetState, desc: "Read its own object's properties / selection / spec" },
  "object.setState":       { tier: "restricted", class: "mutate", validate: vSetState, desc: "Change its own object (slicer selection, shape properties, chart spec, panel badge, ...)" },
  "object.declareProperties": { tier: "restricted", class: "mutate", validate: vDecl,  desc: "Declare custom properties (shapes)" },
  "render.invalidate":     { tier: "restricted", class: "emit",   validate: vNone,     desc: "Request a re-render of its own visuals" },
  "render.setHtml":        { tier: "restricted", capability: "ui.html", class: "mutate", validate: vHtml, desc: "Render sandboxed HTML inside its shape",
                             /* ui.html auto-granted for local scripts; consent-gated for distributed */ },
  "sheet.getCellValue":    { tier: "restricted", class: "read",   validate: vCellRef,  desc: "Read cells on its own sheet (sheet scripts; clamped to the bound sheet)" },
  "sheet.setCellValue":    { tier: "restricted", class: "mutate", validate: vCellSet,  desc: "Write cells on its own sheet (sheet scripts; clamped to the bound sheet)" },
  // Bulk + typed own-sheet I/O (B1): same reach as the per-cell rows above, one
  // RPC per rectangle, values keep their type + formula, block write = 1 undo step.
  "sheet.getCellData":     { tier: "restricted", class: "read",   validate: vCellRef,  desc: "Read one cell on its own sheet with its type and formula" },
  "sheet.getRangeValues":  { tier: "restricted", class: "read",   validate: vRangeRef, limits: { maxCells: 100_000 }, desc: "Read a block of cells on its own sheet in one go (values, types and formulas)" },
  "sheet.setRangeValues":  { tier: "restricted", class: "mutate", validate: vRangeWrite, limits: { maxCells: 100_000 }, desc: "Write a block of cells on its own sheet in one go (a single undo step)" },
  // Own-sheet FORMATTING (B2): same clamped reach as the write rows above,
  // appearance instead of content. Protection attributes (locked /
  // formulaHidden) are NOT part of the format object.
  "sheet.setRangeFormat":  { tier: "restricted", class: "mutate", validate: vRangeFormat, limits: { maxCells: 100_000 }, desc: "Change how cells look on its own sheet (font, colour, alignment, number format, borders)" },
  "sheet.clearRangeFormat":{ tier: "restricted", class: "mutate", validate: vRangeRef, limits: { maxCells: 100_000 }, desc: "Remove all formatting from a block of cells on its own sheet (the values are kept)" },
  // ---- unlocked: whole-workbook reach ----
  "api.getCellValue":      { tier: "unlocked", class: "read",   validate: vCellRef,  desc: "Read any cell" },
  "api.getCellData":       { tier: "unlocked", class: "read",   validate: vCellRef,  desc: "Read any cell with its type and formula" },
  "api.getRangeValues":    { tier: "unlocked", class: "read",   validate: vRangeRef, limits: { maxCells: 100_000 }, desc: "Read a block of cells on any sheet in one go (values, types and formulas)" },
  "api.setCellValue":      { tier: "unlocked", class: "mutate", validate: vCellSet,  desc: "Write any cell" },
  "api.updateCellsBatch":  { tier: "unlocked", class: "mutate", validate: vBatch,    limits: { maxCells: 100_000 }, desc: "Write many cells at once" },
  "api.getSheetNames":     { tier: "unlocked", class: "read",   validate: vNone,     desc: "List sheets" },
  "api.getActiveSheet":    { tier: "unlocked", class: "read",   validate: vNone,     desc: "Read the active sheet" },
  "api.setActiveSheet":    { tier: "unlocked", class: "mutate", validate: vIndex,    desc: "Switch sheets" },
  "api.emitEvent":         { tier: "unlocked", class: "emit",   validate: vEvent,    desc: "Emit a custom app event (auto-namespaced userscript:*)" },
  "api.executeCommand":    { tier: "unlocked", class: "mutate", validate: vCommand,  desc: "Run commands flagged scriptSafe by their extension" },
  "api.beginBatch":        { tier: "unlocked", class: "mutate", validate: vNone,     desc: "Group changes for undo" },
  "api.commitBatch":       { tier: "unlocked", class: "mutate", validate: vNone,     desc: "Commit a grouped change" },
  "api.cancelBatch":       { tier: "unlocked", class: "mutate", validate: vNone,     desc: "Cancel a grouped change" },
  // ---- unlocked: formatting + structure (B2). Whole-workbook reach is the bar
  //      api.setCellValue already sets, so no capability is involved: none of
  //      this touches anything outside the document. The structural commands are
  //      ACTIVE-SHEET-only in the backend, so an off-sheet sheetIndex REJECTS
  //      (it is never silently retargeted). ----
  "api.setRangeFormat":    { tier: "unlocked", class: "mutate", validate: vRangeFormat, limits: { maxCells: 100_000 }, desc: "Change how cells look on any sheet (font, colour, alignment, number format, borders)" },
  "api.clearRangeFormat":  { tier: "unlocked", class: "mutate", validate: vRangeRef, limits: { maxCells: 100_000 }, desc: "Remove all formatting from a block of cells (the values are kept)" },
  "api.insertRows":        { tier: "unlocked", class: "mutate", validate: vRowColOp, desc: "Insert rows, shifting everything below them down" },
  "api.deleteRows":        { tier: "unlocked", class: "mutate", validate: vRowColOp, desc: "Delete rows, shifting everything below them up (their contents are lost)" },
  "api.insertColumns":     { tier: "unlocked", class: "mutate", validate: vRowColOp, desc: "Insert columns, shifting everything to their right" },
  "api.deleteColumns":     { tier: "unlocked", class: "mutate", validate: vRowColOp, desc: "Delete columns, shifting the rest left (their contents are lost)" },
  "api.mergeCells":        { tier: "unlocked", class: "mutate", validate: vRangeRef, desc: "Merge a block of cells into one (only the top-left value is kept)" },
  "api.unmergeCells":      { tier: "unlocked", class: "mutate", validate: vCellRef,  desc: "Split a merged block back into individual cells" },
  "api.setRowHeight":      { tier: "unlocked", class: "mutate", validate: vDimension, desc: "Change a row's height" },
  "api.setColumnWidth":    { tier: "unlocked", class: "mutate", validate: vDimension, desc: "Change a column's width" },
  "api.freezePanes":       { tier: "unlocked", class: "mutate", validate: vFreeze,   desc: "Freeze (or unfreeze) rows and columns so they stay on screen while scrolling" },
  "api.addSheet":          { tier: "unlocked", class: "mutate", validate: vSheetName, desc: "Add a new sheet to the workbook" },
  "api.deleteSheet":       { tier: "unlocked", class: "mutate", validate: vIndex,    desc: "Delete a sheet and everything on it" },
  "api.renameSheet":       { tier: "unlocked", class: "mutate", validate: vSheetRename, desc: "Rename a sheet" },
  "api.setSheetVisibility":{ tier: "unlocked", class: "mutate", validate: vSheetVisibility, desc: "Show or hide a sheet" },
  "api.sortRange":         { tier: "unlocked", class: "mutate", validate: vSortRange, desc: "Sort a block of cells by one or more columns" },
  "api.findAll":           { tier: "unlocked", class: "read",   validate: vFind,     desc: "Find every cell on the active sheet matching a search text" },
  "api.replaceAll":        { tier: "unlocked", class: "mutate", validate: vReplace,  desc: "Replace a search text everywhere on the active sheet (a single undo step)" },
  // ---- unlocked: workbook OBJECTS (B3) — the "build a dashboard from code"
  //      surface. Charts, tables, pivots, names, slicers and form controls all
  //      live INSIDE the document, so this is the same whole-workbook reach the
  //      rows above already have — no capability. api.objectGetState /
  //      api.objectSetState dispatch through the SAME aspect executors as the
  //      restricted-tier object.getState/object.setState, with an explicit
  //      target id; only these unlocked rows can supply one, so a restricted
  //      script stays pinned to its mount instance. ----
  "api.listObjects":       { tier: "unlocked", class: "read",   validate: vObjectKind, limits: { maxObjects: 5_000 },
                             desc: "List the charts, tables, pivot tables, named ranges, slicers or form controls in this workbook (names and positions, never their contents)" },
  "api.createChart":       { tier: "unlocked", class: "mutate", validate: vCreateChart, desc: "Add a new chart to a sheet" },
  "api.deleteChart":       { tier: "unlocked", class: "mutate", validate: vObjectId,    desc: "Delete a chart" },
  "api.createTable":       { tier: "unlocked", class: "mutate", validate: vCreateTable, desc: "Turn a block of cells into a table (with filter buttons and a header row)" },
  "api.deleteTable":       { tier: "unlocked", class: "mutate", validate: vObjectId,    desc: "Delete a table (the cells and their values are kept)" },
  "api.createNamedRange":  { tier: "unlocked", class: "mutate", validate: vCreateNamedRange, desc: "Create a named range (a name that formulas can use for a block of cells)" },
  "api.deleteNamedRange":  { tier: "unlocked", class: "mutate", validate: vNamedRangeName,   desc: "Delete a named range (formulas using the name will break)" },
  "api.createPivot":       { tier: "unlocked", class: "mutate", validate: vCreatePivot, desc: "Create a pivot table over a block of cells and lay out its fields" },
  "api.deletePivot":       { tier: "unlocked", class: "mutate", validate: vObjectId,    desc: "Delete a pivot table" },
  "api.objectGetState":    { tier: "unlocked", class: "read",   validate: vObjectAspect, desc: "Read another object in this workbook (its chart spec, table cells, slicer selection, ...)" },
  "api.objectSetState":    { tier: "unlocked", class: "mutate", validate: vObjectAspect, desc: "Change another object in this workbook (its chart spec, slicer selection, pivot layout, shape properties, ...)" },
  // ---- capabilities (grantable to restricted scripts via consent / JIT) ----
  "cap.fetch":             { tier: "restricted", capability: "net.fetch", class: "net",
                             validate: vFetch, limits: { maxResponseBytes: 5_242_880, perMinute: 10 },
                             desc: "Fetch from the granted web origins (https only, no cookies)" },
  "cap.biQuery":           { tier: "restricted", capability: "bi.query", class: "net",
                             validate: vSql, limits: { maxRows: 100_000 },
                             desc: "Run read-only queries on this workbook's BI connections" },
  "cap.storageGet":        { tier: "restricted", capability: "storage", class: "read",
                             validate: vKey, desc: "Read script-private data stored in the workbook" },
  "cap.storageSet":        { tier: "restricted", capability: "storage", class: "mutate",
                             validate: vKV, limits: { maxBytes: 262_144 },
                             desc: "Store script-private data in the workbook (quota 256 KB)" },
};
```

`IMPL` (in `broker.ts`) absorbs today's `buildUnlockedAPI` + per-type context builders, minus the closures — the realm handle carries `objectType`/`instanceId`. `storage` paths are broker-rewritten to `.calcula/script-data/<scriptId>/…` on the virtual FS; scripts can never name paths.

**Policy reshapes carried by the broker:** R5 (`userscript:` namespacing, symmetric), R6 (`scriptSafe` opt-in + args fix), R7 (`public:true` for cross-tier `callMethod`; host registry replaces `globalExposedMethods`).

---

## 6. Render hooks — data-only protocols (the S2 hard part)

The render loop **never** crosses the worker boundary. Zero changes to Core: `cells.ts:585/729` and `styleInterceptors.ts` are untouched (Alien rule intact).

### 6.1 Cell `onRender` — SWR style cache (signature preserved)

- The bridge registers **one** style interceptor per script through the existing `registerStyleInterceptor(..., 1000)`. Its body:
  ```ts
  (value, baseStyle, coords) => {
    const hit = cache.get(scriptId, coords.sheetIndex, coords.row, coords.col);
    if (hit !== undefined) return hit.style;   // StyleOverride | null — even if marked stale
    missQueue.add(coords);                     // flushed once per animation frame
    return null;                               // base style this frame
  }
  ```
- Per-rAF flush: missed cells (visible viewport + one-screen prefetch margin, ~1–3k cells max) go out as **one** `renderCells` batch; the worker maps the user's unchanged `onRender({row, col, sheetIndex, value, formula: null})` over them; results fill the cache; host triggers one repaint.
- **Invalidation = stale-while-revalidate:** on CELL_VALUES_CHANGED, affected keys keep serving the old override while marked stale and re-batched (no flicker — this is why A's scheme beat C's value-in-key). THEME_CHANGED and remount clear fully. `context.render.invalidate()` clears the script's entries (escape hatch for closure-state renderers). LRU cap 50k entries per script.
- **Contract addition in `objectContexts.d.ts`:** *`onRender` must be a pure function of `(value, coords)`; results are cached.* Impure renderers degrade to stale styling, never to breakage.
- Steady-state cost beats today: one `Map.get` per cell per frame instead of one user-code call per cell per frame.
- *(Deferred, post-Wave-2: B's declarative `style.rules()` StyleProgram as a zero-script-code fast path; nothing here forecloses it.)*

### 6.2 Slicer `style.itemRenderer` + shape `render.canvasRenderer` — OffscreenCanvas bitmaps (user code unchanged)

- Worker, on `renderDraw`: `new OffscreenCanvas(w*dpr, h*dpr)` → 2D context → `scale(dpr,dpr)` → call the **unchanged** user function (`(ctx, bounds)`; slicer items also get `item`) → `transferToImageBitmap()` → transfer to host. Full Canvas2D fidelity — `measureText`, gradients, paths all real.
- Host: `shapeRenderer.ts:413` and `slicerRenderer.ts:364` change from "call user fn" to "drawImage(cachedBitmap)" inside `save()/translate(bounds)/clip(bounds)/restore()` — a script can never paint outside its region. Missing bitmap → single-flight request, skip this frame.
- **Invalidation:** shapes — `shape:propertyChanged`, watched-cell `onCellChange`, resize, `render.invalidate()`. Slicer items — bitmap cache keyed `(slicerId, text, selected, hasData, w, h)`, so state changes self-invalidate; `render.invalidate()` clears all.
- Animation: not per-frame in v1; `render.invalidate()` from an ambient timer gets best-effort ~60 fps via single-flight coalescing. Documented.

### 6.3 Shape `setHtmlContent` — S6 interaction (Phase 0 quick win)

- Drop `allow-same-origin` (keep `allow-scripts`) at `shapeRenderer.ts:175` and `PropertiesPane.tsx:607` → opaque origin; iframe cannot script the parent, gets no app-origin storage/fetch authority.
- The `window.calcula.sendMessage` bridge stays `postMessage`; iframe side uses `targetOrigin:"*"`; parent keeps filtering by `controlId` (`shapeRenderer.ts:28`).
- Fix the injection bug: embed `controlId` via `JSON.stringify` (replaces single-quote-only escaping at `buildIframeSrcDoc`, `shapeRenderer.ts:128`).
- For distributed scripts the whole feature is gated by the `ui.html` capability (R17).

---

## 7. Backend defense-in-depth — window-label guards

`app/src-tauri/src/security/window_guard.rs` — **data-driven** (R11):

```rust
// Map: command name -> allowed window labels. Absent = unrestricted (default-allow for
// the long tail; the dangerous set below is explicitly listed).
pub fn require_label(webview: &tauri::Webview, allowed: &[&str]) -> Result<(), String> {
    let label = webview.label();
    if allowed.contains(&label) { Ok(()) }
    else { Err(format!("command not permitted from window '{label}'")) }
}
```

Thread `webview: tauri::Webview` + a `require_label(&webview, &[...])?` first line into the **dangerous set** (authority-map §4; precedent for the param: `pivot/commands.rs:294`):

- **Main-only:** persistence FS group (`read_text_file`, `write_text_file`, `write_binary_file`, `save_file`, `open_file`, `new_file`, `auto_recover_save`, `set_auto_recover_settings`), `run_script`, `set_script_security_level`, `grant_script_session_approval`, `notebook_*` exec, all `mcp_*`, all `calp_*` (incl. audit toggles), `bi_create_connection`/`bi_connect`/`bi_bind_table`/`bi_refresh_connection`/`bi_query`, `scan_extension_directory`/`get_extensions_directory`, virtual-file commands, new `script_http_fetch`.
- **Exception rows:** object-script CRUD (`save_object_script`, `delete_object_script`, templates) → `["main", "object-script-editor"]` — **verified:** `ObjectScriptEditorApp.tsx` saves from its own window via `objectScriptBackend.ts:80`; a blanket `require_main` would break the editor.
- **Exception rows (added 2026-07, Model Editor window):** all `bi_model_*` commands plus `bi_get_connections`/`bi_get_connection` → `["main", "model-editor"]` (`MAIN_AND_MODEL_EDITOR`) — the standalone Model Editor window authors BI models from its own webview. Reads are guarded too: `bi_model_get_overview` returns the full model *including RLS role definitions*, which the inert chart-spec/object-script windows must not be able to exfiltrate. The same commands are additionally denylisted under `biData` in `PRIVILEGED_BACKEND_COMMANDS`, so non-trusted extensions cannot reach them through the governed invoke door either. See `docs/design/model-editor.md`.

~60–70 mechanical signature edits across ~8 command modules. This makes the two Monaco editor windows (`chart-spec-editor`, `object-script-editor`) actually as inert as their capability files imply — today they can call all 525 custom commands — and it survives any frontend compromise. It does **not** constrain object scripts (their workers live in `main`); that is the broker's job. Two mechanisms, two axes, neither substitutes for the other.

---

## 8. C9 capability model + consent integration

**Tier vs capability (B's framing, adopted):** tier = workbook data-plane reach (cells, commands). Capability = ambient-world reach (network, BI, storage, HTML UI). A distributed *restricted* subscriber script can hold `bi.query` (the .calp live-data scenario) without ever gaining cell-write.

| Capability | API (worker shim) | Enforcement | Limits | Default |
|---|---|---|---|---|
| `net.fetch` | `context.caps.fetch(url, init) → Promise<{status, headers, text(), json()}>` | Broker → Rust `script_http_fetch` (reqwest, `require_label` main): **origin re-checked in Rust** against the backend grant store, https only, no credentials/cookies | 5 MB response, 30 s, 10 req/min/script; audited with URL | denied |
| `bi.query` | `context.caps.biQuery(sql) → Promise<rows>` | Broker rejects non-SELECT (CTE-only allowed) → existing `bi_query` (`bi/commands.rs:867`); workbook connections only, never connection management | 100k rows, 120 s | denied |
| `storage` | `context.caps.storage.get/set(key, value)` | Broker rewrites paths to `.calcula/script-data/<scriptId>/…` (virtual FS); scripts cannot name paths | 256 KB quota | prompt (JIT) |
| `ui.html` | gates `render.setHtmlContent` | Broker | — | local: auto; distributed: consent |
| `ui.dialog` | `context.caps.dialog.alert/confirm/prompt/form(...)` → awaitable answer | Broker → `scriptHost/scriptDialogs.ts` → a TRUSTED React modal (`ScriptDialogPrompt`). The script sends a DECLARATIVE spec (no markup, no iframe); the header states which script is asking, so a dialog cannot imitate the app | one dialog per script AND one app-wide (a second rejects, never queues); 3 consecutive dismissals mute the script for the session; 5-min deadline that resolves as *dismissed* | prompt (JIT) |
| *(timers)* | ambient `setTimeout`/`setInterval` in-worker | Worker shim caps (not a grant — R8) | 16 ms min interval, ≤32 live | always (listed informationally in panel) |

**Declaration:** source pragma, parsed at registration:
```
// @capability net.fetch https://api.example.com https://other.example.com
// @capability bi.query
```
`calp_publish` lifts pragmas into the package manifest `capabilities` field (near the provenance handling, `publish.rs:237`); `calp_pull`/inspect surfaces them pre-consent. The broker rejects any capability use not declared in the *current* source's pragmas, even if a stale grant record exists.

**Grant storage:**
- **Distributed:** `ConsentRecord` (`consentStore.ts`) gains `grantedCapabilities: CapabilityGrant[]` — rides the existing SHA-256 source-hash keying (`:29,82`), so a code swap *or* capability expansion automatically re-prompts and revokes.
- **Local:** JIT dialog on first `CapabilityRequired` denial — "Script X requests network access to api.example.com — Allow once / Always / Deny"; "Always" persists to a local-grants record in the same store.
- **`net.fetch` origin lists are mirrored to a backend store** (`scripting/capability_store.rs`), written only on consent-grant from the main window. `script_http_fetch` validates against that store in Rust and never trusts frontend args.

**Consent dialog (`ScriptConsentDialog.tsx`) per package:** tier line ("Restricted — can only affect its own object"), each requested capability with its ALLOWLIST `desc` + params (origins listed verbatim), sandbox copy ("runs isolated; no file, network, or system access beyond what's listed"), **signature status row** (S5 slot: `unsigned | signed: <publisher> | invalid` — rendered now, fed by S5 later), and the existing inspect-source affordance (`index.ts:150` path). Granting consent = mounting + recording grants.

**Transparency panel** (`PermissionsPanel.tsx`, registered via the sections-based panel API): per mounted script — name, target object, tier, capabilities + params, provenance/package, source hash, faulted status + re-enable, [Inspect]; the static tier→method table rendered directly from `ALLOWLIST`; the broker audit tail (last 2000 calls). The vision's "user always knows where code resides and what it can touch," made literal.

---

## 9. Migration table — every existing context API

Legend: **AS-IS** = same signature, transport swapped. **MIRROR** = sync getter preserved via host-pushed snapshots. **RESHAPE** = script-visible change. **FIX** = pre-existing bug fixed. **WIRE** = dead hook given a real emitter. **PRUNE** = dead surface deleted (no back-compat duty, verified no emitters).

| API | Verdict | Notes |
|---|---|---|
| `base.objectType/accessLevel/apiVersion` | AS-IS | static in MountSpec |
| `base.expose(name, fn)` | AS-IS (+ optional `{public: true}`) | host registry replaces `globalExposedMethods` |
| `base.callMethod(...)` | **RESHAPE** | returns `Promise<unknown>` (already-`await`ing scripts unaffected); cross-tier requires target `public:true` (R7) |
| `base.log` / `notify` | AS-IS | fire-and-forget RPC; `objectscript:console` path unchanged |
| `api` (null when restricted) | AS-IS | shim withholds it; enforcement now host-side (real boundary) |
| `api.getCellValue/setCellValue/updateCellsBatch/getSheetNames/getActiveSheet/setActiveSheet/beginBatch/commitBatch/cancelBatch` | AS-IS | already async; broker-mapped 1:1 |
| `api.executeCommand` | **RESHAPE + FIX** | `scriptSafe`-flagged commands only (R6); args bug fixed (`commands.ts:149`) |
| `api.emitEvent` / `onEvent` | **RESHAPE (transparent)** | symmetric `userscript:` namespacing (R5); custom-name usage unchanged; `onEvent` also gets a read-only allowlisted `AppEvents` subset |
| workbook `onOpen/onAfterSave/onSheetChange/onThemeChange` | AS-IS | same emit sites (`file-api.ts:30–75`, `Layout.tsx:246`, `theme.ts:43`) |
| workbook `onBeforeSave/onBeforeClose` | **CANCELLABLE (B5)** | replying hooks, not notifications: the save path (`file-api.ts`) and the close path (`Layout.tsx`) `await` a verdict through the core lifecycle-guard registry (`core/lib/lifecycleGuards.ts`). Per-script deadline 3s, **default-ALLOW** on timeout/throw/unmount — a hung script must never be able to make a workbook unsaveable or the app unclosable. Cancellations are reported to the user, attributed by script name. |
| workbook `properties` | MIRROR | already cache-based today (`scriptableObjects.ts:1093`) |
| sheet `onActivate/onDeactivate/onSelectionChange/onDataChange` | AS-IS | filters move into the host subscription table |
| sheet `getCellValue/setCellValue` | AS-IS | already async; restricted scripts clamped to bound sheet (R16) |
| cell `onEdit/onSelect/onEditEnd` | AS-IS | enrich EDIT_ENDED payload (`committed`, `sheetIndex`) while touching `useEditing.ts` |
| cell `onEditStart` | **WIRE** | one `emitAppEvent(AppEvents.EDIT_STARTED)` in `useEditing.ts` — constant exists (`events.ts:46`), emitted nowhere today |
| cell `onRender` | **RESHAPE (internal only)** | §6.1 SWR cache; signature identical; purity contract + `render.invalidate()` |
| row/column `onInsert/onDelete/onResize` | AS-IS + **FIX** | emit payloads gain `sheetIndex`, `row/col`→`startRow/startCol` (`Spreadsheet.tsx:565/605/645/686`) |
| slicer `onSelectionChange` | AS-IS | |
| slicer `onDataRefresh` / `onResize` | **PRUNE** | verified: `slicer:dataRefreshed` has zero emitters |
| slicer `getSelectedItems` | MIRROR (stays sync) | seeded + updated via `slicer:selectionChanged` |
| slicer `setSelectedItems/clearSelection/selectAll`, `style.setProperty`, `properties` | AS-IS | via `object.setState` wire collapse |
| slicer `style.itemRenderer` | **RESHAPE (internal)** | §6.2 OffscreenCanvas; user code unchanged; runs on change, not per-frame |
| chart `onDataChange` | AS-IS | range filter evaluated host-side from spec |
| chart `onClick` / `onResize` | **PRUNE** | dead |
| chart `getSpec` / `updateSpec` / `style.setProperty` | MIRROR / AS-IS / AS-IS | |
| pivot `onRefresh` | **FIX (wire)** | subscribe to `pivot:refresh` — 15+ live emitters verified (FilterPane, Slicer bridge, Pivot menus); today's name is wrong |
| pivot `onLayoutChange` / `onResize` | **PRUNE** | dead |
| pivot `getFields` / `refresh` | MIRROR / AS-IS | |
| shape `onClick/onResize/onPropertyChange/onCellChange` | AS-IS | live emitters confirmed |
| shape `getProperty` | MIRROR (stays sync) | already cache-based (`:1725`) |
| shape `setProperty` / `declareProperties` / `getCellValue(A1)` | AS-IS | |
| shape `render.canvasRenderer` | **RESHAPE (internal)** | §6.2 |
| shape `render.setHtmlContent` | AS-IS + **FIX** + cap | §6.3 sandbox + escaping; `ui.html` for distributed |
| shape `render.sendMessage/onMessage` | AS-IS | host relays iframe postMessage both ways |
| panel hooks + `open/close/setBadge/moveTo`, `properties` | AS-IS / MIRROR | all live from shell |
| button/textbox/timeline | AS-IS | base-only |
| `scriptWorker.ts` validation | **DELETE** | `validate` to a scratch worker (§3) |
| Debugger `instrumentSource` | AS-IS | injects `context.log` → RPC |
| `loadRuntimeExtension(url)` | **DELETE** | caller-less (S8) |
| `objectContexts.d.ts` | UPDATE | `callMethod` → Promise; purity note; `render.invalidate`; `caps.*`; pruned hooks removed; split an accurate `RestrictedContext` view so IntelliSense stops advertising `api.*` to restricted scripts |

---

## 10. S3/S10 flip sequence (ordered; each step independently shippable)

1. **e2e config overlay (prove the merge first):** add `app/src-tauri/tauri.e2e.conf.json` = `{ "app": { "withGlobalTauri": true } }`; change the spawn at `app/e2e/global-setup.ts:121` to `spawn("yarn", ["tauri", "dev", "--", "--config", "src-tauri/tauri.e2e.conf.json"], ...)`. Run the full suite with the base config still `true` — a no-op run that proves the merge path. **Zero churn across the 337 `page.evaluate` call sites**, and the override is structurally impossible to ship (dev-merge config, not in the bundle).
2. **S3 — flip `withGlobalTauri: false`** (`tauri.conf.json:13`, currently `true` — verified). Nothing in the shipping app breaks: zero `__TAURI__` consumers in `app/src` / `app/extensions`; the two editor windows use bundled ESM imports. Smoke: prod build, all 3 windows, regression walker, full e2e (now via the overlay).
3. **S10 — CSP v1** (`tauri.conf.json:26`):
   ```
   default-src 'self'; script-src 'self' blob: 'unsafe-eval'; worker-src 'self' blob:;
   img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self';
   connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' blob:;
   object-src 'none'; base-uri 'self'
   ```
   plus `security.devCsp` adding `http://localhost:5173 ws://localhost:5173` for HMR. **This step alone kills script exfiltration and remote code injection today**, before S2 lands. `'unsafe-eval'` stays only while `compileObjectScript` (until Phase 3) and `chartTransforms.ts:307` need it. Verify per mechanism: blob extension import (`ExtensionManager.ts:504`), the Monaco worker setups (build emits URL chunks → `worker-src 'self'`; dev uses blob → covered), shape iframes, `data:` cursors, all 3 HTML entries (`vite.config.ts:32–38`).
4. **Rust window-label guards** (§7) — independent; land in the same wave so the editor windows are closed before publicizing .calp.
5. **CSP v2** (after Phase 3 + chartTransforms blob-import migration): drop `'unsafe-eval'`. From here, even a total broker bypass cannot eval in the page; worker-inherited CSP blocks remote `import()`/`fetch` from script realms; the only network door is `script_http_fetch` behind Rust-checked grants.

---

## 11. Implementation plan — phases and files (each phase leaves the app shippable)

### Phase 0 — Hygiene (~1 day)
Emit-payload fixes (`Spreadsheet.tsx:565/605/645/686`, `useSpreadsheetSelection.ts` if resize payloads); wire EDIT_STARTED (`useEditing.ts`); fix pivot subscription name → `pivot:refresh` (`scriptableObjects.ts`); `executeCommand` args fix (`commands.ts:149`); iframe sandbox + `controlId` escaping (`shapeRenderer.ts:175/128`, `PropertiesPane.tsx:607`); prune dead hooks from `objectContexts.d.ts`, `scriptableObjects.ts`, `scriptableObjectScaffolds.ts`; delete `loadRuntimeExtension` (`shell/registries/ExtensionManager.ts`). *No script-visible breakage beyond pruned-dead surface.*

### Phase 1 — S3 flip + CSP v1 + window guards (~2–3 days)
**New:** `app/src-tauri/tauri.e2e.conf.json`; `app/src-tauri/src/security/window_guard.rs`. **Changed:** `tauri.conf.json` (flip + CSP v1 + devCsp), `app/e2e/global-setup.ts` (one line), `lib.rs` + ~8 command modules (`persistence.rs`, `scripting/commands.rs`, `scripting/object_script_commands.rs`, `mcp/mod.rs`, `calp_commands.rs`, `bi/commands.rs`, extension/virtual-file modules) — thread `Webview` + `require_label` per §7 map. *Gate: full e2e + all 4 windows + walker.*

### Phase 2 — Broker on main thread (~3–4 days; A's sequencing insight)
The broker mediates every sanctioned context call while execution stays `new Function` on the main thread — policy lands and soaks before the realm does.
**New:** `app/src/api/scriptHost/allowlist.ts`, `broker.ts`, `validators.ts`, `auditRing.ts`; `app/extensions/ScriptableObjects/components/PermissionsPanel.tsx`. **Changed:** `scriptableObjects.ts` (context builders route through broker; expose/callMethod registry with `public` flag; emitEvent namespacing), `commands.ts` (`scriptSafe` metadata + flag pass over built-in registrations), `events.ts` (namespace helper). *Gate: soak/walker; new oracle: "no backend invoke from the script path without an audit entry."*

### Phase 3 — Worker realm (S2 core, ~2 weeks)
Render machinery first (testable while scripts still run on main thread), then flip execution behind a temporary env flag `CALCULA_SCRIPT_WORKER=1`; flag deleted at phase end (no back-compat).
**New:** `app/src/api/scriptHost/protocol.ts`, `host.ts` (spawn/terminate/watchdog/fault registry/event forwarding with `hookRegistered` pruning/mirror pushes/single-flight render plumbing), `renderCache.ts` (style SWR + bitmap caches + interceptor fn), `worker/bootstrap.ts` (hardening, blob-import compile, dispatch), `worker/contextShims.ts` (typed per-objectType surface over `object.*`/`api.*` RPC, mirror caches, OffscreenCanvas draw), `index.ts` (facade). **Changed:** `scriptableObjects.ts` (gut ~60%: delete `compileObjectScript`, `buildObjectContext` + builders, `globalExposedMethods`; keep registry/consent/public manager surface — `registerScript/mountScript/...` unchanged so `ScriptableObjects/index.ts`, editors, auto-template are barely touched), `Controls/Shape/shapeRenderer.ts` + `Controls/index.ts` (bitmap blit wiring), `Slicer/rendering/customRenderers.ts` + `slicerRenderer.ts` (bitmap blit), `CodeEditorDialog.tsx` + `ObjectScriptEditorApp.tsx` (validate via host), `objectContexts.d.ts` + scaffolds. **Deleted:** `lib/scriptWorker.ts`. Core `cells.ts`/`styleInterceptors.ts`: **zero changes**. *Gate: dual-run soak cycle (old path vs worker path) before deleting the flag; visual regression on slicer/shape custom renderers.*

### Phase 4 — C9 capabilities + consent (~1 week)
**New:** `app/src-tauri/src/net_commands.rs` (`script_http_fetch`), `app/src-tauri/src/scripting/capability_store.rs`, `app/src/api/scriptHost/capabilities.ts` (grant resolution, JIT dialog hook), `worker/capabilityShims.ts` (caps.fetch/biQuery/storage). **Changed:** `consentStore.ts` (`grantedCapabilities`), `ScriptConsentDialog.tsx` (capabilities + signature-status row), `ScriptableObjects/index.ts` (JIT grant listener), `object_script_commands.rs` (declared-capabilities field), `core/calp/src/publish.rs` + `pull.rs` + `calp_commands.rs` (manifest capabilities, inspect surfacing), `allowlist.ts` (cap entries live), `objectContexts.d.ts` + scaffolds (`caps.*`), `PermissionsPanel.tsx` (grants + revoke). *Gate: e2e consent-flow specs; pragma-tamper re-prompt test.*

### Phase 5 — CSP v2 (~1–2 days)
**Changed:** `extensions/Charts/.../chartTransforms.ts` (`new Function` → blob ESM import), `tauri.conf.json` (drop `'unsafe-eval'`). *Gate: charts visual regression + full suite.*

**Totals:** ~15 new files, ~30 changed, 2 deleted.

---

## 12. S5 / S6 / S7 interaction points

- **S5 (signing):** the consent dialog's signature-status row (`unsigned | signed: <publisher> | invalid`) ships **now**, render-only; S5 wires verification later. The grant/allowlist data formats already key cleanly off publisher identity for future auto-grant profiles (e.g., `signedBy:<publisher>` → pre-approved capability sets). Until provenance wiring lands, pulled scripts remain forced-Restricted (existing `pull.rs:161–165` behavior, kept).
- **S6 (iframes):** the `allow-same-origin` drop + `JSON.stringify` escaping ship in Phase 0; CSP `frame-src` constrains srcdoc descendants; `ui.html` capability gates the feature for distributed scripts from Phase 4.
- **S7 (MCP):** all `mcp_*` commands become main-window-only via the Phase 1 guards; bearer-token auth for the localhost MCP server stays in S7's own scope (design hook noted). MCP-initiated mutations share the broker audit ring, so they appear in the same transparency panel — one place to see everything that touched the workbook.

---

## 13. Top 5 implementation risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **WebView2 platform behaviors:** blob `import()` inside a module worker under the page CSP; `OffscreenCanvas` + `transferToImageBitmap` in workers. Either failing reshapes §3/§6.2. | **Day-1 spike** (half a day, before any Phase 3 code): a throwaway worker exercising both under CSP v1. Fallbacks pre-designed: compile via `new Function`-in-worker (B's route — CSP v2 slips but security is unaffected, since the realm has no authority either way); canvas via A's display-list record/replay. |
| 2 | **Broker IMPL behavioral drift** vs today's context builders (filters, payload shapes, edge cases) silently breaking existing scripts. | Phase 2 lands the broker on the main thread *first* — same execution model, only mediation changes — and soaks under the walker + bug-ledger regression runs before the realm flip; Phase 3 dual-runs old/new paths for one soak cycle; the audit oracle catches unmediated calls. |
| 3 | **onRender purity violations** in existing scripts (closure state) degrade to stale styles that look like "my script stopped working." | SWR never shows *wrong-flash*, only stale; `render.invalidate()` escape hatch; purity contract in `.d.ts` + scaffolds; transparency panel surfaces per-script stale/recompute counters so the cause is diagnosable in seconds. |
| 4 | **Window-label guards breaking legitimate secondary-window flows** (the verified `save_object_script`-from-editor case generalizes: more exceptions may lurk). | Data-driven label map makes exceptions one-line, reviewable data; before enabling, run the full e2e suite + manual pass over all 4 windows with guards in log-only mode (warn, don't deny) for one cycle, then enforce. |
| 5 | **e2e fleet breakage on the S3 flip** (337 `page.evaluate` sites depend on `__TAURI__`). | Step-1 ordering in §10: land the `--config` overlay and run the *entire* suite while the base config is still `true` — proves the merge with zero risk; only then flip. The overlay is dev-only and cannot ship. |

---

## 14. Residual risks accepted (named, so future-you knows they were chosen)

1. `'unsafe-eval'` remains in the page CSP until Phase 5; mitigated meanwhile by locked `connect-src` (no exfiltration) and no-authority realms. **[RESOLVED Wave 3 / §0: CSP v2 shipped — `'unsafe-eval'` is dropped from both `csp` and `devCsp`.]**
2. Unlocked scripts can do anything `scriptSafe` commands + cell APIs allow — that is the *meaning* of unlocked; it is user-consented, and distributed scripts can never reach it (backend-enforced, `object_script_commands.rs:218–227`).
3. One async tick of base styling on first paint of never-rendered cells (§6.1 cache miss). Edits never flash (SWR).
4. A `Timeout`-rejected backend call is not cancelled server-side (documented).
5. Third-party *extensions* (`scan_extension_directory` → blob import) still run fully trusted in the host realm — that is Wave 3 (extension sandboxing), not object scripts; the window guards at least stop secondary windows from triggering loads. **[Wave 3 Phase A done / §0: distributed extensions are now trust-classified, ceiling-bounded (deny-by-default), and transparency-tracked; browser-`fetch` is CSP-contained. Runtime isolation of their direct Tauri access = Phase B (deferred).]**
6. B's `style.rules()` StyleProgram fast path deferred post-Wave-2 (R3).
7. ~~The `codeInventory` "reach" for grid-only surfaces is asserted, not verified
   against the interpreter.~~ **[RESOLVED — see §0 "Transparency: the reach claim
   is DERIVED, not asserted". The claim is now derived from
   `core/script-engine/src/manifest.rs`, which is itself diffed against the live
   registered QuickJS surface, and the per-surface part is proven behaviourally
   (with no `ModelDataProvider` injected, every `model.*` op throws).]**
8. The writeback-validator harness leaves the hidden `__calcula_model_*` /
   `__calcula_display_table` native sinks undeleted. They are inert on that
   surface — the model sinks throw because no `ModelDataProvider` is injected,
   and the display sink can only append an output item the nonce-prefixed verdict
   reader ignores — but deleting them would be strictly stronger defence in
   depth. Accepted for now and **pinned**: `interpreterReachDrift.test.ts`
   acknowledges exactly these seven names, so any NEW realm global fails the
   build until it is deleted or classified.

**Net effect:** restricted .calp scripts go from "full `window.__TAURI__` + DOM + fetch with a UX-only tier flag" to: opaque per-script worker realm, no Tauri, CSP-pinned network, data-only render protocols, every privileged call broker-checked against user-visible policy data, every grant declared, consented, Rust-re-checked where it matters, and auditable in one panel — while existing subscriber scripts keep compiling against the same `objectContexts.d.ts` minus one `await`.

**Net concept count a maintainer must hold:** worker-per-script, one protocol file, one allowlist table, two render caches, one Rust guard function, one Rust fetch command. Everything else is today's code relocated or deleted.