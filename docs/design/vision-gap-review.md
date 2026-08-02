# Vision Gap Review — Full Application Audit (2026-06-11)

## How this was produced

A multi-agent review against the founding vision (see `claude.md` Project Vision,
`README.md` "Why Calcula Exists"): 8 subsystem auditors mapped the .calp backend,
distribution frontend, writeback flow, scripting coverage, script API depth,
security/trust model, third-party extension system, and quality signals. 4 analysts
turned the maps into proposals per vision pillar. Every proposal's factual claim was
then adversarially verified against the code by an independent agent. **55 proposals
were confirmed, 0 refuted.** A completeness critic added 8 blind spots. Evidence
references are file:line at time of review.

## Executive summary

The backends are substantially built — publish/pull/writeback, three scripting
runtimes, a typed extension API. The vision fails not for lack of machinery but at
three recurring seams:

1. **Enforcement theater.** Security and governance controls exist as types, settings,
   and UI — and are enforced nowhere. The script security level gates nothing, the
   consent dialog can never fire, "restricted" scripts hold full webview + Tauri
   authority, writeback visibility/approval/deadline policies are serialized and
   ignored, locked cells are never checked. Declared-but-unenforced controls are
   worse than none: they manufacture false confidence.
2. **Last-mile UI.** The backend is far ahead of the frontend: ~17 of 34 `calp_*`
   commands have zero frontend callers (detach, audit log, registry browsing,
   override export/import, channels). Two Data-menu entries are dead on arrival.
   The publisher has no view of received submissions.
3. **Broken core loops.** The subscriber edit→refresh→conflict loop does not work
   (overrides are never captured; conflict detection rebases against an always-empty
   map), and the publisher consolidation loop does not work (GATHER formulas see no
   data in normal recalculation). The two headline .calp loops are each broken at
   one critical link.

---

## P0 — Broken today (fix first, mostly small)

**Status: all seven items DONE (2026-06-11).** Details per item below; bonus
fixes found during implementation are listed after the table.

| # | Fix | Status |
|---|-----|--------|
| P0.1 | **"Refresh Subscriptions..." menu item is dead** | **DONE** — `calp_refresh_preview`/`calp_refresh_apply` now derive the registry path per subscription from its stored `registryUrl` (the single `registry_path` param is gone, fixing multi-registry workbooks); dev/channel pins are skipped; RefreshPreviewDialog now shows backend errors instead of masking them as "No Updates Available" |
| P0.2 | **"Designate Writeback Region..." is dead** | **DONE** — the Distribution extension tracks the grid selection, and the menu action passes selection + the active sheet's stable SheetId (new `calp_get_sheet_id` command) into the dialog; with no selection it shows a hint toast |
| P0.3 | **GATHER formulas see no data in the grid** | **DONE** — gather pre-fetch wired into `update_cell`, `update_cells_batch`, `fill_range`, and the `calculate_now` recalc path (`evaluate_formula_with_pivot` gained a `gather_fn` param); `build_gather_data` has a fast path (no registry I/O when the workbook has no writeback regions) |
| P0.4 | **The calp test suite does not compile** | **DONE** — 11 E0063 sites fixed, 132 calp tests pass; also revived `calcula-format`'s dead test (missing `deserialize_style_registry`); full core workspace: 655 tests green. Root cause fixed too: the regression runner's Rust phase now sources `setup-rust-env.ps1` (it previously failed environmentally, hiding the rot) |
| P0.5 | **Phantom coverage entries** | **DONE** — feat.distribution and feat.bi in `tests/regression/registry.json` corrected (cited spec files/screenshots never existed) |
| P0.6 | **Script API correctness batch** | **DONE** — `SheetContext.get/setCellValue` honor `sheetIndex` (via `get_watch_cells`/`update_cell_on_sheets`); `sheet.onDataChange`/`cell.onEdit` report the tracked active sheet instead of hardcoded 0; `SlicerContext.clearSelection` now selects none (`[]`) — distinct from `selectAll` (null = no filter); each cell `onRender` gets a unique interceptor key; `chart.onDataChange` filters cell edits against the chart's source range (bulk DATA_CHANGED still forwards) |
| P0.7 | **Security level is cosmetic** | **DONE (enforced)** — `check_script_security` gates `run_script`, notebook cell execution (run/run-all/run-from), and the MCP `execute_script` tool. `disabled` refuses; `prompt` requires a once-per-session approval (`grant_script_session_approval`) with a confirm-and-retry flow in the ScriptEditor and ScriptNotebook API wrappers (covers buttons, which route through `runScript`); the level is now visible/settable in the Script Editor pane header. Not yet persisted across launches (defaults to `prompt`) |

**Bonus fixes from the same pass** (latent bugs of the same family found while
implementing):

- **Writeback index stale after reopen** — the index/declarations were only
  rebuilt at pull/refresh, so reopening a subscribed workbook left writeback
  regions inert (no guards, no tints, no GATHER) until a manual refresh.
  `open_file` now rebuilds the index after restoring subscriptions.
- **Writeback index leaks across File > New** — the new-workbook path cleared
  subscriptions but not the index/declarations/draft regions, leaving the
  previous workbook's regions active. Now reset.

---

## Wave 1 status (2026-06-12): DONE

D1, D2, D11, S1, T2, D4, and D3 are implemented (D3's cross-version
carry-forward included; the publisher dashboard remains D5/Wave 3):

- **D1 done** — subscriber edits on subscribed sheets now record overrides
  (update_cell, batch, fill, clear paths; writeback cells excluded; baseline =
  pre-edit value; undoing back to baseline clears the override). Revert/Accept
  in the Overrides pane now actually restore the cell value in the grid and
  recalculate. The pane refreshes live on cell edits. The id registry is
  re-seeded from the override layer on workbook open (it is in-memory only —
  without this, reopening minted duplicate CellIds for overridden cells).
- **D2 done** — refresh now builds a real upstream-value map (positional
  matching against pulled payloads; upstream structural shifts remain a known
  limitation until packages carry per-cell ids), rebase marks real conflicts,
  surviving overrides are re-overlaid onto refreshed grids, the
  writeback-declaration snapshot ordering bug is fixed, and two more latent
  refresh bugs found during implementation are fixed: `apply_refresh` no
  longer replaces subscriptions' local sheet ids with freshly-minted ones
  (which desynced grids/overrides after the first refresh), and the
  active-sheet mirror is synced after materialization (recalc used to revert
  a refreshed active sheet). The preview's `cells_changed` remains 0 — it is
  not displayed in the dialog, so it no longer misleads anyone; an honest
  diff needs upstream payloads at preview time (deferred).
