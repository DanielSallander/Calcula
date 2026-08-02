# Backend Facade & Capability Model (A3)

Design spike for the architecture audit's deepest seam: the Rust backend is a
**feature-monolith with no extension boundary**, reached through an untyped
`invokeBackend(cmd, args)` passthrough.

## The reality (verified 2026-06-27)

- `app/src-tauri` registers **569** `#[tauri::command]`s in one crate, including
  feature-specific modules (`chart_commands`, `conditional_formatting`,
  `data_validation`, `autofilter`, `grouping`, `pivot/`, `bi/`, …). There is no
  Rust-side IoC / plugin surface — a feature that needs backend logic adds a
  command directly. So "even built-in features are extensions / the grid is the
  kernel" is a **frontend-only** reality (now noted in `ARCHITECTURE.md`).
- The frontend door is `app/src/api/backend.ts` → `invokeBackend<T>(cmd, args) =
  invoke<T>(...)` — a zero-gating passthrough. ~229 typed wrappers exist, but
  raw `invokeBackend("string")` is also used: **44 extension files call ~90
  distinct commands by raw string across ~112 sites.**

### Who can reach the backend

| Caller | How it reaches the backend | Trust |
|---|---|---|
| Built-in extension | Compiled into the host bundle; imports `@api/backend` directly | trusted (kernel-adjacent) |
| Runtime 3rd-party extension | Blob-ESM `import()`; **no** `@api` global / import map — gets only the injected `ExtensionContext`, which exposes **no** raw backend access | untrusted |
| Object scripts / notebooks | Tier broker ALLOWLIST (already capability-gated) | per tier |

**Key finding:** third-party extensions are *already* constrained — they cannot
call `invokeBackend` at all. So the untyped passthrough is, today, a **built-in
(trusted) typing/maintainability** concern, not an open third-party hole. But the
architecture has **no declared capability boundary** for backend commands, so the
moment the `ExtensionContext` gains backend access (a real product need —
third-party features want data), there is nothing to scope it.

## Design: a governed, capability-scoped backend door

Mirror the script broker's "ALLOWLIST as data" pattern:

1. **Capability data (this slice).** `app/src/api/backendCommands.ts` declares the
   privileged command set — the "VBA-escape" surface (code execution, host
   filesystem, OS credentials, extension management, MCP server) plus the
   broker-routed **BI data** reads (`biData`: `bi_query`, `bi_get_connections`) —
   grouped by capability, with `assertExtensionMayInvoke(cmd, { trusted })`. A
   drift-guard test (`backendCommands.test.ts`) parses `generate_handler!` and
   asserts every privileged name still exists, so the registry can't go stale.
   Everything not listed is "feature-open" (the danger is concentrated in ~30
   commands, so a denylist of the dangerous beats an allowlist of the safe 540).

2. **Governed `ExtensionContext.invokeBackend` (DONE).** A *scoped* backend
   accessor is now part of the `ExtensionContext` the loader injects
   (`contract.ts`). `ExtensionManager.activateExtension` wires it via
   `createScopedInvokeBackend(trust === "trusted", invokeBackend)`
   (`backendCommands.ts`), so it runs `assertExtensionMayInvoke` with the
   extension's already-classified trust before the raw `invoke`. Built-ins pass
   everything; a third-party is denied privileged commands (and, later, gated per
   its declared-capability manifest — `computeExtensionCeiling` is not yet
   consulted). Gate failure surfaces as a rejected promise, never a sync throw.
   The trust-less *base* context exposes a refusing stub, so backend access only
   exists on the per-extension (trust-scoped) context. This is the one place
   backend access enters an extension — so it is the one place to gate.

3. **Migrate built-ins off raw `invokeBackend("string")` (DONE).** All ~124 raw
   call sites across 24 files / 13 extensions were re-routed:
   - **Channel.** `createBackendChannel(label)` (`backendCommands.ts`) is a
     deferred door for code that runs outside the `ExtensionContext` — lib-api
     wrappers, zustand stores, React components. The extension binds it once in
     `activate()` (`<x>Backend.set(ctx.invokeBackend)`); the module's functions
     call `<x>Backend.invoke(cmd, args)`, flowing through the same gated door.
     Each feature extension owns one channel module (`lib/<x>Backend.ts`).
   - **Import-swap.** Cross-feature pivot/table reads that already had typed
     wrappers (`getPivotHierarchies`, `getAllTables`, `applyPivotFilter`, …) were
     swapped to those wrappers.
   - **Ban.** `eslint.boundaries.js` forbids the raw `invokeBackend` import from
     `@api/backend` in extensions (folded into the FACADE block via
     `no-restricted-imports` `paths`/`importNames`; typed wrappers stay allowed).
     A later patterns-only relax-block keeps tests + the dev-only TestRunner
     harness exempt (they mock/reach the raw door legitimately) while preserving
     the core/shell Facade patterns for them. `npm run lint:boundaries` is clean.
   Note: channel modules import `createBackendChannel` from the leaf
   `@api/backendCommands`, NOT the `@api` barrel — the barrel's size triggers a
   circular-init `TypeError` at module load.

4. **Backend extension surface (long-term, optional).** A true Rust plugin model
   (third-party backend code) is out of scope; the practical answer is richer
   *capability APIs* (like `net.fetch` / `bi.query`) exposed through the broker,
   not arbitrary command registration.

