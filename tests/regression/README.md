# Calcula Regression Testing System

Unified testing infrastructure — all test layers orchestrated into one system.
Runs on demand or unattended with optional Claude Code auto-fix feedback loop.

## Quick Reference — Commands

All commands run from `app/`:

### Individual Test Layers

| Command | What it does |
|---------|-------------|
| `yarn test` | Vitest unit tests (~443 files) |
| `yarn e2e` | Functional E2E tests (auto-launches app) |
| `yarn e2e:visual` | Visual regression screenshot tests |
| `yarn e2e:all` | Both functional + visual E2E |
| `yarn e2e:manual` | Functional E2E against already-running app |
| `yarn e2e:manual:all` | All E2E against already-running app |
| `yarn e2e:report` | Open last HTML report |

### Visual Baselines

| Command | What it does |
|---------|-------------|
| `yarn e2e:visual:update` | Regenerate golden screenshots (no review) |
| `yarn e2e:visual:baseline` | Regenerate + Claude Code reviews for correctness |
| `yarn e2e:visual:baseline:auto` | Regenerate + Claude Code reviews + auto-fixes issues |
| `yarn e2e:visual:review` | Review existing baselines (no regeneration) |

### Full Regression Suite

| Command | What it does |
|---------|-------------|
| `yarn regression` | Full suite (Rust + Unit + E2E + Visual), report only |
| `yarn regression:auto` | Full suite with Claude Code auto-fix loop (max 5 iterations) |

### Regression Runner Options

```bash
node tests/regression/regression-runner.mjs [options]

  --mode=manual|auto       Manual = report only. Auto = Claude Code fixes failures.
  --max-iterations=N       Max fix/re-test cycles in auto mode (default: 5)
  --skip-rust              Skip cargo test phase
  --only=rust|unit|e2e|visual   Run only one layer
  --max-files=N            Max files Claude Code can modify per iteration (default: 10)
```

## Workflow: First-Time Setup

1. **Start the app** with CDP enabled (or let the runner do it automatically):
   ```bash
   # Option A: Let the test runner handle it
   yarn e2e:visual:baseline

   # Option B: Manual - start app first, then run tests
   powershell e2e/launch-with-cdp.ps1
   yarn e2e:visual:update    # generate screenshots
   yarn e2e:visual:review    # Claude Code reviews them
   ```

2. **Review the generated baselines** in `e2e/visual/__screenshots__/`
   Claude Code will flag any screenshots that look wrong.

3. **Commit the baselines** — they are now the visual "ground truth".

## Workflow: Daily Development

Just develop as normal. When you want to check for regressions:

```bash
yarn e2e:manual:all     # quick check against running app
```

## Workflow: Full Regression Run

**Manual mode** — run all tests, review report:
```bash
yarn regression
# Report at: app/e2e/results/regression-report.html
```

**Auto mode** — Claude Code fixes failures automatically:
```bash
yarn regression:auto
# Afterwards:
#   1. Open app/e2e/results/regression-report.html
#   2. Check VSCode Source Control for uncommitted changes
#   3. If fixes look good:  commit them
#   4. If fixes are wrong:  discard them (git checkout .)
```

## Workflow: After All Tests Pass

When all tests are green, the regression runner automatically:
1. Reads `registry.json` for uncovered features
2. Asks Claude Code to suggest test scenarios for the gaps
3. Writes suggestions to **`tests/regression/suggested-scenarios.md`**

**To work with suggestions:**
1. Open `tests/regression/suggested-scenarios.md`
2. Edit, reorder, or delete scenarios as you see fit
3. Add `<!-- user-edited -->` anywhere to prevent overwrite on next run
4. When ready, ask Claude Code: *"Implement the scenarios in suggested-scenarios.md"*
5. After implementing, update `registry.json` coverage fields

## Workflow: Intentional UI Changes

When you change the UI on purpose (new layout, theme, etc.):
```bash
yarn e2e:visual:update          # regenerate baselines
# or with Claude Code review:
yarn e2e:visual:baseline:auto   # regenerate + review + auto-fix
```

