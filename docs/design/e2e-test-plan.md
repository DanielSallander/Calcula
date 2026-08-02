# Calcula E2E Test Plan

Comprehensive Playwright E2E test plan for the Calcula spreadsheet application.
Tests run against the live Tauri app via WebView2 CDP (Chrome DevTools Protocol).

**Current status: 186 passing, 7 skipped (5 WebView2 CDP + 2 VLOOKUP bug)**

## Infrastructure

| Component | Location | Purpose |
|-----------|----------|---------|
| Config | `app/playwright.config.ts` | Playwright settings, global setup/teardown |
| Global Setup | `app/e2e/global-setup.ts` | Auto-launches `yarn tauri dev` with CDP |
| Global Teardown | `app/e2e/global-teardown.ts` | Kills Tauri process |
| Fixtures | `app/e2e/fixtures.ts` | Worker-scoped CDP connection, page/grid fixtures |
| Grid Helper | `app/e2e/helpers/grid.ts` | Canvas cell interaction (click, type, read) |
| Launch Script | `app/e2e/launch-with-cdp.ps1` | Manual mode: launch app with CDP |

### Running Tests

```bash
cd app
yarn e2e           # automatic: launches app, runs tests, tears down
yarn e2e:manual    # connect to already-running app (use launch-with-cdp.ps1)
yarn e2e:report    # view HTML report from last run
```

### Known Limitations

- **Undo/Redo via CDP**: Ctrl+Z does not reach the grid's keyboard handler when
  sent through WebView2 CDP. Likely intercepted at the browser level. Tests are
  marked `.fixme`. Undo works fine when tested manually.
- **Canvas interaction**: The grid is rendered on `<canvas>`, so cells cannot be
  targeted via DOM selectors. The `GridHelper` calculates pixel coordinates from
  grid geometry (100px col width, 24px row height, 50px row header, 24px col header).
  Custom column/row sizes and scroll positions are not yet handled.
- **Locale**: The app uses the system locale. Decimal tests accept both `.` and `,`.
- **Locale**: Swedish locale uses comma (,) as decimal separator and semicolon (;) as argument separator. Formulas entered via keyboard.type() have commas converted to dots. Use `setCellValueDirect()` for formulas with commas, or use semicolons as argument separators when typing.

---

## Test Phases

### Phase 1: Core Grid Operations [DONE]

**Status:** 34 passing, 5 fixme
**Files:** `editing.spec.ts`, `formula.spec.ts`, `navigation.spec.ts`

#### editing.spec.ts

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Type a number and commit with Enter | PASS | |
| 2 | Type text and commit with Enter | PASS | |
| 3 | Type and commit with Tab moves to next column | PASS | |
| 4 | Escape cancels editing and reverts | PASS | |
| 5 | Overwrite a cell value | PASS | |
| 6 | Delete key clears cell contents | PASS | |
| 7 | F2 enters edit mode on selected cell | PASS | |
| 8 | Double-click enters edit mode | FIXME | CDP connection drop |
| 9 | Typing directly on selected cell starts editing | FIXME | Adjacent to fixme'd test |
| 10 | Undo reverts the last cell edit | FIXME | Ctrl+Z via CDP limitation |
| 11 | Redo re-applies the undone edit | FIXME | Ctrl+Z/Y via CDP limitation |
| 12 | Undo a Delete operation | FIXME | Ctrl+Z via CDP limitation |
| 13 | Integer input | PASS | |
| 14 | Decimal input | PASS | Accepts both 3.14 and 3,14 |
| 15 | Negative number input | PASS | |
| 16 | Boolean TRUE | PASS | |
| 17 | Long text input (200 chars) | PASS | |

#### formula.spec.ts

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Entering a formula keeps the = prefix | PASS | Was failing before bug fix |
| 2 | Formula calculates correctly | PASS | |
| 3 | Editing a formula cell preserves the = prefix | PASS | |
| 4 | Formula round-trip: enter, leave, re-edit, re-enter | PASS | |
| 5 | Formula with cell references =E3*E2 keeps = prefix | PASS | Exact repro of reported bug |
| 6 | Changing a dependency recalculates the formula | PASS | |
| 7 | Chain of dependent formulas all recalculate | PASS | |
| 8 | SUM function | PASS | |
| 9 | IF function | PASS | |
| 10 | Nested formula | PASS | |
| 11 | Formula with absolute reference | PASS | |
| 12 | Plain text is NOT treated as formula | PASS | |
| 13 | Number is NOT treated as formula | PASS | |
| 14 | Empty formula (just =) handled gracefully | PASS | |