- **D11 done** — PackageQuery/QueryPlacement and the direct cell-insertion
  path are deleted (manifest, publish, refresh-data, example, TS types,
  toasts). `calp_refresh_data` is repurposed as the subscriber-side
  connection verifier (saved config → SSPI → needs-configuration). Bug fixes:
  pulled connections derive their ConnectionType from the model/manifest
  instead of hardcoded PostgreSQL (SqlServer is stored faithfully; live
  connect for it surfaces a clear not-yet-supported error), and BI pivots are
  routed to THEIR data source via a new `dataSourceId` on
  SavedBiPivotMetadata instead of all getting the first embedded connection.
- **S1 done** — provenance + package_name persisted end-to-end
  (SavedObjectScript, ObjectScriptDef, ObjectScriptData, pull stamps it,
  publish ships clean), the consent dialog now actually fires for distributed
  scripts, save_object_script preserves stored provenance (anti-laundering)
  and refuses restricted→unlocked escalation for distributed scripts, and
  consent persists in the workbook (.calcula/script-consent.json) keyed by
  script source hash so upstream script changes re-prompt.
- **T2 done** — Subscribe is now a two-step flow: Review Contents (sheets,
  scripts, data sources, writeback regions, tables — via new
  `calp_inspect_package`) → Accept and Subscribe. `scriptsPulled` is mirrored
  in the TS PullResponse and surfaced in the result message.
- **D4 done** — writeback governance is enforced: visibility (own_only
  filters to own; own_plus_aggregate anonymizes other submitters), approval
  gating (on_approval regions aggregate only Approved submissions; new
  `calp_set_submission_state` approve/reject command — management UI is D5),
  lifecycle (deadline, one-shot, requires-unlock checked at draft save), and
  `immediate` regions auto-submit on save.
- **D3 done** — registry submissions are stored per logical slot
  (region+cell within the submitter directory), so re-submission REPLACES
  instead of double-counting in GATHER; submit resolves the OWNING
  subscription for the region (no more `subscriptions[0]`, no registry-path
  parameter); lenient version binding carries submissions forward across
  version bumps (newest per slot wins); the Writeback pane matches drafts by
  region id instead of bounds.

### Wave 1.1 punch list — DONE (2026-06-12)

A 4-reviewer adversarial review of the Wave 1 diff produced 36 findings. The
3 must-fix items (ABBA lock-order deadlock in override capture; in-session
bypass of the distributed-script escalation guard via the editor toggle;
SavedBiPivotMetadata.data_source_id not surviving save/load) were fixed
same-day, plus 13 of the should-fixes (error-cell conversion mismatch causing
spurious conflicts; conditional+correct active-mirror sync; clear-with-options
override capture; commit guard no longer swallows lifecycle rejections; Empty
submissions excluded from GATHER; carry-forward restricted to semver-older
versions; submit is registry-first/failure-atomic; consent dialog registered
before initial script load; same-session consent after pull via
calp:scripts-pulled; File>New no longer leaks object scripts/pivot layouts;
bi_create_connection honors the model's connector type; refresh-data skips
non-PostgreSQL sources instead of mis-prompting; stale manifest doc comments).

The remaining 20 were completed as Wave 1.1:

- **Refresh/recalc correctness:** calp_refresh_apply rebuilds the dependency
  maps when the active sheet was refreshed, and a new
  calculation::recalculate_sheet_values evaluates every refreshed sheet —
  including non-active ones — with a locally built dependency order
  (revert/accept do the same for their sheet). Undo/redo now maintains the
  override layer through record_subscription_override_edits (SetCell + full
  snapshot diffs), so an undone edit no longer resurrects on refresh.
  payload.subscription_index is revalidated across lock reacquisitions;
  unparseable override formulas degrade to visible text instead of blanking
  the cell.
- **Writeback governance:** one-shot/locked lifecycles now consult the
  authoritative registry record (registry_has_own_submission, current + older
  versions), defeating the reopen-without-saving bypass.
  calp_set_submission_state finds and rewrites carried-forward submissions in
  the version directory where they live. Carry-forward is gated on per-region
  schema compatibility against each older version's manifest. GATHER builds
  are cached (2s TTL + eager invalidation on submit/state-change/index
  rebuild/detach) and load each (package, version) submissions tree in ONE
  scan bucketed by region (was O(regions × versions × files) per keystroke).
  save_submission rejects region ids with path separators (+ tests);
  ambiguous region ids resolve first-wins in BOTH submit and gather;
  calp_save_writeback_draft verifies the claimed region id matches the cell's
  actual region.
- **Script lifecycle:** calp_refresh_apply replaces each refreshed package's
  distributed scripts with the new version's set (safe: distributed scripts
  are upstream-owned/read-only), and RefreshPreviewDialog emits
  calp:scripts-pulled so changed sources re-prompt for consent via the hash
  check. Consent prompts are queued per package (no more last-writer-wins
  dialogs); "Inspect Scripts" opens the actual distributed script read-only
  instead of scaffolding a junk workbook script.
- **BI data sources:** in-app calp_publish now ships pivot definitions + BI
  pivot metadata (collect_pivot_definitions), filtered and remapped to the
  published sheet subset. Connection gained package_data_source_id; the
  refresh-data verifier propagates the working connection string into the
  pulled connection pivots actually query — "verified" now means pivot
  refresh works. ConnectionDialog walks ALL sources needing configuration
  (with progress), refresh-data skips per-source parse failures instead of
  aborting the whole command, and capture_bi_data_sources dropped its
  vestigial parameter.

Deferred (small, folded into later waves): OverrideValue's display-string
round-trip coerces types ("0123" → 123) — needs a typed value in the calp
format, batched with the package cell-id format work; publish still ships
chart/slicer component scripts for unpublished sheets (pivot definitions ARE
filtered) — needs a component→sheet mapping, batched with D5 publish UX.

## Wave 2 status: DONE (2026-06-13)

