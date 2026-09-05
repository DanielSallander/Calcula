# Calcula - Open-Source Spreadsheet Engine

Calcula is an ambitious open-source spreadsheet application (Excel alternative) built for high performance and extensibility using a microkernel architecture.

## Project Vision

Calcula exists to bring back the customizability that made Excel great -- formulas, VBA, add-ins: the ability to build your own solution to any specific problem, today, yourself. The industry's move toward Power BI -- itself a genuinely good tool -- took that away: users are locked to the vendor's visuals and data model, with no custom scripting, waiting for Microsoft to ship a feature instead of building it.

At the same time, Calcula must fix the legitimate downsides that got VBA shunned and Excel files distrusted. These are requirements every feature is held to:

- **Security:** Custom code must run sandboxed, with tiered access levels -- never with full machine access like VBA macros. (Current state: DONE through Wave 3. Object scripts run in per-script hardened Worker realms; distributed extensions that opt in run sandboxed too; all privileged reach is broker-mediated behind a capability model -- the canonical id list is `ALL_CAPABILITY_IDS` in `app/src/api/scriptHost/capabilityIds.ts`, never re-typed elsewhere -- with a declared-capability ceiling, consent, and audit. Notebooks/one-off scripts run in an isolated Rust QuickJS interpreter over cloned grid state. See docs/design/wave3-scripting-security.md.)
- **Transparency:** Custom code must be visible and auditable. The user must always know where code resides and what it can touch -- never hidden inside a binary file. Scripts arriving in distributed packages must not run without explicit consent. (Current state: DONE through Wave 3. Consent + a per-script audit ring + a transparency panel; Ed25519 signing/TOFU for .calp packages AND distributed extensions via signed sidecar manifests verified at scan; a single queryable script-surface taxonomy. One per-workbook audit trail now spans all script activity: the Rust QuickJS surfaces (notebook/one-off/MCP) record always-on, structured grid-mutation entries (surface + id + sheet + range), and capability calls also persist -- net.fetch/bi.query/bi.sql authoritatively server-side in their Rust gates, and the rest (storage/ui.html/formula.udf + broker-policy denials) via a write-through from the broker ring -- so capability use survives reload too. Surfaced as "Scripts"/"Capabilities" categories in the audit viewer. The codeInventory "reach" for grid-only surfaces is no longer asserted: `core/script-engine/src/manifest.rs` is the source of truth and its own test BOOTS a real QuickJS runtime to diff the manifest against what the realm actually registers (both directions), while `app/src/api/__tests__/interpreterReachDrift.test.ts` reads that Rust file at test time and diffs it against every TypeScript consumer. The direction is fixed Rust -> TypeScript, because the renderer can be compromised and the interpreter is where the sandbox is.)
- **Distribution:** Excel's model of emailing copies of files is replaced by `.calp` **applications**
  published into a **workspace**: publish/subscribe report distribution, plus two-way data collection
  via writeback. The vocabulary is Power BI's, and deliberately: a *workspace* is the folder or URL
  that hosts applications, an *application* is the `.calp` a team develops together, and a developer
  opens one as a **working copy** (Distribution > Open Application for Editing) to edit and push it
  back through the gates in `core/calp/src/publish.rs`. A workspace carries a `workspace.calcula`
  pointer file so it can be selected in a FILE dialog rather than a folder picker; the pointer and
  its directory collapse to one pin scope in `strip_workspace_marker`
  (`core/calp/src/workspace_id.rs`), because if they did not, one user who browsed to the file and
  another who typed the folder would pin the same publisher under two identities and the second
  would see a name-conflict hijack warning aimed at a colleague. **`package` and `registry` survive
  ONLY as wire and on-disk names** -- serde fields (`package_name`, `registry_url`, `registryPath`),
  filenames (`calp-manifest.json`), the `caps.packages` script namespace, and the `"package-inspector"`
  Tauri window label matched by `capabilities/package-inspector.json`. Renaming any of those breaks a
  contract; renaming a type, a command, a UI string or a doc does not. See
  `docs/design/calp-workspace-collaboration.md`.

Every feature decision should serve this vision: maximum user customizability, with the security and transparency that Excel/VBA never had.

