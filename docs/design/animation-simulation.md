# Animation / Simulation Playback

## Status

**Complete (2026-07-01).** Ships as the `Animation` extension (`app/extensions/Animation/`),
registered in `app/extensions/manifest.ts`. Builds on three existing foundations rather
than inventing new ones: the `scenario_show` recalculate-without-undo precedent
(`app/src-tauri/src/scenario_manager.rs`) — **but see the correction below: `scenario_show`
is NOT a transient write** — the generic per-extension persistence tier (A5,
`app/src/api/extensionData.ts`), and the capability-classified backend door (A3,
`app/src/api/backendCommands.ts`).

### Current as of 2026-08-16

- **SHIPPED and unchanged:** the engine/clock/four-driver architecture, the facades, GIF and
  WebM export, the persistence + undoable-spec tier.
- **SUPERSEDED (2026-08-07, by the `DocumentEffect` programme):** this document's original
  claim that "there is *no flag* that suppresses undo" and that Animation simply mirrors
  `scenario_show`. Animation's exemption is now **proof-carrying**: `anim_apply_frame` takes a
  required `token` and must present a registered restore snapshot before it may write
  (`TransientScope::prove_restore_registered`). See "The transient mechanism" below.
- **CORRECTED (this document was wrong, and the code says so):** `scenario_show` is **not** a
  transient write and never was. It applies values **permanently**, has no restore command, and
  correctly calls `DocumentEffect::mutates` (`app/src-tauri/src/scenario_manager.rs:277`). It is
  a precedent for *recalculating dependents without recording undo*, and for nothing more.
  Four places in the Rust source name this file by path as the source of that confusion, two of
  them regression tests that exist solely to stop someone copying the exemption to
  `scenario_show`: `document_effect.rs:357`, `scenario_manager.rs:24`,
  `document_effect_objects_tests.rs:486`
  (`scenario_show_cannot_claim_the_animation_transient_exemption`), and
  `document_effect_pilot_tests.rs:191`
  (`scenario_shows_shape_cannot_claim_the_transient_exemption`).
- **Nothing in this document is unbuilt.** All surfaces described here exist.

### Added 2026-09-21

- **The transient-write pattern now has a SECOND instance, and it has no backend in it.** The
  chart Format pane's hover preview (CI-14) snapshots into a TypeScript store rather than into a
  Rust `TransientScope`, so `DocumentEffect::transient` is not involved at all. That makes the
  distinction explicit for the first time: the *arm* is how the pattern is enforced when a write
  crosses to Rust; the *pattern* is snapshot / write-without-undo-or-dirty / restore, and it
  applies either way. See "A SECOND instance of the pattern, with no backend in it" below, and
  `docs/design/chart-interaction.md` §6.8 for the full exit-path list.

**Related:**
- `docs/design/scriptable-objects.md` — the composition-over-new-surface pattern this follows.
- `docs/design/wave3-scripting-security.md` — the broker / sandbox / capability model; Animation is a trusted built-in that reaches the backend through the same classified door.
- `docs/design/backend-facade.md` — `ExtensionContext.invokeBackend` + the `PRIVILEGED_BACKEND_COMMANDS` denylist that `export_gif` is classified under.
- `docs/design/c3-shared-object-model.md` — chart-param binding that the chart-param driver drives.
- `docs/design/vision-gap-review.md` — the feature-completeness record (Animation milestone entry).

---

## Context

Calcula already had a strong *what-if* toolkit — Scenario Manager, Goal Seek, Solver, Data
Tables, iterative calc — and a charting system with named params bound to cells/literals,
on-canvas widgets, and scoped re-render on cell change. What was missing is the MATLAB-style
payoff: pressing **play** and watching a business model evolve — a driver value advancing
over a frame range while the model recalculates and charts/cells repaint each frame.

Animation is a first-class **customizable Extension**, not a Core feature. It owns its
playback engine and UI; Core and Charts are unaware of it and only emit generic events /
expose generic facades that Animation consumes.

---

## Architecture: one engine, four drivers, transient delivery

An animation is a **generic `Driver` advanced by an async-aware playback clock**. The clock
knows nothing about cells, charts, scenarios, or RAND.

```ts
interface Driver {
  readonly frameCount: number;
  snapshot(): Promise<void>;             // capture model state to restore later
  applyFrame(t: number): Promise<void>;  // write driver value(s) transiently, recalc, repaint
  restore(): Promise<void>;              // restore snapshot + repaint (safe if snapshot never ran)
  frameLabel?(t: number): string;
}
```

