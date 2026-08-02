# Architecture Boundary Inventory (Wave A)

Generated 2026-06-27 from `npm run lint:boundaries` (the dedicated gate config
`app/eslint.config.boundaries.js`, which runs only the architecture-boundary
rules). This is the authoritative remediation list for Wave A.

## Enforcement status — Wave A COMPLETE (all rules at `error`, gate green)

| Boundary | Rule | Severity |
|---|---|---|
| Alien (Core ✗→ Shell/Ext) | `no-restricted-imports` | **error** ✓ |
| Facade (Ext → src/api only) | `no-restricted-imports` | **error** ✓ |
| API neutrality (api ✗→ ext) | `no-restricted-imports` + `boundaries` | **error** ✓ (Batch 2) |
| Sibling isolation (ext ✗→ ext) | `boundaries/element-types` | **error** ✓ (Batch 3) |

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

Flip severities in `app/eslint.boundaries.js` → `BOUNDARY_SEVERITY`.
Excluded from sibling isolation: `__tests__`, `*.test`, `*.spec`, and
`extensions/TestRunner/**` (dev-only integration-test harness that imports other
extensions' internals to test them). The `manifest.ts`/`index.ts` aggregators
and app-entry `*Main.tsx` composition roots may reference any extension.

## Batch 2 — API-layer findings (2)

- **`src/api/pivot.ts` + `src/api/lib.ts` → `extensions/Pivot/*`** (A2): facade
  re-exports ~70 fns + ~90 types from the Pivot extension. Move the Pivot
  contract into `src/api` (or the `api_types.rs ↔ types.ts` mirror).
- **`src/api/notifications.ts` → `shell/Toast/useToastStore`** (new; layering
  inversion api→shell): invert so the Shell registers a toast sink into `@api`
  and `notifications.ts` calls through a registry.

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

## Out of Wave A scope (tracked, not flagged-to-error here)

- **`shell/Layout.tsx` → `BuiltIn/StandardMenus`** (A4): the Shell hard-mounts a
  specific built-in's component, bypassing the manifest. Convert to an `@api`
  shell-region capability. The boundary rule now **allows** shell→extension (the
  Shell is the extension host — distinct from the Alien Rule, which forbids
  core→extension), so this is not gate-flagged; the "bypasses-manifest" nuance
  isn't expressible via element-types and is tracked here for the A4 wave.