The sandbox architecture was designed via a three-lens panel (compatibility /
security / simplicity) + judge synthesis — the binding design is
**docs/design/script-sandbox-architecture.md** (per-script Worker realms,
blob-ESM compilation, data-driven tier broker, SWR render caches, capability
grants with Rust re-checks; five implementation phases, each shippable).

**All five phases + S5 signing landed.** Beyond "batch 1" below: Phase 2 (broker
on main thread), Phase 3 (worker realm + bitmap-blit renders; legacy main-thread
path deleted), Phase 4 (capabilities/consent — `net.fetch`/`storage`/`ui.html`,
JIT + package consent, R19 ceiling), Phase 5 (CSP v2 — `'unsafe-eval'` dropped;
chartTransforms on a safe `evalArithmetic` parser), and S5 phase 2 (Ed25519
`.calp` signing + TOFU pinning). The detail below is the original batch-1 record.

Landed (2026-06-12, "batch 1" = design + Phase 0 + Phase 1 + S5/S6/S7):
- **Phase 0 hygiene:** script-hook emit payloads fixed (ROWS/COLUMNS
  INSERTED/DELETED carry sheetIndex+start+count; RESIZED uses real
  sheetIndex); EDIT_STARTED wired (3 sites) and EDIT_ENDED carries an honest
  `committed` flag (Table auto-expand guarded for cancels); pivot onRefresh
  subscribes to the real `pivot:refresh` event; script-facing
  `executeCommand` no longer drops args past the first; dead hooks pruned
  (slicer onDataRefresh/onResize, chart onClick/onResize, pivot
  onLayoutChange/onResize); caller-less arbitrary-URL `loadRuntimeExtension`
  deleted.
- **S6 iframe fixes:** `allow-same-origin` dropped from both shape-iframe
  sites (opaque origins — no parent/__TAURI__ reach), srcdoc id injection
  escaped, parent listener verifies `e.source` against the expected iframe's
  contentWindow (spoofed instanceId events rejected).
- **S3 flip:** `withGlobalTauri: false`; e2e keeps `window.__TAURI__` via a
  dev-merge overlay (`tauri.e2e.conf.json` + `--config` in global-setup)
  that cannot ship.
- **S10 CSP v1:** real CSP replaces `csp: null` (connect-src locked to IPC —
  kills script exfiltration and remote injection; 'unsafe-eval' remains
  until Phase 5). devCsp variant for HMR.
- **Phase 1 window guards:** `security/window_guard.rs` + 80 commands
  guarded (persistence/FS, virtual files, calp_* (37), bi connect/query,
  notebook exec, MCP, extension scan, script security). Verified exceptions
  encoded as data: object-script CRUD+reads and templates also allow
  `object-script-editor`; run_script + session approval also allow
  `script-editor`. NOTE: guards are enforcing; design suggests a manual
  smoke of the three editor windows (run script, save object script,
  save/load template) before shipping.
- **S7 MCP auth:** per-session 244-bit bearer token (OS RNG — NOT uuid_v7,
  which is a time-seeded PRNG), constant-time compare, axum middleware ahead
  of rmcp (all methods), Host must be loopback, browser Origins rejected,
  all 6 tools log invocations; token shown in the AIChat MCP panel with a
  Claude Desktop config snippet.
- **S5 phase 1 — artifact checksums:** SHA-256 of every version artifact in
  the version manifest (`artifactChecksums`), manifest written LAST as the
  publish commit point; pull/refresh verify before materializing anything —
  tampered/missing/UNLISTED files and checksum-less packages all fail closed
  with named errors. Ed25519/TOFU seam documented in `calp/src/integrity.rs`.

**Phase 2 — tier broker (batch 2, 2026-06-12): DONE.**
- `api/scriptHost/{allowlist,validators,broker,auditRing}.ts`: the §5.1
  ALLOWLIST as data (one object consumed by broker dispatch, the panel, and
  consent text); enforcement order validate→tier→capability→limits→audit;
  BrokerError codes (PermissionDenied/CapabilityRequired/ValidationError/...);
  2000-entry audit ring.
- Context builders route through the broker: all base.* (log/notify/expose/
  callMethod), the full UnlockedAPI (api.*), and sheet.get/setCellValue with
  the R16 clamp (restricted sheet scripts denied cross-sheet access).
  Own-object mutators (slicer selection, shape props, ...) stay direct until
  the Phase 3 object.setState wire collapse — they are restricted-tier
  methods, so policy adds nothing yet; audit coverage for them arrives with
  the realm.
- R5: script events force-namespaced userscript:* symmetrically (emit +
  subscribe) + a read-only AppEvents subscribe subset; R6: executeCommand
  enforces the scriptSafe opt-in (flag pass: 33 registrations audited,
  3 flagged, 30 fail-closed — incl. the catch that bookmarks.activateView
  can run a linked script = escalation path); R7: expose/callMethod moved to
  the broker's host registry, callMethod is now async, cross-tier/package
  calls require {public: true} (test covers the denial).
- PermissionsPanel ("Script Permissions", sections-based panel API): mounted
  scripts w/ tier+origin+grants+exposed methods, the policy table rendered
  FROM ALLOWLIST, live audit tail.
- objectContexts.d.ts updated (callMethod Promise, expose options).

**Phase 3 — worker realm (batch 3, 2026-06-12): CODE-COMPLETE.**
- New: scriptHost/protocol.ts (the §4 RPC), renderCache.ts (cell-style SWR
  cache + bitmap caches, single-flight, rAF-batched misses, LRU 50k),
  worker/bootstrap.ts (hardening prelude: fetch/XHR/WebSocket/indexedDB/...
  neutered before any user source; capped ambient timers 16ms/32; console
  forwarding; blob-ESM compile — import-time executes nothing user-authored),
  worker/contextShims.ts (all 10 object types' surfaces rebuilt over RPC;
  sync getters via host-pushed mirrors), host.ts (spawn/terminate; every
  worker call dispatched through the Phase 2 broker + an IMPL table that is
  the legacy builders' bodies; hook forwarding only for declared hooks with
  filters host-side; coalesced *Changed events; one-free-respawn crash
  policy, second crash in 30s faults the script), index.ts facade.
- Mounts route to the worker realm by default when Worker exists;
  localStorage "calcula.scriptWorker"="0" selects the legacy main-thread
  path for the dual-run soak (jsdom tests use it automatically). Legacy
  path deleted when the soak gate passes.