## Tech Stack

- **OS:** Windows 11
- **Backend:** Rust (workspace structure)
- **Frontend:** React, TypeScript, Vite
- **Bridge:** Tauri (connects Rust to WebView)
- **Rendering:** HTML5 Canvas (supports 1M+ rows)

## Architecture Overview

### Microkernel Architecture (VS Code Style)

Calcula follows a strict **Microkernel Architecture** with three distinct layers:

1. **The Kernel (Core)** - Minimal, stable engine that knows nothing about specific features
2. **The Shell (Host)** - Application frame that orchestrates lifecycle and loads extensions
3. **The Extensions** - All user-facing features (even built-in ones)

### The Four Layers

1. **The Brain (Backend):** Rust - Cell Dependency Graph, Formula Parsing, Persistence
2. **The Face (Core Frontend):** TypeScript + React - Virtualized grid rendering on HTML5 Canvas (zero dependencies on Shell or Extensions)
3. **The API (Facade):** Strictly typed "Sandbox" layer - the ONLY bridge between Core and Extensions
4. **The Bridge:** Tauri - connects Rust backend to WebView frontend

### Directory Structure
```
Calcula/
├── app/
│   ├── src/
│   │   ├── core/           # The Engine. PURE.
│   │   │                   # RULE: Cannot import from 'shell' or 'extensions'
│   │   │
│   │   ├── shell/          # The Host
│   │   │                   # Responsibilities:
│   │   │                   # 1. Mounts the Core Grid
│   │   │                   # 2. Scans the 'extensions' folder
│   │   │                   # 3. Registers them into the Core
│   │   │
│   │   └── api/            # The "Sandpit"
│   │                       # The ONLY interfaces extensions are allowed to touch
│   │
│   └── extensions/         # MOVED OUTSIDE 'src'. 66 feature extensions, flat:
│       ├── Charts/          #   Charts, Pivot, Sorting, Slicer, Table, ... (one dir each)
│       ├── Pivot/
│       ├── ...              #   (full list registered in extensions/manifest.ts)
│       ├── BuiltIn/         # Built-in dialogs/menus (FindReplace, FormatCells, HomeTab, ...)
│       ├── _shared/         # Shared widgets + libs reusable across extensions
│       │                    #   (the ONLY sanctioned cross-extension code; NOT @api)
│       ├── _standard/       # (legacy bucket; currently only conditional-formatting)
│       ├── _template/       # Scaffold for authoring a new extension
│       ├── manifest.ts      # Static list of built-in extensions (load order)
│       └── index.ts
│
│   # 3rd-party extensions are NOT in the repo: scanned at runtime from
│   # %APPDATA%/com.calcula.app/extensions/.
│
├── core/                   # Rust workspace: grid engine, parser, persistence,
│                           #   pivot-engine, script-engine, .cala/.calp formats
│
└── model-engine-lib/       # BI/semantic-model engine (own Cargo workspace).
                            #   Merged in from the former separate "Calcula
                            #   Engine Lib" repo 2026-07-24 (history preserved).
                            #   Crates: engine-core, engine-query,
                            #   engine-connectors, engine (= crate `bi-engine`).
                            #   NOT the same as core/engine (`grid_engine`).
                            #   See model-engine-lib/CLAUDE.md for its rules.
```

### What Lives Where

**Core (`app/src/core/`)** - The "Kernel". Universal primitives only:
- Grid rendering pipeline & virtualization
- Selection model & Cursor logic
- Input handling (Keyboard/Mouse primitives)
- Undo/Redo stack
- **CONSTRAINT:** Never imports from `shell` or `extensions`

**Shell (`app/src/shell/`)** - The "Container":
- Window Layout (Sidebar, Status Bar)
- Extension Host (scanning, loading, activating extensions)
- **CONSTRAINT:** Orchestrates Core and Extensions but contains no business logic

**API (`app/src/api/`)** - The "Contract":
- `types.ts`: Stable interfaces re-exported from Core
- `commands.ts`: Registry definitions
- **CONSTRAINT:** The ONLY import allowed in an Extension file