- **Playback clock** — `app/extensions/Animation/lib/playbackClock.ts`. A single
  back-pressured async loop: it never schedules frame N+1 while frame N's `applyFrame` is
  still awaiting, so a slow recalc drops the frame rate instead of queueing work. Transport
  transitions (`play`/`pause`/`stop`/`step`/`seek`) await the in-flight loop promise, which
  removes the need for a generation counter.
- **Playback engine** — `app/extensions/Animation/lib/animationEngine.ts`. Wraps the clock,
  owns the active `Driver`, exposes `EngineState` to the UI (`subscribe`), and wires the
  four `setXDriver` entry points plus `loadSpec` / `getExportSource`.
- **Repaint** — `app/extensions/Animation/lib/repaint.ts` emits the existing
  `AppEvents.CELLS_UPDATED` (charts already listen and invalidate via
  `chartIntersectsChanges`) plus a raw `grid:refresh` for the Core canvas. No new
  `"animation"` event-source variant was needed.

### The transient mechanism (how frames avoid the undo stack)

The transient snapshot/apply/restore trio lives in `app/src-tauri/src/animation_commands.rs`,
keyed by a **caller-owned token** so a restore survives a frontend reload:

- `anim_snapshot(token, sheetIndex, cells)` — clones the listed cells into an `AppState`
  buffer (`AppState.animation_snapshots`) keyed by the token.
- `anim_apply_frame(token, sheetIndex, writes) -> AnimationFrameResult` — applies the frame's
  transient writes and recalculates dependents. It mirrors `scenario_show`'s *recalculation*
  step for step (`get_recalculation_order` + `get_column_row_dependents` →
  `evaluate_formula_multi_sheet` → `build_cell_data`) but **not** its dirty-flag behaviour.
  The `token` is **required** and is the whole enforcement mechanism, not a convenience
  (`app/src-tauri/src/api_types.rs:1943-1953`); an earlier revision of this document documented
  the signature without it.
- `anim_restore(token, sheetIndex) -> AnimationFrameResult` — restores the saved cells,
  recalculates, and drops the buffer.

**The key invariant, stated precisely:** `anim_apply_frame` does **not** append to the undo
stack and does **not** mark the document dirty. Undo/redo therefore sees only intentional,
committed user actions — never an intermediate preview frame. On `stop`, `anim_restore`
puts the model back exactly; a frame is never serialized because playback is force-stopped
and restored on `SHEET_CHANGED` / `BEFORE_OPEN` / `BEFORE_NEW` / `BEFORE_SAVE` /
`BEFORE_CLOSE` and in `deactivate()`.

**How that invariant is enforced (revised 2026-08-07 — this replaces "there is no flag").**
The original design relied on the command simply never calling an undo-recording path. Since
the `DocumentEffect` programme made `FileState::is_modified` private with a single writer, a
command that writes the grid must construct an effect, and Animation's is the **transient**
arm — the one exemption from dirtying the document. It is not asserted, it is proven:

- `frame_effect(state, token)` (`app/src-tauri/src/animation_commands.rs:226-233`) locks the
  snapshot registry, calls `TransientScope::prove_restore_registered(&snapshots, token)`, and
  only then returns `DocumentEffect::transient(&scope)`.
- `TransientScope` (`app/src-tauri/src/document_effect.rs:371-384`) is `#[must_use]` and its
  **only** constructor requires presenting the registry that the paired restore will read back,
  containing that exact token.
- `anim_apply_frame` refuses the write outright when no snapshot is on file
  (`animation_commands.rs:291-299`), returning an error rather than silently escaping the flag.

The operational definition, quoted from the gate's own doc comment: *"a write that is
guaranteed to be undone"*. This is precisely why `scenario_show` **cannot** claim the
exemption — it registers no restore, so it structurally cannot build a `TransientScope`.

### A SECOND instance of the pattern, with no backend in it (added 2026-09-21)

Until now this document was the only worked example of the transient-write pattern, and both of
its reference points — Animation and the `scenario_show` correction — are **Rust backend
commands**. That made the pattern read as if it *were* the `DocumentEffect::transient` arm. It is
not. The arm is how the pattern is enforced **when a write reaches the backend**; the pattern
itself is older and wider: *snapshot, write without entering the undo or dirty path, restore on
stop.*

The chart Format pane's **hover preview** (CI-14, `docs/design/chart-interaction.md` §6.8) is the
second instance, and it is instructive precisely because it has no Rust in it at all. Hovering a
colour swatch repaints the chart; clicking it writes one undo entry. The snapshot lives in a
**TypeScript module-scope store**, not in a `TransientScope`:

- `previewChartSpec(chartId, patch)` (`app/extensions/Charts/lib/chartStore.ts:185`) stashes the
  stored spec as `activePreview.original` and reassigns the render-time spec to the merge.
