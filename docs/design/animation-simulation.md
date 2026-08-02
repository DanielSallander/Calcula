# Animation / Simulation Playback

## Status

**Complete (2026-07-01).** Ships as the `Animation` extension (`app/extensions/Animation/`),
registered in `app/extensions/manifest.ts`. Builds on three existing foundations rather
than inventing new ones: the `scenario_show` transient-write precedent
(`app/src-tauri/src/scenario_manager.rs`), the generic per-extension persistence tier (A5,
`app/src/api/extensionData.ts`), and the capability-classified backend door (A3,
`app/src/api/backendCommands.ts`).

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
- `anim_apply_frame(writes, sheetIndex) -> AnimationFrameResult` — applies the frame's
  transient writes and recalculates dependents. It mirrors `scenario_show` step for step
  (`get_recalculation_order` + `get_column_row_dependents` → `evaluate_formula_multi_sheet`
  → `build_cell_data`).
- `anim_restore(token, sheetIndex) -> AnimationFrameResult` — restores the saved cells,
  recalculates, and drops the buffer.

**The key invariant, stated precisely:** `anim_apply_frame` does **not** append to the undo
stack and does **not** mark the document dirty. There is *no flag* that suppresses undo —
the command simply never calls any undo-recording path (it is not wrapped in a transaction
and does not touch `undo.rs`). This is exactly how `scenario_show` mutates + recalculates
the grid without producing an undo entry. Undo/redo therefore sees only intentional,
committed user actions — never an intermediate preview frame. On `stop`, `anim_restore`
puts the model back exactly; a frame is never serialized because playback is force-stopped
and restored on `SHEET_CHANGED` / `BEFORE_OPEN` / `BEFORE_NEW` / `BEFORE_SAVE` /
`BEFORE_CLOSE` and in `deactivate()`.

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
- **On-canvas control.** A floating play/progress control is rendered via the generic
  `registerGridOverlay` API (`overlay/playOverlay.ts`), torn down on `deactivate()`.
  Animation renders its **own** overlay — it does not add a `bind.input:"play"` to Charts.

---

## UI surfaces

- **Timeline panel** (`components/TimelinePanel.tsx`) — a saved-animation list
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
  snapshot/apply/restore *outside* any undo transaction (the `scenario_show` precedent) keeps
  the invariant clean without a special "animation mode" the rest of the app must know about.
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
