# Architecture Boundary Inventory (Wave A)

Generated 2026-06-27 from `npm run lint:boundaries` (the dedicated gate config
`app/eslint.config.boundaries.js`, which runs only the architecture-boundary
rules). This is the authoritative remediation list for Wave A.

## Current as of 2026-08-16

Re-audited against `app/eslint.boundaries.js` and the source tree; `npm run lint:boundaries` was
run and is **clean, zero output**. Wave A is complete and **every finding this document lists as
open has since been fixed** — each was fixed by the exact remedy the finding proposed, which is
why the findings are marked resolved in place rather than deleted (the reasoning is the value).

- **Batch 2 finding 1 — RESOLVED.** The Pivot contract moved into `@api`:
  `src/api/pivotTypes.ts` (1147 lines) now holds it, `PivotApi` at `:1093` is supplied by the
  Pivot extension via `registerPivotApi` (IoC), and `src/api/pivot.ts` is down to 61 lines
  importing only `./backend` and `./pivotTypes`.
- **Batch 2 finding 2 — RESOLVED.** `src/api/notifications.ts` imports nothing from the Shell;
  the Shell registers a toast sink (`registerToastSink`), exactly the inversion proposed.
- **"Out of Wave A scope" A4 — RESOLVED.** `src/shell/Layout.tsx:49` now uses
  `getShellComponents` / `onShellComponentsChange` from `../api/ui`; its comment reads *"Replaces
  the former hard import of the StandardMenus extension component — the shell no longer imports
  app/extensions."* Repo-wide grep confirms zero `extensions/` imports under `src/shell/`.
- **Two boundaries have been ADDED since this table was written** (raw-door bans and the dialog
  guard) plus one hardening (`dependency-nodes`) — see the enforcement table below.
- **Two boundaries are MISSING from this document entirely** because they postdate it:
  `DocumentEffect` (backend) and the Seam Rule (cross-extension). Both are now recorded at the
  end of this file.

## Enforcement status — Wave A COMPLETE (all rules at `error`, gate green)

| Boundary | Rule | Severity |
|---|---|---|
| Alien (Core ✗→ Shell/Ext) | `no-restricted-imports` | **error** ✓ |
| Facade (Ext → src/api only) | `no-restricted-imports` | **error** ✓ |
| API neutrality (api ✗→ ext) | `no-restricted-imports` + `boundaries` | **error** ✓ (Batch 2) |
| Sibling isolation (ext ✗→ ext) | `boundaries/element-types` | **error** ✓ (Batch 3) |
| **Raw backend door** — ext ✗→ `invokeBackend` from `@api/backend` | `no-restricted-imports` `importNames` | **error** ✓ (A3; `eslint.boundaries.js:61-68`) |
| **Raw Tauri invoke** — ext ✗→ `invoke` from `@tauri-apps/api/core` | idem | **error** ✓ (A3; `:75-81`) |
| **Raw Tauri event bus** — ext ✗→ `emit`/`listen` from `@tauri-apps/api/event` | idem | **error** ✓ (A3; `:87-93`) |
| **Dialog globals** — `confirm`/`alert`/`prompt` banned repo-wide | `no-restricted-globals` + `no-restricted-properties` | **error** ✓ (`dialogGuardConfigs` `:134-167`, spread in at `:170`) |