- `restoreChartSpecPreview()` (`:204`) puts it back and is safe to call on any exit path, however
  many times.

**What that means for the pattern.** `DocumentEffect::transient` is **not involved**, because
nothing reaches the backend — there is no Tauri invoke, so there is no `FileState` to dirty and no
effect to construct. The discipline is enforced by three things instead:

1. **`previewChartSpec` never calls `scheduleSave`.** That is the whole rule, and it is the reason
   the preview is not routed through `updateChartSpec`, which ends in `scheduleSave`
   unconditionally. A 300 ms debounce would otherwise persist whichever swatch the pointer last
   crossed on its way to the OK button, dirty the document, and leave the close-without-saving
   prompt guarding an edit the reader never made.
2. **Restore on every exit path, enumerated rather than assumed** — mouse-out, commit, pane close,
   selection retarget, chart deletion, File > New/Open, extension teardown. The list is kept in
   the code at `app/extensions/Charts/components/ChartFormatPane.tsx:341-349`, and in full with
   citations in chart-interaction.md §6.8.
3. **Two backstops, so a missed exit path is harmless rather than corrupting.**
   `updateChartSpec` / `replaceChartSpec` restore **before** they merge
   (`lib/chartStore.ts:690`, `:722`), so a real edit always starts from the true spec; and
   `flushDirtyCharts` persists the ORIGINAL spec while a preview is up, via `chartAsPersisted`
   (`:244`, used at `:470`), so an unrelated pending save — a drag scheduled 200 ms ago, firing
   while the reader hovers — cannot carry the preview to disk.

Backstop 1 is the frontend analogue of what `prove_restore_registered` buys the backend: neither
relies on the caller remembering. The difference is that Rust can make the proof a *type*, and
TypeScript cannot, so the guarantee is bought at the two choke points every real write passes
through instead of at the effect's constructor.

**The lesson for the next transient feature:** ask first whether the write crosses to Rust. If it
does, `DocumentEffect::transient` and a `TransientScope` are mandatory and the exemption is
proof-carrying. If it does not, the same three obligations still apply — no persist call, an
enumerated restore list, and a backstop at the path a real write takes — and they have to be
written down, because nothing in the compiler will ask for them.

### The four drivers (`app/extensions/Animation/drivers/`)

1. **Clock-cell** (`clockCellDriver.ts`) — the core mode. A driver cell swept `from → to`
   by `step`. Each `applyFrame` is one `anim_apply_frame`; the whole model recalculates and
   charts + cells repaint. Deterministic.
2. **Chart-param** (`chartParamDriver.ts`) — drives a chart's live param value each frame.
   **Pure frontend, no backend recalc** — it calls the `@api/chartParams` facade
   (`setChartParamValue`), and the chart resolves its own params/transforms and repaints.
   Frame count is derived from the param's `bind` (a stepper's `min/max/step`, or a
   cycle/segment's options). Deterministic.
3. **Scenario** (`scenarioDriver.ts`) — a keyframe tween across named scenarios from the
   Scenario Manager (`listScenarios` → `scenario_list`). Linear tween or step-snap between
   keyframes, emitted as `anim_apply_frame` writes; `snapshot` captures the changing cells,
   `restore` puts them back. Deterministic.
4. **Monte Carlo** (`monteCarloDriver.ts`) — each frame is one `anim_reroll_and_read`, which
   forces a full sheet recalculation (re-rolling `RAND` / `RANDBETWEEN`, which are volatile)
   and reads the outcome cell as an `f64`. Samples accumulate into a live histogram + running
   stats (`monteCarloStore.ts`, pure `computeStats` / `computeHistogram`). **Non-deterministic
   by design** — see the Rationale.

### Facade-driven cross-extension communication (IoC)

Animation drives Charts without importing Charts, and captures the grid without importing
Core internals — both through feature-neutral facades that register an implementation at
extension-activate time (the `@api/pivot.ts` `registerPivotApi` pattern):

- `@api/chartParams.ts` — a `ChartParamController` (`listAnimatableCharts` /
  `listChartParams` / `getChartParamValue` / `setChartParamValue` / `clearChartParamValue`).
  Charts registers the implementation in its `activate()` (`registerChartParamController`)
  and clears it to `null` on `deactivate()`. Animation calls the passthroughs with **no
  import of Charts internals**. The facade itself imports no extension — API neutrality holds.