**Extensions (`app/extensions/`)** - The "Features":
- Built-in: Formatting, Sort/Filter, Charts, Financial/Statistical Functions
- User: Future 3rd party plugins
- **CONSTRAINT:** Must function exactly like 3rd party plugins. No "backdoor" access to Core internal state

### Extension Points (via `src/api`)

Extensions interact with Core exclusively through the API Facade:
- `commands.register(id, handler)` - Register actions (e.g., "format.bold")
- `ui.ribbon.registerTab(tabDef)` - Inject UI elements
- `formulas.registerFunction(name, impl)` - Add calculation logic
- `events.onSelectionChange(cb)` - Listen for context

## CRITICAL RULES - STRICT ENFORCEMENT

### Architecture & Import Boundaries

1. **The "Alien" Rule:** The Core (`src/core`) must NEVER import from `app/extensions` or `src/shell`
2. **The Facade Rule:** Extensions (`app/extensions`) must ONLY import from `src/api` (`@api`); they must not import another extension's internals — share via `@api` or `extensions/_shared`. Deep imports into `src/core`/`src/shell` are strictly forbidden. (Enforced: `npm run lint:boundaries` / `app/eslint.boundaries.js`.)
3. **Dogfooding:** Built-in features (Formatting, Charts) must be built using the public Extension API. If the API cannot support a feature, improve the API rather than hacking the feature into Core
4. **Inversion of Control:** The Core does not call Extensions. The Core emits events/hooks (via the API), and Extensions respond
5. **Primitive vs. Logic:** If a feature requires new logic (e.g., Sorting), implement generic primitives in Core (e.g., read/write range) and specific business logic in an Extension
6. **Feature Location:** Default to building features as Extensions (`app/extensions/`; built-in dialogs/menus live under `app/extensions/BuiltIn/`) unless they are foundational primitives (like Rendering or Undo/Redo). Features that *preview* or *simulate* without persisting must follow the **transient-write pattern**: snapshot the model, apply writes that never enter the undo stack or dirty the document, and restore on stop/cancel. Animation demonstrates this — each frame advances a driver, recalculates dependents, and repaints without touching the undo graph; stopping restores the original state (backend precedent: `scenario_show`; see `docs/design/animation-simulation.md`)
7. **The Seam Rule:** When one extension needs another's domain, reach it through a feature-neutral `@api` seam — `autoFilterService`, `printService`, `macroRunService`, `buttonControlService`, `pictureControlService`, `controlsService`, `groupingService`, `tracingService`, `textToColumnsService`, plus `rendering` (frame/grid capture) and `chartParams`. Never import the owning extension, and never hand-roll its domain by calling the backend directly. The Macro Recorder wrote button metadata itself as `{ label }` and got an **invisible button while the backend reported success**: the rendered caption key is `text`, geometry must be WALKED from the anchor cell's actual column widths (never multiplied), `pinToGrid` must be written explicitly as `"false"` because an absent value defaults to "moves", and nothing paints at all until the control is registered in the floating-control store and the overlay regions re-synced. A shape's recipe is seventeen keys long. A copied recipe is a second source of truth that drifts on the owner's first default change — so callers say WHAT they want and the owning extension decides HOW. If no seam exists, add one (`app/src/api/controlsService.ts` is the newest worked example). Seams point one way only: `@api` must never import from `app/extensions`.

### Naming Conventions (Rust <-> TypeScript API Boundary)

**THE GOLDEN RULE:**
- **TypeScript:** Always use `camelCase` for ALL properties (textColor, backgroundColor, styleIndex)
- **Rust:** Always use `snake_case` for ALL fields (text_color, background_color, style_index)
- **Serde handles conversion automatically** via `#[serde(rename_all = "camelCase")]`

**Rust API types** (in `api_types.rs`):
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]  // <-- This handles ALL fields
pub struct CellData {
    pub row: u32,
    pub col: u32,
    pub style_index: usize,  // Rust uses snake_case
}
```

**TypeScript types** (in `types.ts`):
```typescript
export interface CellData {
  row: number;
  col: number;
  styleIndex: number;  // TypeScript uses camelCase
}
```

**RULES:**
- Use `#[serde(rename_all = "camelCase")]` on Rust structs
- NEVER use manual `#[serde(rename = "...")]` on individual fields
- All Tauri API types must live in `api_types.rs` (Rust) and `types.ts` (TS)
- TypeScript interfaces in `types.ts` must exactly mirror Rust structs in `api_types.rs`