Commit the updated screenshots.

## Safety Guards (Auto Mode)

- Changes are left as uncommitted modifications — you commit or discard
- Stops automatically after 3 consecutive iterations with no changes
- Stops when failures are infrastructure issues (timeouts, app not starting)
- Max iteration cap (default 15) prevents runaway changes
- Max files per iteration (default 10) limits blast radius
- Claude Code only gets Edit, Read, Grep, Glob, Bash tools

## File Layout

```
tests/regression/
  registry.json              68 features, 4 priority tiers, coverage tracking
  suggested-scenarios.md     Claude-suggested new tests (edit this!)
  regression-runner.mjs      Orchestrator: Rust -> Unit -> E2E -> Visual -> Report
  validate-baselines.mjs     Feeds screenshots to Claude Code for review
  README.md                  This guide

app/e2e/
  tests/                     36 functional E2E specs (existing, unchanged)
  visual/                    Visual regression specs
    core-visual.spec.ts        Grid, formatting, selection, menus
    workflow-visual.spec.ts    Cross-cutting user scenarios
  helpers/
    grid.ts                  Grid interaction helper (existing, unchanged)
    screenshots.ts           Screenshot comparison utilities
  results/                   Generated reports, Claude Code logs (gitignored)
```

## Test Layers Detail

| Layer | Framework | Count | What it catches |
|-------|-----------|-------|----------------|
| Rust backend | `cargo test` | ~400+ tests | Engine, parser, persistence logic |
| Vitest unit | Vitest + jsdom | 443 files | TS state, API contracts, rendering logic |
| Functional E2E | Playwright + CDP | 36 specs | Broken user workflows, interactions |
| Visual regression | Playwright screenshots | 2 specs | UI rendering changes, layout shifts |

## Feature Coverage Registry

`registry.json` tracks every feature with:
- **tier**: 1 (core), 2 (high-use), 3 (extensions), 4 (specialized)
- **coverage**: `full`, `partial`, `unit-only`, `visual-only`, `none`
- Test file references per layer

Current: 68 features — 26 partial, 5 unit-only, 37 uncovered.

## Adding Tests

### Visual checkpoint in a test

```typescript
import { takeGridScreenshot, takeDialogScreenshot } from "../helpers/screenshots";

await takeGridScreenshot(page, "my-feature-state");
await takeDialogScreenshot(page, "my-dialog", ".dialog-selector");
```

### New feature in the registry

Add to `features` array in `registry.json`:
```json
{
  "id": "feat.my-feature",
  "name": "My Feature",
  "tier": 2,
  "category": "Data",
  "description": "What it does",
  "coverage": "none",
  "unitTests": [],
  "e2eTests": [],
  "screenshots": [],
  "notes": "Not yet tested"
}
```

## Coverage Gap Analysis & Suggested Scenarios

When all tests pass, the regression runner automatically:

1. Reads `registry.json` to find features with `none` or `unit-only` coverage
2. Asks Claude Code to suggest concrete E2E test scenarios for those gaps
3. Writes the suggestions to **`tests/regression/suggested-scenarios.md`**

This is the file you edit to shape the test suite:

- **Review** each suggestion - does the scenario make sense?
- **Edit** the steps if you want to adjust what the test does
- **Delete** scenarios you don't want
- **When ready**, ask Claude Code: *"Implement the scenarios in suggested-scenarios.md"*
  or build them yourself in `app/e2e/tests/` or `app/e2e/visual/`
- **After implementing**, update `registry.json` to reflect the new coverage

The file is regenerated each regression run (when green), but only overwrites if you
haven't modified it since the last generation. If you've edited it, the new
suggestions are written to `suggested-scenarios-new.md` instead so your edits
are preserved.

## Prerequisites

- **E2E tests**: App must be running with CDP (auto-handled by test runner, or use `e2e/launch-with-cdp.ps1`)
- **Auto mode**: `claude` CLI must be in PATH
- **Rust tests**: Toolchain via `core/setup-rust-env.ps1`