#### navigation.spec.ts

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Arrow keys move the active cell | PASS | |
| 2 | Enter moves down after committing a value | PASS | |
| 3 | Tab moves right after committing a value | PASS | |
| 4 | Ctrl+Home goes to A1 | PASS | |
| 5 | Name box navigates to typed cell ref | PASS | |
| 6 | Navigate to far cell and back | PASS | |
| 7 | Clicking a cell shows its address in name box | PASS | |
| 8 | Shift-click selects a range | PASS | |
| 9 | Sheet tab is visible and clickable | PASS | |

---

### Phase 2: Cell Formatting [DONE]

**Status:** 16 passing
**File:** `formatting.spec.ts`

**Tests use two verification methods:**
- `isFormatActive(id)` — checks ribbon button `data-active` attribute (fast, but affected by async ribbon state)
- `getCellStyleProp(ref, prop)` — reads cell style directly via Tauri API `get_cell` + `get_style` (reliable)

**Verification pattern:**
- `data-testid="fmt-{id}"` attributes added to Home tab toggle buttons
- `data-active="true"` set when the toggle is active

**Bugs fixed:**
- Off-screen cells (rows 30+) were clicked at wrong pixel positions. Fixed by adding scroll-aware cell clicking in GridHelper.
- Selection stale state in HomeTabComponent.tsx fixed using `getGridStateSnapshot()` and `lastSelectionRef`.

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Toggles bold on a cell | PASS | |
| 2 | Toggling bold twice removes it | PASS | |
| 3 | Bold persists after navigating away | PASS | |
| 4 | Bold applied via ribbon persists | PASS | |
| 5 | Toggles italic on a cell | PASS | |
| 6 | Italic persists after navigating away | PASS | |
| 7 | Toggles underline on a cell | PASS | |
| 8 | Toggling underline twice removes it | PASS | |
| 9 | Bold + italic on same cell | PASS | |
| 10 | Bold + italic + underline on same cell | PASS | |
| 11 | Multiple formats persist after navigating away | PASS | |
| 12 | Bold on a formula cell | PASS | |
| 13 | Strikethrough via ribbon button | PASS | |
| 14 | Strikethrough toggle off via ribbon | PASS | |
| 15 | Unformatted cell shows no active formats | PASS | |
| 16 | Bold applies to entire selected range | PASS | |

Scenarios still to add:
- [ ] Font size change
- [ ] Font family change
- [ ] Text color change
- [ ] Background color change
- [ ] Clear formatting

### Phase 3: Number Formatting [DONE]

**Status:** 13 passing
**File:** `number-formatting.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Percent button formats decimal as percentage | PASS | |
| 2 | Percent format on integer | PASS | |
| 3 | Percent format persists after navigating away | PASS | |
| 4 | Comma button adds thousands separator | PASS | |
| 5 | Comma format on small number | PASS | |
| 6 | Increase decimal adds one decimal place | PASS | |
| 7 | Decrease decimal removes one decimal place | PASS | |
| 8 | Multiple increase decimal clicks add more places | PASS | Fixed app bug in increase/decrease decimal logic that couldn't parse descriptive format names |
| 9 | Percent format on formula cell | PASS | |
| 10 | Comma format on formula cell | PASS | |
| 11 | Number format survives cell re-edit | PASS | |
| 12 | Format applied to multiple cells via range | PASS | |

### Phase 4: Clipboard Operations [DONE]

**Status:** 8 passing
**File:** `clipboard.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Copy cell and paste to another cell | PASS | |
| 2 | Cut cell and paste (source cleared) | PASS | |
| 3 | Paste overwrites existing content | PASS | |
| 4 | Copy number preserves value | PASS | |
| 5 | Copy formula shifts relative references | PASS | |
| 6 | Copy formula shifts column references | PASS | |
| 7 | Copy range preserves all values | PASS | |
| 8 | Copy preserves bold formatting | PASS | |

### Phase 5: Sheet Management [DONE]