### Document Mutation -- `DocumentEffect` (Rust backend)

`FileState::is_modified` is **private** (`app/src-tauri/src/persistence.rs`) and
`app/src-tauri/src/document_effect.rs` is its **sole writer**. That one flag gates BOTH the
close-without-saving prompt and AutoRecover, so a command that changes saved state without setting
it loses the user's work twice over and in silence. The census in `document_effect.rs`'s own header
found 256 of the then-746 Tauri commands mutating without setting it, which is why the rule is
enforced by the compiler, not by review.

- **Persisted backend state is `Persisted<T>`, never a bare `Mutex<T>`.** `read()` is free;
  `write(&effect)` requires a `DocumentEffect`. **Do not count the fields by hand, and do not
  quote a number from this file.** `the_appstate_lock_census_reconciles`
  (`app/src-tauri/src/document_effect.rs`) parses the struct body and asserts the split, so the
  build fails the moment it moves. As pinned today: **106 fields — 64 `Persisted<T>`, 40 bare
  `Mutex`/`RwLock`, 2 neither** (`undo_stack`, `calc_cancel`). Three successive hand-counts in
  this very paragraph were wrong before that test existed — 36, then 51, then 59, each from a
  different grep spelling — which is why the number now lives in a test and this paragraph no
  longer explains how to grep for it. `grids` / `grid` are additionally pinned by their exact
  declaration text, so a silent revert to a bare `Mutex` fails the build. The bare ones are
  mid-migration and listed as a work item in
  `docs/design/open-items.md`; they are overwhelmingly DERIVED caches (the dependency
  maps, the spill maps, `id_registry`, `gather_cache`) rather than persisted state, so a command
  touching only those can still mutate without deciding — but check the field before assuming it.
  Declare any NEW persisted store `Persisted<T>` from the start.
- **Every mutating command constructs exactly one arm:**
  - `DocumentEffect::mutates(&FileState)` — dirties **at construction**, so possession of the value
    is proof the flag is set (no early `return` can skip it). Construct it AFTER every gate that can
    still refuse, and inside the branch that actually changes something.
  - `DocumentEffect::transient(&TransientScope)` — the preview/simulation exemption that keeps the
    transient-write pattern legal. A `TransientScope` can only be built by presenting a snapshot
    registry that ALREADY holds the restore token, so Animation qualifies and `scenario_show`, which
    registers no restore, structurally cannot claim it.
  - `DocumentEffect::deliberately_clean(CleanReason::…)` — a **closed** enum: `LoadingFromDisk`,
    `Navigation`, `DerivedCache`, `RecalcCompanion`, `AutoRecoverProbe`, `AuditTrail`. The whole
    audit is `rg deliberately_clean app/src-tauri/src`. A case that fits no variant is a signal to
    think, not to add a variant in passing.
- `mark_saved(&FileState)` is the only clear (save / open / new). `DirtyFlag` emits
  `document:dirty-changed` on the clean<->dirty **transition only**, so the title-bar asterisk needs
  no per-command event and a 10,000-cell paste produces one message; reads announce nothing.
- Gated commands use `lock_pending()` then `.authorize(&effect)`, which keeps the gate and the
  mutation in ONE critical section. Never `read()`, drop the lock, then `write()` — Tauri dispatches
  on a thread pool, so that is a TOCTOU window in every protection-checked command.

### `.cala` Format Versioning

One `format_version` lives in `manifest.json` and is currently at **8**
(`CALA_MAX_SUPPORTED_FORMAT_VERSION`, `core/calcula-format/src/manifest.rs`; re-read on 2026-09-04 —
this paragraph said 7 for a while after the code moved, so check the constant, not the sentence). The writer stamps the
highest minimum any feature ACTUALLY PRESENT requires (`stamp_feature_format_version`, raise never
lower); the reader refuses anything higher rather than half-understanding it.