- Shape canvasRenderer + slicer itemRenderer render via OffscreenCanvas in
  the worker; the host blits cached ImageBitmaps inside clipped regions
  (shapeRenderer.ts + slicerRenderer.ts wired; legacy function path kept
  behind the same A/B). Cell onRender unchanged for scripts (purity
  contract + render.invalidate() documented in d.ts + scaffold).
- Editor validation now uses a scratch worker (hostValidateScript);
  lib/scriptWorker.ts deleted.
- **Day-1 platform spike: PASSED** (e2e/tests/worker-realm-spike.spec.ts,
  run against the live app in WebView2 under the dev CSP): module workers
  from blob URLs OK, blob-ESM import() OK, zero CSP violations, AND the
  PRODUCTION bootstrap worker itself spawned + compiled a script via
  blob-ESM import in-realm (hostValidateScript round-trip: valid source →
  valid:true, broken source → its syntax error). OffscreenCanvas +
  measureText + transferToImageBitmap + host blit pixel-verified. Both §13
  risk-1 platform bets hold — no fallbacks needed. (Spike gotcha for future
  e2e work: the bare `page` fixture is an about:blank CDP target with a
  NULL origin — worker/module probes there fail misleadingly; use the
  `appPage` fixture.)

All of the above landed (Phase 3 gates passed, legacy path deleted; Phase 4/5 +
S5 done).

## Wave 3 status: DONE (2026-06-14)

Full record: **docs/design/wave3-scripting-security.md**. Closed the remaining
scripting + security gaps:

- **C1 — UDF evaluation:** registered `formulas.registerFunction` impls now
  evaluate in worksheet formulas (engine `udf_fn` hook + off-thread pre-fetch +
  the broker-mediated `formula.udf` capability). [Pillar 2 / C1]
- **S8/C7 — extension sandboxing:** distributed extensions are trust-classified +
  capability-ceiling-bounded + transparency-tracked (Phase A), and
  `workerSupport:true` ones run **sandboxed in a hardened worker realm** with no
  ambient DOM/Tauri/network (Phase B). Signed sidecar manifests (Ed25519 + TOFU,
  verified at scan) + worker-extension menus. [Pillar 3 S8/C7, Pillar 4]
- **C3 — script-surface unification:** one queryable taxonomy
  (`scriptSurfaces.ts`), unified governance; notebooks/one-off documented as
  already-contained Rust QuickJS (not relocated to the worker realm — see the
  doc for why). [Pillar 2 / C3]
- **`bi.query` + `bi.sql`:** the last deferred Wave 2 capability (structured,
  model-scoped) plus a separate higher-trust raw-SQL capability with Rust
  read-only re-validation. [Pillar 2]
- **Command return values:** `CommandRegistry.execute` returns the handler's
  result (surfaced through the worker proxy + `executeCommand`).

The capability vocabulary is final (`net.fetch`, `bi.query`, `bi.sql`, `storage`,
`ui.html`, `formula.udf`); all have executors, ceiling, consent, and audit across
object scripts and worker extensions. Verified: full unit suite 101,855 pass,
Rust + engine build clean, e2e green.

### Customization-depth follow-on (Pillar 2, 2026-06-14)

With the security/scripting foundations done, started the VBA-customizability gaps:

- **C5 (partial) — ButtonContext.onClick:** the #1 VBA entry point ("click a
  button, run your code") now works through the sandboxed worker realm (mirrors
  `shape.onClick`: context type → worker shim → host forwarder on the
  `button:clicked` app event → UI emit in Controls run mode → scaffold + `.d.ts`).
  Remaining C5: Timeline context.
- **C4 — undoable macros:** one-off `run_script` writes now route through the edit
  pipeline (`update_cells_batch`) — formulas parse + recalc (incl. dependents) and
  the whole macro is a single undo entry — instead of the wholesale grid swap.
  Non-active-sheet writes are now undoable + recalc-tracked too (a
  `script_grid_cells` CustomRestore + `recalculate_sheet_values`), no longer a
  wholesale swap; notebooks keep their GridCheckpoint/rewind model.