- `@api/rendering.ts` — a `ChartRenderingApi` (`getChartFrameBitmap` /
  `getChartFrameImageData` / `isChartRenderPending` / `isChartRenderCurrent` / `chartsIdle`)
  plus `awaitRenderSettled({chartId?, maxFrames?})`. The settle barrier resolves only when
  no render is pending **and** the cached frame's version matches the latest invalidation
  (so a superseded frame is never captured), then double-`requestAnimationFrame`s.
- `app/src/core/lib/gridCapture.ts` — a Core primitive (`captureGridRegion(range)` /
  `getGridCanvas`) registered by `GridCanvas.tsx` and **exposed through `@api/rendering.ts`**
  rather than imported by any extension. This is the single sanctioned Core addition, for
  deterministic non-chart (grid-selection) export capture.

### Capability-gated backend channel

All backend calls flow through `app/extensions/Animation/lib/animationBackend.ts` =
`createBackendChannel("Animation")`, bound to `ctx.invokeBackend` in `activate()`. Raw
`invokeBackend` is banned in extensions (FACADE lint). Typed wrappers: `animSnapshot`,
`animApplyFrame`, `animRestore`, `animRerollAndRead`, `listScenarios`, `exportGif`.

---

## Implementation notes

- **Persistence (A5 + undo).** Specs persist through the generic per-extension tier
  (`getExtensionData` / `setExtensionData`), round-tripped in the `.cala` zip automatically.
  Because the plain tier records no undo, a `set_extension_data_undoable` command was added
  (Rust): it snapshots the prior value and records it through the data-driven restore
  registry (`undo_commands.rs`, `obj_extension_data` arm + `RESTORE_REGISTRY`) before
  mutating. Animation writes route through the undoable variant (`animationStore.ts`).
- **GIF export.** `export_gif` (Rust, the `gif` crate v0.13) encodes frames off the UI
  thread. It is classified `hostFilesystem`-privileged in `PRIVILEGED_BACKEND_COMMANDS`; the
  gate passes for the trusted built-in. The frontend runs a deterministic seek-loop:
  `seek(i)` → `awaitRenderSettled()` → grab RGBA from `getChartFrameImageData` (chart) or
  `captureGridRegion` (grid selection) → hand the frames to `export_gif`.
- **WebM export.** `webmExporter.ts` records live playback via `canvas.captureStream(fps)` +
  `MediaRecorder` (vp9 → vp8), saved through the dialog plugin + `writeBinaryFile`.
- **The play pill.** A floating play/progress/close control, shown whenever a driver is
  loaded (`overlay/playOverlay.ts` + `overlay/PlayPill.tsx`), torn down on `deactivate()`.
  Animation renders its **own** control — it does not add a `bind.input:"play"` to Charts.
  It is **viewport-pinned DOM chrome**, registered through `@api/ui`'s overlay registry and
  positioned over the grid canvas's bottom-left corner (`overlay/pillGeometry.ts`).
  It was previously a hit-testable floating **grid region** at a fixed sheet position, which
  put it on top of **A1:C2** and made it eat cell clicks — in the product, and across
  eighty-nine E2E spec files. A control must not live in cell coordinates: the cells are the
  document. See open-decisions-2026-08.md §2q / D4.
- **Unloading a driver.** Three product routes, all `playbackEngine.clearDriver()` (which
  restores the model first, so it is a strict superset of `stopAndRestore`): the pill's
  close control, the panel transport's **Unload** button, and the document-boundary events
  `BEFORE_OPEN` / `BEFORE_NEW` / `BEFORE_CLOSE`. `BEFORE_SAVE` and `SHEET_CHANGED`
  deliberately only **stop** — the user is still in the same workbook and wants to keep
  iterating. **Stop is not Unload**, and the two buttons stay separate for that reason.

---

## UI surfaces

- **Timeline panel** (`components/TimelineSections.tsx` — renamed from `TimelinePanel.tsx`
  when the panel-layout system made every ribbon/panel surface a set of per-group sections;
  imported at `app/extensions/Animation/index.ts:31`) — a saved-animation list
  (load/edit/delete/new), an ad-hoc driver quick-config, the transport (step-back /
  play-pause / stop / step-forward, scrubber, fps, loop), and an export bar (GIF | WebM).
  Renders the Monte Carlo view when a Monte Carlo run is active.
- **Create/edit dialog** (`components/AnimationDialog.tsx`, id `animation.editor`) — configures
  all four driver types; opened via the panel's **+ New** / **Edit** buttons (`showDialog`).
- **Monte Carlo view** (`components/MonteCarloView.tsx`) — a live histogram + running stats
  (trials, mean, std, min/max, p5, p95) over the accumulated samples.
- **Status bar + floating overlay** — a transport status item and the on-canvas play control.
- **Entry point** — the **View** menu → **Animation Timeline**.