- **Bump explicitly** when the saved shape changes — nothing infers it.
- **Stamp conditionally.** `USER_HIDDEN_MIN_FORMAT_VERSION` (4), `SHEET_VIEW_MIN_FORMAT_VERSION` (5)
  `SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION` (6), `SPILL_EXTENT_MIN_FORMAT_VERSION` (7) and
  `PINNED_FILTER_MIN_FORMAT_VERSION` (8) are written only when the document actually carries that
  state -- per SHEET for the first three, per CELL for the spill extent (stamped only when some
  cell has an `sp` field), and for 8 only when some slicer/ribbon filter is pinned above level 1 or
  some BI pivot carries an `engine_filters` entry (`zip_io.rs:243`) -- so an ordinary workbook
  keeps the lowest version that can express it and stays openable by older builds. Version 8 is a
  *lie* case, not a loss case: an older reader drops the pin and the pivot comes back UNFILTERED
  with no error anywhere, which is the reason it links the version rather than a feature id.
- **The test for whether a section deserves a version link at all:** would an older reader
  MISHANDLE the document, or merely lose something? Ignoring an unknown section is usually fine — it
  is dropped on the next save and the user loses cosmetic state. A link is warranted when the drop
  is a *lie*: schedules silently disarmed, a stale workbook that comes back looking calculated,
  rows hidden to keep working data out of a distributed report coming back VISIBLE.
- Otherwise declare a **manifest feature id** with an unconditional read and leave the version
  alone. Embedded media did exactly that — pictures are content-addressed under `media/{sha256}`,
  and an older reader that drops them loses images, which is visible loss rather than
  misinterpretation (pinned by `media_declares_a_feature_id_but_never_raises_the_format_version`
  in `core/calcula-format/src/zip_io.rs`).

### Coding Standards

1. **No Placeholders:** Write full implementation code. Do not use placeholders like `// ... rest of code`
2. **Windows Native:** Assume Windows 11 paths and environment
3. **Clean Output:** Avoid Unicode characters in terminal output (use `[OK]` instead of checkmarks)
4. **Modularity:** Keep logic isolated. UI should never calculate; Backend should never render
5. **Completeness:** Provide full functional blocks or complete files
6. **Folder-as-Module:** For TypeScript, prefer the "Folder-as-Module" pattern to keep files organized into smaller, manageable sizes

## Common Mistakes to Avoid