- **C6 — Table + NamedRange contexts:** Excel's most-automated VBA objects are now
  scriptable per-instance. Tables expose `getHeaders`/`getRowCount`/`getCellValue`/
  `setCellValue`/`addRow`/`onDataChange`; named ranges expose `getAddress`/
  `getValues`/`setValues`/`onChange`. Reads/writes resolve to grid coordinates
  host-side and reuse the existing (undoable, recalc'd) cell ops. Attach via the
  Table Design ribbon tab and the Name Manager dialog. Deleting a table/named range
  prunes its scripts (C10 cleanup). `pure objectCoords.ts` + 17 unit tests.

A later batch (this session) closed more of Pillar 2:
- **C5 tail — Timeline context:** the date-range slicer is now a real scriptable
  object (`onChange`/`getRange`/`setRange`/`clearSelection`/properties) via a new
  `ITimelineStoreService`. Only `textbox` remains a bare-enum surface.
- **C10 — lifecycle hygiene:** deleting a chart/slicer/pivot/timeline now prunes
  its object scripts (joining table/named-range from C6) via a shared
  `prune_scripts_for_instance` helper, so a deleted object never leaves a
  dangling, still-persisted script. (Deliberately no aggressive load-time orphan
  sweep — that risks false-positive pruning of valid scripts.)
- **C7 — extension manager (transparency + control):** the Extensions panel is no
  longer "coming soon". It surfaces each extension's trust class, Ed25519
  signature status, declared capability ceiling and sandbox state, and lets the
  user disable/enable third-party extensions (built-ins are kernel-adjacent and
  always on). Disabling tears down immediately + persists; enabling applies on
  reload (VS Code's model).
- **C7 — uninstall (done):** a path-traversal-safe `uninstall_extension` Rust
  command (pure `resolve_uninstall_targets` resolver + canonicalized containment
  check, TOFU pins preserved) deletes an extension's bundle + sidecars (or its
  directory) from disk, wired to a confirm-to-Remove button in the manager.
- **C2 — shared React singleton (done):** the host publishes its React instance
  (`globalThis.CalculaReact`) so runtime-loaded third-party extensions render UI
  with the host's React (a second bundled React breaks hooks). `@api` stays
  scoped via the injected context — deliberately NOT a global. Reference example +
  e2e still TODO.
- **C3 (bounded) — shared type surface:** the QuickJS `calcula.d.ts` that every
  Monaco editor loads now documents all 35 previously-undocumented root ops (29
  `extended.rs` + 6 `worksheet_props.rs`); a cross-language coverage test pins the
  Rust-op→d.ts invariant so a new op can't ship without its type.
- **C8 — distribute module scripts + notebooks via `.calp` (done):** publish/pull
  now carry standalone module scripts (`workbook.scripts`) and notebooks
  (`workbook.notebooks`) as inert, signed + checksummed, transparent artifacts
  (surfaced pre-pull in `calp_inspect_package`); notebook execution metadata is
  stripped defensively **at pull** (so a forged-but-signed package can't show fake
  output); module scripts/notebooks replace by id so upstream updates land on
  refresh. A 9-agent adversarial review caught + fixed 5 real defects (refresh
  drop, stale-on-repull, pull-strip spoof, scope ambiguity, uninstall teardown).

A final batch closed the rest of the practical Pillar-2 list:
- **Module-script/notebook provenance (done).** A `source_package` now threads
  through the runtime/saved/`.cala` types: stamped on pull (and re-stamped to
  defend against a forged attribution), cleared on publish, and used by a
  per-package materializer that **removes** a publisher's deleted modules on
  refresh, **updates** the package's own, and **preserves** subscriber-local
  same-id documents — full parity with distributed object scripts.
- **C2 reference example (done).** `docs/examples/hello-extension/` is a complete,
  build-verified sample third-party React-UI extension (the `react` →
  `globalThis.CalculaReact` shim + esbuild config + sidecar manifest + README).
  Two deterministic vitest tests prove a shared-React component renders with
  working hooks (a vendored second React would throw "Invalid hook call").
- **C3 first increment (done).** `api/objectModel.ts` adds the `Workbook`/`Sheet`
  navigation levels over the `CellRange` Range seed — the first step of the
  canonical `Workbook → Sheet → Range → Cell` model. The full plan (sheet-aware
  ranges; object-script + Rust-QuickJS bindings; one shared `.d.ts`) is in
  docs/design/c3-shared-object-model.md.

Update (2026-06-27): the **deeper C3** (steps 2–5 of the binding plan) is now
marked complete — see `docs/design/c3-shared-object-model.md` ("C3 is complete
(steps 1–5)"). Biggest remaining themes overall:
distribution last-mile (**D5/D6** publisher dashboard + subscription manager,
**D9** package content fidelity, **D7** registry path-traversal/atomic-writes,
**D8** authenticated identity) and the **T1** "Code in This File" inspector.

### Animation / Simulation playback engine (2026-07-01)

A new `Animation` extension delivers the MATLAB-style payoff — press *play* and watch a
model evolve — as a first-class customizable feature, not a Core capability. A generic
`Driver` advanced by a back-pressured async playback clock, with four drivers: **clock-cell**
(a driver cell stepped `from → to`, recalculating dependents), **chart-param** (drives a
chart's live param each frame via the `@api/chartParams` facade — pure frontend, no backend
recalc), **scenario** (linear/step tween between Scenario Manager keyframes), and **Monte
Carlo** (`RAND`/`RANDBETWEEN` re-roll per trial via `anim_reroll_and_read`, into a live
histogram — intentionally non-deterministic). Frame delivery is **transient**: the
`anim_snapshot` / `anim_apply_frame` / `anim_restore` trio (`animation_commands.rs`, modelled
on `scenario_show`) mutates + recalculates the grid but **never records undo or dirties the
document** — there is no suppression flag; the commands simply never touch the undo stack —
so undo/redo sees only intentional user actions and a preview frame can never be serialized.
Exports to GIF (`export_gif`, Rust `gif` crate, `hostFilesystem`-classified) and WebM
(`canvas.captureStream`). Persistence via the A5 extension-data tier +
`set_extension_data_undoable`. Reaches the backend through the capability-classified
`createBackendChannel("Animation")` door (A3); drives Charts + captures frames through
feature-neutral IoC facades (`@api/chartParams`, `@api/rendering`) with the single sanctioned
Core primitive `gridCapture.ts` exposed via the facade. e2e `animation.spec.ts` verifies all
four drivers end-to-end (transient writes, recalc, play, and stop-restore). Full record:
`docs/design/animation-simulation.md`.

## Pillar 1 — Distribution & data collection (.calp)

Your suspicion was right on both counts: the system needs more features to be a full
distribution/data-collection product, **and** it has structural issues. The verified
state: the subscriber fill→submit plumbing genuinely works end-to-end, but both
headline loops have a broken critical link, and the management/governance layer is
mostly missing.

### Critical

- **D1. Capture cell overrides when a subscriber edits a subscribed sheet.**
  No cell-write path records a `CellOverride` — the override layer is populated only
  by patch import, so the built-and-tested rebase machinery has no input and local
  edits are silently destroyed on refresh. Requires baseline values at pull/refresh
  time and a state hook in the write paths (excluding writeback cells, which are
  currently rejected/filtered in those paths, not routed to drafts).
  (`commands/data.rs` zero override refs; `overrides.rs:180-204` reachable but no-op)
- **D2. Make refresh conflict detection real.** Three coupled fixes:
  populate `upstream_values` in `apply_refresh` (today an always-empty HashMap at
  `refresh.rs:283`); re-overlay surviving overrides after grid replacement
  (`calp_commands.rs:527` is wholesale); snapshot writeback declarations BEFORE
  `rebuild_writeback_index` (today old==new so draft invalidation never fires,
  `calp_commands.rs:558-589`). Also compute real `cells_changed` for the preview
  (hardcoded 0 with a "skip for preview" comment — the user confirms a fabricated diff).

### High

- **D3. Submission storage semantics.** Re-submission across submit cycles mints a
  new UUID per save and never removes the prior registry file → **GATHER
  double-counts**; `calp_submit_region`/WritebackPane resolve package/version from
  `subscriptions[0]` (wrong subscription for multi-package workbooks); drafts match
  regions by row/col bounds only; every version bump silently drops all prior
  responses (GATHER reads only `resolved_version`). Key submissions by
  (region, cell, submitter) with supersedence; add a SubmissionManifest; carry
  forward compatible submissions under lenient binding.
- **D4. Enforce writeback governance.** `own_only` visibility leaks every
  subscriber's values to all subscribers via GATHER (privacy issue);
  `SubmissionPolicy::OnApproval` and `Approved/Rejected` states are dead enums with
  no transition commands; lifecycle deadlines are never checked; no "locked" visual
  state. Publishers configure these in the dialog today and silently get
  transparent/immediate/forever.
- **D5. Publisher data-collection dashboard.** Submissions inbox, respondent roster
  (who hasn't responded), completion %, approve/reject, new-submission indicator.
  The backend primitive (`load_region_submissions`) already exists, unexposed.
  GATHER formulas are not a management UI.
- **D6. Subscription manager + registry browser.** Wire the ~17 caller-less
  commands: list subscriptions (pin/resolved/last refresh), per-subscription
  refresh/re-pin/detach/export-import overrides, package browser for
  Subscribe/Publish (`calp_browse_registry` returns full version history, unused —
  Subscribe is blind text fields), update-available badge on open.
- **D7. Registry robustness.** `package_name` and `submitter_id` are joined raw
  into filesystem paths (path traversal from a hostile package name); all writes are
  plain `fs::write` with no atomic rename and no locking around manifest
  read-modify-write (design risk R2, never implemented). Validate at the
  LocalRegistry boundary; write-temp+rename; lockfile.
- **D8. HTTP registry transport + authenticated identity.** Extract a
  `RegistryTransport` trait (fs impl stays); add HTTP (reqwest already in app deps);
  bind submitter identity to an authenticated principal — today it's a spoofable
  local JSON (OS username + UUID). The design doc itself says "Writeback requires
  authenticated subscribers."
- **D9. Package content fidelity + disclosure.** Publish carries cells, styles,
  layout, tables, named ranges, object scripts, pivots, BI models — and silently
  drops merged regions, freeze panes, notes, hyperlinks, hidden rows/cols, tab
  color, charts, sparklines, conditional formatting, data validation
  (`pull.rs:111-129` hardcodes them empty; snapshot already carries much of it).
  A report that loses its charts and merged headers is not a distributed report.
  Add publish-dialog contents summary + subscribe-time disclosure.
- **D10. Revive tests + write the real e2e lifecycle spec** (see P0.4/P0.5): the
  soak/oracle machinery that found all 20 ledger bugs has zero reach into calp;
  publish→subscribe→edit→refresh→writeback→GATHER has no automated safety net —
  which is how two dead dialogs shipped.

### Medium

- **D11. Decommission the deprecated query-region path** (per the standing
  decision): delete `PackageQuery`/`QueryPlacement` types, the cell-writing loop in
  `calp_refresh_data:1908-2001`, publish-side capture, the api/menu consumers
  (`data:refreshData` menu item, ConnectionDialog call) — while preserving the
  connection-config/model-embedding infrastructure used by pivot refresh. Fix while
  there: `ConnectionType::PostgreSQL` hardcode on pull; all restored BI pivots
  receiving the FIRST embedded connection id (wrong for multi-source packages).
  Decide wire-or-delete for dormant crate features: `channels.rs`,
  `cross_package.rs` (returns empty graph), `RefreshDefaults`, locked sheets/cells
  scaffolding (publish always writes empty lock lists; `is_locked` has no callers).
- **D12. Complete the audit trail + give it a UI.** Of 12 `AuditEvent` variants only
  `WritebackSubmitted` is ever recorded; audit is opt-in and off (the design doc
  says registry-side audit is "required, not opt-in" for writeback); the three audit
  commands have zero frontend callers — the guide says review it "via the API".

---

## Pillar 2 — Customization & scripting

Your "patchwork" diagnosis is exactly what the audit found: **three disjoint script
surfaces** (object scripts / QuickJS ScriptEditor+Notebooks / extension API) with
incompatible APIs — the same cell write exists in three shapes
(`api.setCellValue` vs `Calcula.setCellValue(...,sheetIndex)` vs
`updateCellsBatch`). Coverage matrix: 10 of 13 declared object types work end-to-end;
3 are dead ends; ~9 user-facing object types aren't scriptable at all.

### Critical

- **C1. The UDF bridge: registered custom functions must evaluate in cells.**
  `formulas.registerFunction` is autocomplete metadata only — `=MYFUNC()` yields
  `#NAME?`. This is the canonical never-wait-for-the-vendor move (VBA's
  "write a Function, get a worksheet function"). Build the Rust↔TS dispatch (or
  Rust-side QuickJS execution), handle volatility/arg validation/error propagation,
  then expose registration to the script surfaces. Note: named LAMBDAs already
  cover formula-language UDFs; define name-resolution precedence against them.
- **C2. Make runtime third-party extensions actually loadable.** A runtime loader
  exists (scans `%APPDATA%/com.calcula.app/extensions/`) but blob-imported bundles
  cannot resolve `@api` or `react` (no import map, no global API, and `@api`
  services are module-scoped singletons populated at bootstrap — vendoring cannot
  work).

  **Decision (2026-06-15): vision-aligned "shared React only".** The host now
  publishes its React instance as a runtime singleton (`globalThis.CalculaReact`,
  see `app/src/api/extensionRuntime.ts`, wired in `main.tsx` before any extension
  loads). React is a pure UI library, and a runtime-loaded extension that vendors
  its own React gets a SECOND instance that breaks hooks/context the moment its
  components mount — so sharing the host instance is a hard correctness fix, not a
  capability grant. We deliberately do NOT publish a global `@api`: that would
  hand every main-thread script the full live API and discard the per-extension
  scoping the injected `ExtensionContext` provides. Extensions get the API through
  the context passed to `activate()`.

  Authoring model for a third-party extension build:
  - `react` → a tiny shim that re-exports the host singleton, e.g.
    `const R = globalThis.CalculaReact; export default R; export const { useState, useEffect, createElement } = R;`
    (or set the bundler's `jsxInject`/classic-runtime to `R.createElement`).
  - `@api` → captured from the `ExtensionContext` argument in `activate(ctx)` and
    closed over by the extension's components (NOT imported).

  Still TODO (deferred to the Rust-unblocked batch — needs the built binary):
  ship the reference build config + example extension and prove the end-to-end
  load with an e2e fixture.

### High

- **C3. Unify the three script surfaces around one shared object model.**
  One core Workbook/Sheet/Range/Cell model bound into all three runtimes, specced in
  a single .d.ts all Monaco editors share. Layering becomes additive capability
  (object scripts add lifecycle; notebooks add persistence/rewind; extensions add UI
  registration) instead of three products with rewrite cliffs. Seed exists:
  `CellRange` in `api/range.ts`, currently extension-only. (Also: the shared
  `calcula.d.ts` documents only ~20 of ~61 QuickJS ops — the 29 extended.rs ops are
  missing from IntelliSense.)
- **C4. Route QuickJS script writes through the edit pipeline.** `run_script`
  swaps whole grids: writes bypass formula parsing (`'=SUM(...)'` stored with
  `ast:None`), dependency recalc, and undo entirely. A macro that can't be undone
  destroys trust the first time it runs on real data.
- **C5. Ship ButtonContext (onClick) — the #1 VBA entry point** — plus Timeline.
  Button/textbox/timeline are enum+scaffold dead ends (scaffolds exist at
  `scriptableObjectScaffolds.ts:241-276`, no contexts, no UI emit sites). Nuance
  from verification: there is no `textbox` controlType — text boxes are shapes and
  already scriptable via ShapeContext; target button + timeline.
- **C6. Add Table and NamedRange contexts.** Excel's `ListObject` and `Name` are the
  most-automated objects in VBA; neither is scriptable. Defer sparklines, comments,
  CF/DV rules to a later wave.
- **C7. Extension packaging (.calx) + a real install/enable/disable manager.**
  Today: drop a raw .js into an appdata folder → it auto-runs with full privileges
  at next startup, with no consent, no off switch, no uninstall; the Extensions
  panel is a read-only list saying "coming soon"; `apiVersion` is optional for
  runtime bundles. (Security overlap: see S8.)

### Medium

- **C8. Distribute module scripts and notebooks via .calp** (manifest carries only
  `object_scripts`; `ScriptScope::Sheet`'s doc comment promises publish-time
  inclusion that no code implements) — with a per-script publish checklist (the
  `PublishRequest.object_scripts: Option<Vec<...>>` selection seam already exists,
  unused).
- **C9. Sanctioned capability APIs: timers/scheduling, permission-gated fetch,
  BI/pivot data queries** (`Calcula.bi.query` can route through the existing
  `biQuery` wrapper). Today network access exists only via the security hole
  (unsandboxed `window.fetch`) — closing the hole without this layer amputates
  real use cases. Each capability = a grantable permission shown in consent UI.
- **C10. Script lifecycle hygiene.** Deleting a slicer/chart/pivot leaves its
  script mounted and persisted forever (cleanup exists only for shapes); no orphan
  detection on open; script badges exist for shapes only (and only in design mode).

---

## Pillar 3 — Security (sandboxing & tiered access)

The QuickJS engine (ScriptEditor/notebooks) and writeback commit guards are real
isolation. Everything else is advisory. **The audit's sharpest finding:** the
third-party extension path auto-loads arbitrary `.js` from disk with full host
authority, silently, at startup — the exact VBA failure mode the project was founded
to fix.

### Critical

- **S1. Wire provenance end-to-end and activate the consent gate** *(also the top
  transparency item — surfaced independently by three of four analysts)*. Add
  `provenance` + `package_name` to `SavedObjectScript`, `ObjectScriptData`, and
  calcula-format's `ObjectScriptDef` (otherwise it's lost on save/reload); set at
  pull; round-trip through `objectScriptBackend.ts`; persist consent per
  (package, script, source-hash). The entire consent UI already exists as
  runtime-unreachable code; today pulled scripts match the *local* filter and mount
  immediately, and the read-only editor guards are equally dead.
- **S2. Move object-script execution out of the host window** into a Worker realm
  with postMessage RPC for the context surface; tier checked host-side per call.
  QuickJS doesn't fit the async event-driven object-script model; a worker preserves
  the existing TS contexts. `scriptWorker.ts` (validation-only today) is the seed.
  Cell `onRender` needs a data-only protocol (style object over RPC / declarative rules).
- **S3. Disable `withGlobalTauri` in production** (dev overlay for e2e). The
  cheapest cut of ambient authority: scripts and same-origin iframes lose the
  one-liner path to every backend command.

### High

- **S4. Tier-scoped command broker + per-window Tauri capability split.** Script
  realms never call `invoke` directly; the host broker maps tier → explicit command
  allowlist (kept as data so the transparency panel can render it). Backend
  defense-in-depth: app commands are entirely outside the Tauri 2 ACL today (no
  window-label checks anywhere in src-tauri); mark filesystem/registry commands
  main-window-only.
- **S5. Package integrity: SHA-256 artifact checksums, then Ed25519 publisher
  signing with TOFU key pinning.** No sha2/ed25519/hmac crate exists anywhere in
  the workspace; any process that can write the registry can inject scripts under
  another publisher's name. Sequence after D11 freezes the manifest surface.
- **S6. Fix the shape iframe sandbox.** Remove `allow-same-origin`
  (srcdoc → opaque origin kills parent/`__TAURI__` reach; also fix the second site
  in `PropertiesPane.tsx:607`); replace the trust-the-payload protocol with
  per-iframe MessageChannel (today any frame can forge events for any shape via
  spoofable `e.data.instanceId`); drop targetOrigin `'*'` posts.
- **S7. Authenticate the MCP server.** `run_script` over localhost HTTP is
  arbitrary code execution into the live workbook for any local process or
  DNS-rebinding web page. Per-session bearer token (axum middleware ahead of the
  rmcp service — rmcp session IDs are not auth), reject browser Origins, log tool
  invocations.

### Medium

- **S8. Install-time trust for extensions:** declared-capabilities manifest field,
  install consent enumerating capabilities, SHA-256 pinning with tamper refusal,
  dev-mode flag for the (currently caller-less) arbitrary-URL loader. Phase 2:
  enforce via an @api proxy exposing only granted namespaces.
- **S9. No silent escalation:** backend rejects restricted→unlocked for distributed
  scripts without an explicit consent-recorded grant (today it's one click in the
  editor and persists); editing a distributed script transitions it to
  `local-modified`, visibly, instead of laundering to local.
- **S10. Enable a real CSP** (currently `csp:null`): second line of defense for
  exfiltration; account for the blob:-URL extension imports and Monaco workers.

---

## Pillar 4 — Transparency (where code resides)

Storage is already transparent (scripts are readable JSON in .cala) — but no UI
aggregates residence + reach, and code arrives/ships silently in both directions.

### Critical

- **T1. Workbook-wide "Code in This File" inspector.** One pane enumerating ALL
  executable code: object scripts, ScriptEditor modules, notebooks,
  formula-registered functions, loaded extensions — each with kind, target
  (click-to-navigate), tier, provenance/package, mounted state, open-in-editor,
  count badge. Today code fragments across four unrelated surfaces; "what code is
  in this file?" has no answer. (Partial precedents: FileExplorer's notebook group,
  ExtensionsManager list.)

### High

- **T2. Pre-pull package review.** Subscribe currently materializes scripts, BI
  connection definitions, and writeback regions silently — consent must happen
  before code lands, with an explicit accept step listing contents
  (`calp_browse_registry` is a partial seed; `PullResponse` doesn't even mirror
  `scripts_pulled`, so the toast can't mention code arrived).
- **T3. Script updates on refresh: diff + re-consent.** Refresh today never updates
  scripts at all (`apply_refresh` ignores `pull_result.object_scripts`) — subscribers
  keep stale automation forever; a naive fix would create silent code swaps, the
  worst failure mode. Monaco diff is already available.
- **T4. Script badges on slicers, charts, pivots, panels** (today: shapes only,
  design-mode only) — seeing code on the object beats hunting a pane.
- **T5. Audit log viewer pane** (pairs with D12) — chronological
  subscribe/refresh/override/submit/consent events, filterable; data already
  persists invisibly in .cala.
- **T6. Publish-time disclosure** (pairs with D9): list every script/data
  source/region that will ship, per-script include/exclude, count in success toast.

### Medium

- **T7. Capability summary ("what this script can touch")**: static scan flagging
  `window.__TAURI__`/fetch/eval/dynamic-import plus tier + used context APIs,
  rendered in consent dialog, editor header, inspector rows. The minimum honest
  label until real sandboxing lands.
- **T8. Script action audit trail**: instrument UnlockedAPI/context mutators into a
  per-workbook activity log ("last activity" column in the inspector).
- **T9. MCP session activity feed** in the AIChat panel (external clients' tool
  calls, live, with optional approval-gate for run_script).
- **T10. Orphan flagging** (pairs with C10) + **scriptsPulled/Published in response
  types and toasts** (cheapest win; also fixes a Rust/TS mirroring violation).

---

## Blind spots the completeness critic added

1. **AI as first-class collaborator — substantially built.** PHILOSOPHY.md names it
   a pillar; the in-app AI Chat is now a real Anthropic client with an agentic
   tool loop, and the shared MCP + in-app tool surface spans far more than the
   original cell/summary/format set — read-only BI/cube tools
   (list_bi_connections, describe_bi_model, run_bi_query, cube_value, cube_kpi,
   cube_members) plus chart/pivot/table/named-range tools. Remaining: deeper
   collaborator UX over scripts/distribution.
2. **Recipient reach.** A .calp is consumable only by another Calcula install
   (Windows-only). The moment a publisher needs to reach a phone/Mac/external
   partner, they re-export and email — recreating the original problem. Building
   blocks exist unwired (xlsx_writer, print/PDF). Consider: static HTML/PDF render
   of a package version, or a minimal viewer.
3. **Compatibility contract.** No minimum-app-version/required-capabilities in
   package manifests (older client + newer package = silent failure), and no semver
   for the script/extension API — an app update can silently break every solution
   users built, which violates "never wait for the vendor" from the other side.
4. **Org-scale distribution.** Full directory per version (no dedup/delta/retention),
   update discovery = full-manifest polling per subscriber. Fine for v1; will not
   survive a daily-published large workbook with many subscribers.
5. **Customization on-ramp.** Nothing teaches users that scripting exists. Excel's
   on-ramp was the macro recorder: record, read generated code, start editing.
   Calcula has no recorder, no examples gallery, no in-app API docs beyond
   per-object scaffolds.
6. **Override layer for code.** Cell overrides have (will have) merge semantics;
   subscriber edits to a *distributed script* have none — clobber or shadow,
   silently, on refresh.
7. **Outbound-data transparency.** Writeback submit sends all drafts one-click with
   no preview of exactly what leaves the machine, to whom, under which subscription.
8. **Degraded-mode semantics.** When a script is declined/disabled/blocked, what
   does the user see? A stale cached value is itself a transparency failure
   (numbers produced by code the user refused to run). Define: distinct error for
   blocked UDFs, visible inert state for scripted buttons.

---

## Suggested sequencing

- **Wave 0 — Stop the bleeding (days):** P0.1–P0.7. Mostly small; restores honesty
  (dead menus, fabricated previews, dead tests, cosmetic security setting) and
  unblocks writeback consolidation (GATHER).
- **Wave 1 — Close the core loops (the .calp half):** D1+D2 (override capture +
  real conflict detection), D3 (submission semantics), D4 (governance enforcement),
  S1/T2 (provenance + consent + pre-pull review), D11 (query-region decommission).
  After this wave the distribution promise is *true* for trusted-org use.
- **Wave 2 — The trust architecture (the security half):** S2 (worker sandbox),
  S3 (withGlobalTauri), S4 (broker), S5 (checksums/signing), S6 (iframe), S7 (MCP),
  C9 (sanctioned capabilities so the sandbox doesn't amputate use cases).
  After this wave .calp can ship to untrusted recipients — the full vision claim.
- **Wave 3 — Product completeness (the customization half):** C1 (UDF bridge),
  C2/C7 (third-party loading + packaging/manager), C3/C4 (unify surfaces, undo-able
  script writes), C5/C6 (button/timeline/table/named-range), D5/D6 (publisher
  dashboard, subscription manager), T1 (code inspector), D9 (package fidelity),
  D8 (HTTP transport).
- **Wave 4 — Reach and growth:** critic items — viewer/export for non-Calcula
  recipients, compatibility contract, macro recorder + on-ramp, AI collaborator,
  org-scale registry.

## Refuted claims

None — all 55 verified proposals survived adversarial verification (several with
nuances incorporated above).