**Trap for the next reader: the config contradicts itself, and the prose half is the stale half.**
`app/eslint.boundaries.js` still carries a header comment (`:18-23`) saying severity "is staged"
-- that API_NEUTRALITY is 'warn' until A2 lands and SIBLING is 'warn' until A1 lands. Both landed;
`BOUNDARY_SEVERITY` fifteen lines below (`:33-38`) reads `alien/facade/apiNeutrality/sibling` all
`'error'`, and the gate is green with all four enforcing. The executable truth is the object, not
the comment above it. Verified 2026-08-16; reported to the config's owner and deliberately not
edited here (this was a documentation pass, and a stale comment has no runtime behaviour to
reproduce, so it is not a ledger entry either). The same staged-severity text is repeated in
`.github/workflows/architecture-boundaries.yml:12-13` ("API-neutrality and sibling-isolation are
staged to error as the Wave A remediation lands") -- note it says "staged to error", not "warn", so
a grep for 'warn' does not find it.

The three raw-door bans are `importNames`-scoped on purpose: typed `@api/backend` wrappers, the
other `@tauri-apps/api/event` symbols, and the legitimate plugin-dialog / webviewWindow / path
imports all stay allowed, so the ban is surgical rather than a blanket module block.

**Hardening (not in the original generation):** `'boundaries/dependency-nodes': ['import',
'dynamic-import', 'export']` (`eslint.boundaries.js:244`). The plugin defaults to `['import']`,
which let sibling-isolation and api→shell violations be **laundered through `export … from` and
dynamic `import()`** — both invisible to the gate. A boundary that only inspects one of three
syntactic doors is not a boundary.

## What was done (Batch 3)

All 24 cross-extension leaks resolved; `npm run lint:boundaries` is clean.
- **Moved to `_shared`**: the JsonView toggle widget (`useJsonToggle`,
  `JsonToggleButton`, `JsonToggleEditor`, `MonacoJsonEditor` →
  `_shared/components/jsonToggle`); `pivotEvents`, `useFindStore`,
  `functionCatalog`, `calcula.d.ts`, `bi-api` → `_shared/lib`;
  `CellStylesGallery` → `_shared/components`; app settings extracted to
  `_shared/lib/appSettings`.
- **Promoted to `@api`**: `listWorkbookScripts` + `ScriptSummary` (`@api/workbookScripts`,
  for Controls); `deleteNotebook` + `requestOpenNotebook`/`NOTEBOOK_OPEN_EVENT`
  (`@api/notebookBackend`, for FileExplorer — open routed via app event, not the store).
- **Severed**: Pivot opens the chart dialog by its public string id
  (`"chart:createDialog"`) instead of importing `Charts/manifest`; FileExplorer
  lists/deletes notebooks via `@api/notebookBackend` and reads settings from `_shared`.

Note: `bi-api`'s types were already `@api/backend` re-exports (repointed); the
pre-existing **duplicate pivot type hierarchy** (`pivot-api.ts` vs
`components/types.ts`, see Batch 2) remains and is tracked separately.
*(Still true as of 2026-08-16 — both `extensions/Pivot/lib/pivot-api.ts` and
`extensions/Pivot/components/types.ts` exist. But this note predates the Batch 2 fix and so
misses the important part: the **canonical** pivot contract is no longer either of them, it is
`src/api/pivotTypes.ts`. The two in-extension hierarchies are now duplicates of a third,
authoritative source rather than of each other.)*

Flip severities in `app/eslint.boundaries.js` → `BOUNDARY_SEVERITY`.
Excluded from sibling isolation: `__tests__`, `*.test`, `*.spec`, and
`extensions/TestRunner/**` (dev-only integration-test harness that imports other
extensions' internals to test them). The `manifest.ts`/`index.ts` aggregators
and app-entry `*Main.tsx` composition roots may reference any extension.

## Batch 2 — API-layer findings (2) — BOTH RESOLVED (see status header)

- **`src/api/pivot.ts` + `src/api/lib.ts` → `extensions/Pivot/*`** (A2): facade
  re-exports ~70 fns + ~90 types from the Pivot extension. Move the Pivot
  contract into `src/api` (or the `api_types.rs ↔ types.ts` mirror).
  **RESOLVED** — done as proposed; contract now in `src/api/pivotTypes.ts`, implementation
  supplied by IoC (`registerPivotApi`).
- **`src/api/notifications.ts` → `shell/Toast/useToastStore`** (new; layering
  inversion api→shell): invert so the Shell registers a toast sink into `@api`
  and `notifications.ts` calls through a registry.
  **RESOLVED** — done as proposed; `registerToastSink`, and `notifications.ts` imports no Shell.

## Batch 3 — Sibling-extension leaks (24 sites)

Triage: **(P)** promote a contract to `@api` · **(S)** move a shared widget/asset
to `extensions/_shared` · **(X)** sever / route through an existing `@api` surface.

| From | Into (internal) | Sites | Triage | Note |
|---|---|---|---|---|
| Charts, Pivot, Slicer, Table | `JsonView/lib/useJsonToggle` + `components/JsonToggle{Button,Editor}` | 12 | **S** | reusable "edit as JSON" toggle + Monaco editor → `_shared/components` |
| FileExplorer | `ScriptNotebook/lib/notebookApi`, `useNotebookStore`, `types` | 3 | **P** | a notebooks API surface in `@api` |
| FileExplorer | `Settings/SettingsView` | 1 | **X** | read via existing `@api/settings` |
| Charts | `Pivot/lib/pivotEvents` | 1 | **P** | pivot event contract → `@api/events` |
| Pivot | `Charts/manifest` | 1 | **X** | invoke "create chart" via `commands.execute` |
| Controls | `ScriptEditor/lib/scriptApi` | 1 | **P** | scripting contract → `@api` (scriptHost) |
| DefinedNames | `BuiltIn/FormulaAutocomplete/functionCatalog` | 1 | **P** | formula-function catalog → `@api/formulaAutocomplete` |
| Distribution | `BusinessIntelligence/lib/bi-api` | 1 | **P** | BI query contract → `@api` |
| Search | `BuiltIn/FindReplaceDialog/useFindStore` | 1 | **P**/**S** | find/replace state |
| ScriptNotebook | `ScriptEditor/calcula.d.ts?raw` | 1 | **S** | shared `.d.ts` asset → `_shared` |
| StandardMenus | `HomeTab/components/CellStylesGallery` | 2 | **S** | cell-styles gallery widget → `_shared` |

## Out of Wave A scope (tracked, not flagged-to-error here) — RESOLVED

- **`shell/Layout.tsx` → `BuiltIn/StandardMenus`** (A4) — **RESOLVED**, converted to exactly the
  `@api` shell-region capability proposed (`Layout.tsx:49-54`). Original finding: the Shell hard-mounts a
  specific built-in's component, bypassing the manifest. Convert to an `@api`
  shell-region capability. The boundary rule now **allows** shell→extension (the
  Shell is the extension host — distinct from the Alien Rule, which forbids
  core→extension), so this is not gate-flagged; the "bypasses-manifest" nuance
  isn't expressible via element-types and is tracked here for the A4 wave.

## Boundaries added after this inventory (recorded 2026-08-16)

This file is the repo's boundary inventory, so the two boundaries below belong in it even though
neither is enforced by the ESLint gate. Both postdate the 2026-06-27 generation.

### `DocumentEffect` — the backend's dirty-state boundary (compiler-enforced)

Not a lint rule: a *type* boundary in Rust. `FileState::is_modified` is private and
`app/src-tauri/src/document_effect.rs` is its sole writer; persisted state is `Persisted<T>`
whose `write()` demands a `DocumentEffect`, so a command cannot mutate saved state without
declaring what it did. **59** of `AppState`'s 104 pub fields are converted (the rest are
mid-migration and listed in `docs/design/open-decisions-2026-08.md`). Three arms only:
`mutates` (dirties at construction, so possession is proof), `transient` (constructible only by
presenting a restore registry holding the token), `deliberately_clean(CleanReason::…)` over a
closed enum, so the whole audit is one `rg deliberately_clean`. Motivation: a census found
**256 of the then-746** commands mutating without setting the flag, which gates both the
close-without-saving prompt and AutoRecover. Full treatment in `docs/design/backend-facade.md`
and in `CLAUDE.md`.

### The Seam Rule — cross-extension reach (convention + API-neutrality gate)

Sibling isolation (Batch 3) says an extension may not import another's internals. The Seam Rule
says what to do *instead*: reach the other domain through a feature-neutral `@api` seam, and
never hand-roll it by calling the backend directly. Eleven seams exist in `src/api/`:
`autoFilterService`, `buttonControlService`, `chartParams`, `controlsService`, `groupingService`,
`macroRunService`, `pictureControlService`, `printService`, `rendering`, `textToColumnsService`,
`tracingService`. Seams point **one way only** — `@api` must never import from `app/extensions`,
which the API-neutrality rule enforces (`eslint.boundaries.js:205-217`).

The rationale is worth keeping concrete: the Macro Recorder wrote button metadata itself and
produced an **invisible button while the backend reported success** — the caption key is `text`
not `label`, geometry must be walked from the anchor cell's actual column widths, `pinToGrid`
must be written explicitly as `"false"`, and nothing paints until the control is registered in
the floating-control store. A shape's recipe is seventeen keys long, and a copied recipe is a
second source of truth that drifts on the owner's first default change. Callers say WHAT they
want; the owning extension decides HOW.