**Status:** 6 passing
**File:** `sheets.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Sheet tab visible with correct name | PASS | |
| 2 | Adding sheet via button creates new tab | PASS | |
| 3 | Switching between sheets preserves data | PASS | |
| 4 | Rename sheet via event | PASS | |
| 5 | Add and delete sheet via UI and API | PASS | |
| 6 | Cross-sheet formula reference | PASS | |

### Phase 6: Merge Cells [DONE]

**Status:** 5 passing
**File:** `merge.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Merge 2x2 range preserves top-left value | PASS | |
| 2 | Merged region detected for all cells | PASS | |
| 3 | Unmerge restores individual cells | PASS | |
| 4 | Merge via ribbon button | PASS | |
| 5 | Formula in merged cell still works | PASS | Single cell merge edge case also passes |

### Phase 7: Find & Replace [DONE]

**Status:** 6 passing
**File:** `find-replace.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | find_all returns matching cells | PASS | |
| 2 | Case-sensitive find | PASS | |
| 3 | Match entire cell find | PASS | |
| 4 | No matches returns empty | PASS | |
| 5 | replace_all replaces all occurrences | PASS | |
| 6 | replace_single replaces one cell | PASS | |

### Phase 8: Sort & Filter [PLANNED]

**File:** `sort-filter.spec.ts`

Scenarios to test:
- [ ] Sort ascending
- [ ] Sort descending
- [ ] Sort by multiple columns
- [ ] AutoFilter dropdown
- [ ] Filter by value
- [ ] Clear filters

### Phase 9: Fill Handle [PLANNED]

**File:** `fill-handle.spec.ts`

Scenarios to test:
- [ ] Drag fill with numbers (auto-increment)
- [ ] Drag fill with text (copy)
- [ ] Drag fill with formulas (references shift)
- [ ] Drag fill series (dates, days, months)

### Phase 10: Freeze Panes [PLANNED]

**File:** `freeze-panes.spec.ts`

Scenarios to test:
- [ ] Freeze top row
- [ ] Freeze first column
- [ ] Freeze at arbitrary cell
- [ ] Unfreeze panes
- [ ] Scrolling with frozen panes

### Phase 11: Charts [DONE]

**Status:** 3 passing
**File:** `charts.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Create chart via save_chart | PASS | |
| 2 | Update chart spec | PASS | |
| 3 | Delete chart | PASS | |

### Phase 12: Pivot Tables [DONE]

**Status:** 5 passing
**File:** `pivot.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Create pivot table | PASS | |
| 2 | Add row/value fields | PASS | |
| 3 | Get pivot view | PASS | |
| 4 | Refresh pivot cache | PASS | |
| 5 | Delete pivot table | PASS | |

### Phase 13: Data Validation [PLANNED]

**File:** `data-validation.spec.ts`

Scenarios to test:
- [ ] List validation (dropdown)
- [ ] Number range validation
- [ ] Validation error message
- [ ] Invalid input rejected
- [ ] Clear validation

### Phase 14: Conditional Formatting [PLANNED]

**File:** `conditional-formatting.spec.ts`

Scenarios to test:
- [ ] Highlight cells greater than value
- [ ] Color scale
- [ ] Data bars
- [ ] Clear conditional formatting

### Phase 15: File Operations [DONE]

**Status:** 4 passing
**File:** `file-operations.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Editing marks modified | PASS | |
| 2 | Save file | PASS | |
| 3 | Get current file path | PASS | |
| 4 | Modifying after save | PASS | |

### Phase 16: Named Ranges [PLANNED]

**File:** `named-ranges.spec.ts`

Scenarios to test:
- [ ] Create named range via name box
- [ ] Use named range in formula
- [ ] Navigate to named range
- [ ] Delete named range

### Phase 17: Print [DONE]

**Status:** 5 passing
**File:** `print.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Get default page setup | PASS | |
| 2 | Set landscape | PASS | |
| 3 | Set print area | PASS | |
| 4 | Clear print area | PASS | |
| 5 | Page breaks | PASS | |

### Phase 18: Advanced Formulas [PARTIAL]

**Status:** 12 passing, 2 fixme
**File:** `advanced-formulas.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | VLOOKUP finds value in table | FIXME | Bug in extract_2d_rows |
| 2 | INDEX/MATCH combination | FIXME | Same bug |
| 3 | SUMIF sums matching values | PASS | |
| 4 | COUNTIF counts matching cells | PASS | |
| 5 | Division by zero shows #DIV/0! | PASS | |
| 6 | Invalid function shows error | PASS | |
| 7 | ABS function | PASS | |
| 8 | ROUND function | PASS | |
| 9 | MAX and MIN | PASS | |
| 10 | AVERAGE function | PASS | |
| 11 | CONCATENATE / & operator | PASS | |
| 12 | LEN function | PASS | |
| 13 | UPPER and LOWER | PASS | |