---

## Design rationale

- **Why transient writes bypass the undo stack.** Undo is a record of *intentional* user
  edits. A 100-frame playback is one gesture ("play"), not 100 edits; recording frames would
  bury real history and let a preview leak into a saved file. Modelling this as
  snapshot/apply/restore *outside* any undo transaction keeps the invariant clean without a
  special "animation mode" the rest of the app must know about. (The original text credited
  this to "the `scenario_show` precedent"; that borrowing was only ever valid for the
  *recalculate-without-undo* half. Corrected 2026-08-16 — see the status header.)
- **Composition over a new execution surface.** Animation adds no new sandbox, capability, or
  script tier. It *consumes* existing what-if data (scenarios), existing chart params, and the
  existing transient-recalc pattern. The only new backend surface is three token-keyed
  transient commands plus one reroll-and-read — all feature-open, none capability-granting.
- **Capability-neutral facades vs. the capability-gated channel.** Cross-*extension* control
  (drive a chart's param, capture a chart frame) goes through feature-neutral `@api` facades
  that carry no privilege — the facade is a typed contract, not a wire-through. Cross-*trust*
  reach (touch the Rust backend, write a GIF to disk) goes through the capability-classified
  `createBackendChannel` door. The two are deliberately separate axes.
- **Monte Carlo is intentionally non-deterministic.** `anim_reroll_and_read` re-rolls
  volatiles every trial, so re-running an export yields different samples. This is the point
  of Monte Carlo and is the one place Animation departs from the deterministic
  snapshot/apply/restore guarantee of the other three drivers. Tests assert that trials
  *accumulate*, never specific outcome values.

---

## Verification

- **Unit (Vitest)** — the `Animation` lib `__tests__` (playback frame math, driver
  snapshot/restore round-trips, scenario interpolation, Monte Carlo `computeStats` /
  `computeHistogram`), the `@api/rendering.ts` settle barrier, and the Rust
  `set_extension_data_undoable` restore round-trip.
- **Rust** — `anim_apply_frame` → `anim_restore` leaves the grid byte-identical and the undo
  stack untouched; `encode_gif` emits a valid GIF89a header. `cargo check --tests` clean.
- **Boundaries** — `npm run lint:boundaries` clean (no ALIEN / FACADE / API_NEUTRALITY /
  SIBLING_ISOLATION violations); `tsc` 0 errors.
- **E2E (Playwright / WebView2 CDP)** — `app/e2e/tests/animation.spec.ts`:
  - *Clock-cell* — sweep A1 `0 → 10`, assert transient writes recalc `B1 = A1*2`, play to the
    end, and **stop restores** A1/B1 to the original model.
  - *Scenario* — two `scenario_add` keyframes, linear tween, step writes a tweened value, stop
    restores.
  - *Chart-param* — a chart with a stepper-bound param (0..100 step 25 → 5 frames); assert the
    derived frame count and transport (`1/5` → `2/5` → play → `5/5`).
  - *Monte Carlo* (smoke) — a `=RANDBETWEEN(1;6)` outcome; assert trials *accumulate* in the
    live histogram (never specific values — the driver is non-deterministic).
  - *Export GIF (backend)* — invokes the `export_gif` command directly with synthetic RGBA
    frames and an explicit temp path, asserting a valid animated GIF (`GIF89a`) is written to
    disk. The native save dialog itself cannot be JS-stubbed in a running Tauri app — its IPC
    entry point (`window.__TAURI_INTERNALS__.invoke`) is a locked, non-configurable property —
    so, like `encryption.spec.ts`, the test exercises the backend command directly rather than
    clicking through the dialog.
  - *Export controls* — with a driver loaded, both the Export GIF and Export WebM buttons are
    enabled; the WebM button being enabled also confirms `MediaRecorder` +
    `canvas.captureStream` are available in WebView2.
  - *The play pill claims no cell* (added with the grid-region → viewport-pinned DOM fix) —
    with a driver loaded, a click at A1 still selects A1. Asserted the way the defect actually
    presented: it checks **both** that the selection moved **and** that playback did not start,
    because checking only the selection would pass on a pill that stopped stealing the click
    while still starting an animation underneath it.
  - *Pill close control* — stops playback, restores the model, and unloads the driver (the
    model comes back even when the control is clicked mid-flight).
  - *Stop is not Unload* — the panel's **Stop** keeps the driver loaded, **Unload** gives it
    back. The two buttons are deliberately separate (see Implementation notes) and this pins
    the difference.

  The spec file holds **9** tests as of 2026-08-16; this list previously named only the first 6.