- Using `style_index` in TypeScript (should be `styleIndex`)
- Using `text_color` in TypeScript (should be `textColor`)
- Using `styleIndex` in Rust (should be `style_index`)
- Forgetting `#[serde(rename_all = "camelCase")]` on new Rust structs
- Adding `#[serde(rename = "fieldName")]` to individual fields (use struct-level instead)
- Importing from `extensions/` in core code (core must never depend on extensions)
- Importing deep into `src/core/...` from extensions (use `src/api` only)
- Creating backdoor access for built-in extensions (they must use the same API as 3rd party extensions)
- Importing another extension's internals — or calling the backend to hand-roll its domain — instead of using the `@api` seam for it (see the Seam Rule); the transient-write discipline lives behind the seam, not in the caller
- Reaching for `window.confirm` / `window.alert` / `window.prompt` (or the bare `confirm(...)` / `alert(...)` / `prompt(...)` globals). All three are broken under Tauri: `confirm` returns a **`Promise<boolean>`**, so `if (!window.confirm(m))` tests `!Promise` — always false — and the guard NEVER fires; `alert` is fire-and-forget and not even async, so awaiting it does not wait either; `prompt` is not replaced by the plugin at all. This shipped six times, patched at the call site each time. **The globals are now a lint error repo-wide** (`dialogGuardConfigs` in `app/eslint.boundaries.js`, gated by `npm run lint:boundaries`, self-tested by `app/src/api/__tests__/dialogGlobalsBan.test.ts`). Use `confirmAsync` / `alertAsync` / `promptAsync` from `@api/dialogs` and **await** them — they fail CLOSED, so a dialog that cannot be shown is a refusal, never consent. When unit-testing a gate, double the **Tauri** shape (`mockReturnValue(Promise.resolve(false))`); a synchronous boolean double is what let this defect pass review for so long. Proved live end-to-end in `app/e2e/journeys/consent-refusal.spec.ts` (refusal AND positive control for each gate; the native dialog is driven over Win32 because Tauri's IPC cannot be stubbed from the page)
- Adding an `object.setState` aspect without a matching row in `vSetState` (`app/src/api/scriptHost/validators.ts`) — the validator ends in `return true`, so a new aspect defaults to **unvalidated at restricted tier with no capability**. That is how `shape.setProperty` became a route for a distributed script to persist a multi-megabyte `data:` URI into a signed `.calp`. The standing rule is "a script may REFERENCE media already in the document, never INTRODUCE bytes": `src` accepts a `media:{sha256}` handle or `""`, and bytes enter only through the Rust validator (`inspect_media`) behind `cap.fileImportMedia`
- Registering a cross-sheet dependency from the AST's spelling. `CrossSheetDependentsMap` is keyed by the workbook's OFFICIAL sheet name, but the lexer uppercases bare identifiers (`core/parser/src/lexer.rs`), so `=Sheet1!A2` is stored as `SHEET1!A2` while quoted `='Sheet1'!A2` keeps its case. Go through `normalize_cross_sheet_refs` (`app/src-tauri/src/lib.rs`) — one raw registration froze a revisited sheet's cross-sheet recalculation for the whole session
- Writing a command that permutes or clears a range without recalculating dependents. `sort_range` shipped recalculating nothing at all, and `clear_range` shipped the same way. **Both are fixed** (verified 2026-08-15): each ends in a PHASE B that DROPS every guard it is holding — the recalculation takes the same grid/dependency mutexes and std mutexes are not reentrant — and then calls the shared `cascade_cross_sheet_dependents` / `recalc_after_active_sheet_bulk_rewrite` (`app/src-tauri/src/commands/data.rs`) over the cells that actually changed. Copy that two-phase shape; never hand-copy the walk itself — three copies had already drifted apart
- Editing one of the handful of files with MIXED line endings (e.g. `app/src/api/grid.ts`, `core/engine/src/undo.rs`, `core/parser/src/tests.rs`) without checking first — an exact-match edit against the wrong ending silently fails to apply

## The "Calcula" Decision Matrix

When developing a new feature, ask these three questions:

| Question | If YES... | If NO... |
|----------|-----------|----------|
| "Is it a Primal? Does the grid need this to simply exist (e.g., coordinates, scrolling, basic pixel rendering)?" | CORE | Move to next question |
| "Is it a Bridge? Is this a generic tool that any extension might need (e.g., 'Show a Dialog,' 'Read a Cell,' 'Interchange format')?" | API | Move to next question |
| "Is it a Feature? Is this a specific user-facing behavior (e.g., Data Validation, Charts, Pivot, Formatting)?" | EXTENSION | It's an Extension |

## Examples of What Goes Where

**CORE:**
- Grid virtualization and Canvas rendering
- Cell coordinates and range logic
- Selection model (active cell, ranges)
- Keyboard/Mouse event primitives
- Undo/Redo stack
- Copy/Paste clipboard primitives

**API:**
- Command registry (`commands.register`)
- UI injection points (`ui.ribbon.registerTab`)
- Formula registration (`formulas.registerFunction`)
- Event subscriptions (`events.onSelectionChange`)
- Generic data access (`getCellValue`, `setCellValue`)

**EXTENSIONS:** (a few examples)
- Bold/Italic/Font formatting
- Sort and Filter
- Charts and Graphs
- Data Validation
- Financial functions (PMT, NPV, IRR)
- Statistical functions (AVERAGE, STDEV)
- Pivot Tables
- Animation / Simulation playback (transient frame playback with no undo entries; four drivers: clock-cell, chart-param, scenario-tween, Monte Carlo)

## Development environment
In order for Rust environment to work it must first be set using the script:
core\setup-rust-env.ps1

**What is currently OPEN lives in `docs/design/open-items.md`** -- a short, dated, code-cited
list. `docs/design/open-decisions-2026-08.md` is the 18k-line narrative ARCHIVE behind it: read
it for WHY a decision was made, never as a live status (its own S35a measured its "still open"
claims as roughly a third stale in the already-fixed direction). Defects with a reproduction go
in `tests/regression/bug-ledger.json` via its allocator, which assigns ids and rejects duplicates.

**Four environment rules that cost a run each when broken** (verified 2026-08-16):

- **`CARGO_TARGET_DIR` must point outside the repo** (`C:/Users/Salle/AppData/Local/calcula-target`).
  Dropbox locks the in-repo `target/` mid-build (os error 32), and the in-repo tree is currently
  corrupt -- it fails to link `app_lib.dll` with ~40 `LNK2001 anon.*.llvm.*`. Nothing sets the
  variable for you: there is no `.cargo/config.toml`, so **which binary an E2E run exercises is a
  function of ambient shell state**. `app/e2e/buildTarget.ts` resolves it the way cargo will and
  `global-setup` prints the target, the binary, its size and its build time before launching.
- **Never force-kill `msedgewebview2` wholesale.** Those processes also belong to Windows
  SearchHost, and Calcula itself RENDERS in WebView2 -- killing them by image name destroyed a
  journey run. Use `app/scripts/kill-stale-dev.mjs`, which targets `app.exe`/`Calcula.exe` by PID.
- **No gate proves the app can be LINKED.** CI (`.github/workflows/ci.yml`) runs `cargo test
  --workspace` and `cargo check --workspace --benches` with `working-directory: core`; `cargo
  check` does not link, and `cargo test --lib` links a test executable, not the `app_lib.dll` the
  app loads. A green CI is compatible with an app that cannot start. Only a `tauri` build or an
  E2E launch exercises the link -- and never edit `src-tauri` during an E2E run.
- **A sabotage that is a no-op passes.** When proving a test has teeth, first confirm the sabotage
  actually changed behaviour; several "verified" guards here were verified by edits that did
  nothing. Shell tools lie the same way here: Git Bash `sed`/`cat -A` STRIP `\r`, so they report
  a pure-CRLF file as LF, and `grep -c $'\x00'` degrades to an empty pattern that "matches" every
  line, so it can never detect a NUL byte. Measure endings and NUL bytes with node, not the shell.

`generate_handler!` in `app/src-tauri/src/lib.rs` registers 786 commands (recounted 2026-09-01; bracket-matched parse, comments stripped LINE-WISE, all unique -- the same figure docs/design/backend-facade.md reports independently, and BOTH were re-run together, because updating one of two "independent" counts is how they stop being independent). **How you strip the comments changes the answer**: a parse that splits the bracket on commas and strips `//` per chunk reads 789, because four doc comments in there contain a comma -- each swallows the command name after it AND leaves a fragment standing as an entry, net +4. That parse is where the "787" and "789" recounts came from. Nothing enforces this number, so re-run the parse -- line-wise -- rather than trusting the sentence. Its debug-build
dispatch frame sits on the OS MAIN thread (tao requires the event loop there, so wrapping it in a
larger-stack `thread::spawn` panics); `app/src-tauri/build.rs` links with `/STACK:33554432` (32 MB)
to hold it. Adding commands in bulk eats that headroom -- the symptom is
`thread 'main' has overflowed its stack` at startup or first invoke.

The BI/model engine lives in `model-engine-lib/` (its own Cargo workspace, in
this repo since 2026-07-24). Build/test it with `cargo` from that directory;
the app consumes it as the `bi-engine` path dependency. Its own coding rules
(including the MANDATORY `docs/host-integration-changelog.md` entry for every
host-facing change) are in `model-engine-lib/CLAUDE.md`.

## Git Commit Messages

When I ask for a commit message, or when starting a conversation, check for uncommitted
changes using `git diff` and `git status`. Suggest a conventional commit message based
on the changes. Format: `type(scope): description`. Do not run git commit -- only
provide the message text so I can paste it into the Source Control input box.

**End-of-feature rule (every session):** Whenever a feature or milestone is finished,
end the session by providing a git commit message for the work -- maximum 3 rows, in a
copy-able code block. Never run `git commit`; only output the message text.

## Backward compatibility
Since we are currently not in production there is no need at all for backward compatibility.