## Layering: the backend gate vs the broker (why the ceiling lives at the broker)

There are two capability vocabularies, enforced at two layers — deliberately
NOT merged:

- **Backend gate** (`assertExtensionMayInvoke`, this module): a coarse DENYLIST
  over the raw backend door. Vocabulary = `PrivilegedCapability` (codeExecution,
  hostFilesystem, credentials, extensionManagement, mcpServer, biData). Decision
  is binary by trust: trusted built-ins pass; non-trusted code may never call a
  privileged command directly.
- **Broker** (`scriptHost/broker.ts` `checkPolicy`): enforces the per-manifest
  `CapabilityId` ceiling (net.fetch, bi.query, bi.sql, storage, ui.html,
  formula.udf) **per call**, plus a runtime **JIT consent grant** — the declared
  ceiling is the *maximum*, the grant is the *actual* permission.

A reviewer might expect the per-manifest ceiling to be threaded into the backend
gate. It must NOT be: the ceiling is *declared*, not *granted*, so allowing a
capability-backed command on declaration alone would bypass the broker's per-call
consent (and, for fetch, the Rust per-call origin re-check). The correct posture
is that every capability-backed backend command (`script_http_fetch`,
`script_bi_sql`, `bi_query`, `bi_get_connections`) is reachable by non-trusted
code **only through the broker** — so they all sit in the backend denylist, and
the ceiling is enforced once, at the broker. Adding `biData` (this slice) closed
the last gap: `bi_query`/`bi_get_connections` were feature-open at the backend,
so a future distributed extension reaching `ctx.invokeBackend` directly could
have read BI data without the broker's capability+consent gate.

**Asymmetry (RESOLVED, A3.4-S2):** `script_http_fetch` re-checks the granted
origin in Rust per call; `bi_query` / `script_bi_sql` previously relied on the TS
broker only. They now also re-check an authoritative per-script BI grant in Rust
(`CapabilityStore.is_bi_granted`), mirrored on consent-grant via the new
`grant_script_bi` command + a mount re-sync, with single-cap revoke reconciling
the store. A broker-routed (sandboxed) call carries a `script_id` and must have
been granted; a trusted main-window direct call (built-in feature) carries none
and passes.

## Status

- **Done:** (1) capability data + enforcement primitive + drift-guard test
  (`backendCommands.ts`, `backendCommands.test.ts`); architecture reality
  documented here and in `ARCHITECTURE.md`. (2) The governed
  `ExtensionContext.invokeBackend` door — `createScopedInvokeBackend` factory +
  contract member + ExtensionManager wiring + base-context refusing stub, covered
  by door-factory unit tests. (3) Migration of all ~124 raw call sites onto the
  channel / typed wrappers + the `eslint.boundaries.js` ban forbidding the raw
  `@api/backend` `invokeBackend` import in extensions (FACADE block, with a
  tests/TestRunner relax-block). Verified: canonical typecheck
  (`tsc -p tsconfig.check.json`) clean, full vitest green (102k tests),
  `lint:boundaries` clean, and the ban proven to fire on the raw import while
  allowing typed wrappers.
  (4) Closed the model-scoped BI direct-path gap by adding the `biData` group
  (`bi_query`, `bi_get_connections`) to the denylist, and documented the
  gate-vs-broker layering above.
- **Resolved (not built):** threading `computeExtensionCeiling` into the backend
  gate. Analysis (see "Layering" above) showed the per-manifest ceiling belongs
  at the broker (declared ≠ granted; the broker has per-call consent + Rust
  re-check), and the backend gate is correctly a coarse broker-only denylist.
- **A3.4 (backend extension surface — done):** the design spike concluded a
  literal Rust plugin loader is the wrong answer (compile-time commands + the
  security floor); the genuine surface is harden-the-mediated-path + internal IoC
  + document. Shipped: **S1** a fail-closed drift guard (a new dangerous-looking
  command must be denylisted or explicitly acknowledged, not silently
  feature-open); **S2** the Rust-side BI capability re-check above; **S3** a
  data-driven backend undo/restore registry (`undo_commands.rs`) replacing the
  hardcoded `apply_custom_restore` match + the fragile `kind.starts_with(...)`
  deferral + the fixed change-flag mapping with a `kind → {restore_fn,
  change_class, defer}` table (built-ins self-register; behavior-preserving, with
  a unit test asserting `defer` still equals the legacy prefix result for every
  kind); **S4** this doc + `ARCHITECTURE.md` now state the backend-is-the-trusted-
  kernel boundary as a deliberate, defended decision.
- **Next (long-term, optional):** richer broker capabilities on demand (the
  item-4 template) when a concrete third-party backend need arises. (The audit
  trail is now unified: QuickJS grid mutations + capability calls all persist to
  one per-workbook log — `net.fetch`/`bi.query`/`bi.sql` record authoritatively
  in their Rust gates via `net_commands::record_capability_call`, and the
  remaining caps + broker-policy denials write through from the broker ring via
  the `audit_record_capability` command. See `audit.rs`,
  `scripting/commands.rs::record_script_grid_mutation`, and the dedup in
  `broker.ts`.)