Scenarios still to add:
- [ ] Array formulas
- [ ] Cross-sheet references
- [ ] GATHER function (writeback)

### Phase 19: Edge Cases & Integration [DONE]

**Status:** 14 passing
**File:** `edge-cases.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | 100 cells batch | PASS | |
| 2 | Formula chain 50 cells | PASS | |
| 3 | Unicode text | PASS | |
| 4 | Long text 1000 chars | PASS | |
| 5 | Newline chars | PASS | |
| 6 | Large number | PASS | |
| 7 | Small decimal | PASS | |
| 8 | Negative number | PASS | |
| 9 | Circular reference | PASS | |
| 10 | Empty SUM | PASS | |
| 11 | Nested IF | PASS | |
| 12 | Format + recalc | PASS | |
| 13 | Copy with formatting | PASS | |
| 14 | Rapid toggles | PASS | |

### Phase 20: Alignment & Colors [DONE]

**Status:** 10 passing
**File:** `alignment.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Align left | PASS | |
| 2 | Align center | PASS | |
| 3 | Align right | PASS | |
| 4 | Toggle off | PASS | |
| 5 | Wrap text on | PASS | |
| 6 | Wrap text off | PASS | |
| 7 | Indent increase | PASS | |
| 8 | Indent decrease | PASS | |
| 9 | Text color | PASS | |
| 10 | Background color | PASS | |

### Phase 21: Column/Row Operations [DONE]

**Status:** 6 passing
**File:** `column-row-ops.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Set column width | PASS | |
| 2 | Set row height | PASS | |
| 3 | Insert row shifts data | PASS | |
| 4 | Insert column shifts data | PASS | |
| 5 | Grid bounds | PASS | |
| 6 | Used range | PASS | |

### Phase 22: Zoom & View [DONE]

**Status:** 2 passing
**File:** `zoom-view.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Zoom level exists | PASS | |
| 2 | Formula bar shows value | PASS | |

### Phase 23: Undo/Redo via API [DONE]

**Status:** 4 passing
**File:** `undo-redo.spec.ts`

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1 | Undo reverts cell edit | PASS | |
| 2 | Redo re-applies | PASS | |
| 3 | Undo formatting | PASS | |
| 4 | Multiple undos | PASS | |

---

## Bugs Found by E2E Tests

| Date | Bug | Found By | Status |
|------|-----|----------|--------|
| 2026-05-20 | Formula "=" prefix stripped — formula bar shows "A1+B1" instead of "=A1+B1" | formula.spec.ts (10 tests) | FIXED — 43 call sites in 15 Rust files |
| 2026-05-20 | Formatting not persisting — ribbon button toggles UI but `applyFormatting` sends stale/empty selection | formatting.spec.ts (multiple) | FIXED — `getGridStateSnapshot()` and `lastSelectionRef` in HomeTabComponent.tsx |
| 2026-05-20 | Off-screen cells not clickable — GridHelper cellCenter() didn't account for scroll offset, causing tests on rows 30+ to click wrong positions | formatting.spec.ts | FIXED — Added scroll-aware clicking via `__CALCULA_GRID_STATE__` viewport scrollX/scrollY |
| 2026-05-20 | Increase/decrease decimal buttons broken — increaseDecimal/decreaseDecimal in HomeTabComponent read format codes but backend returns descriptive names like "Number (1 decimals)" | number-formatting.spec.ts | FIXED — parse decimal count from descriptive format name |
| 2026-05-20 | VLOOKUP returns #NA for valid data — MATCH works on same range, issue likely in extract_2d_rows() returning flat array instead of 2D for multi-column ranges | advanced-formulas.spec.ts | OPEN |

---

## Adding New Tests

1. Create a new `.spec.ts` file in `app/e2e/tests/`
2. Import fixtures: `import { test, expect } from "../fixtures";`
3. Use `grid` helper for canvas interaction
4. For formulas with commas or locale-sensitive content, use `setCellValueDirect()` which bypasses keyboard input and calls the Tauri API directly. This avoids locale issues where commas are converted to dots during `keyboard.type()`.
5. Add grid helper methods in `app/e2e/helpers/grid.ts` as needed
6. Update this document with the new phase and test status
7. Run `yarn e2e` to verify
