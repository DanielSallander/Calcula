# Suggested Test Scenarios

> Generated: 2026-05-27 18:13:41
> Based on coverage gaps in tests/regression/registry.json
>
> **How to use this file:**
> 1. Review the suggestions below
> 2. Edit any scenario you want to adjust (change steps, rename, etc.)
> 3. Delete scenarios you don't want
> 4. Add `<!-- user-edited -->` anywhere in this file to prevent it being overwritten
>    on the next regression run (new suggestions will go to suggested-scenarios-new.md instead)
> 5. When ready, ask Claude Code: "Implement the scenarios in suggested-scenarios.md"
>    or implement them yourself in app/e2e/tests/ or app/e2e/visual/
> 6. After implementing, update registry.json to reflect the new coverage

---

## Suggested Test Scenarios

### [core.grid-rendering] Grid Rendering & Canvas
**Priority:** Tier 1
**Current coverage:** unit-only
**Suggested scenario:**
> 1. Open a workbook with data in cells A1:E20 (mixed text, numbers, formulas)
> 2. Verify cells display correct values by reading cell content via the API
> 3. Set bold formatting on A1:A5 and a background color on B1:B5
> 4. Verify the formatted cells reflect the style changes (check style properties)
> 5. Click on cell D10 — verify the active cell indicator moves to D10
> 6. Verify row headers (1–20) and column headers (A–E) are present

**What it would catch:**
> Canvas paint regressions, cell value rendering failures, style application not reflecting visually, header misalignment, active cell highlight breakage

**Estimated complexity:** Medium

---

### [core.scrolling] Scrolling & Virtualization
**Priority:** Tier 1
**Current coverage:** unit-only
**Suggested scenario:**
> 1. Load a workbook with data spanning A1:C1000
> 2. Scroll down to row 500 (via keyboard Ctrl+Down or programmatic scroll)
> 3. Verify that row 500's cell content is visible and correct
> 4. Scroll right to column Z and verify column header shows "Z"
> 5. Use Ctrl+Home to return to A1 — verify viewport is back at top-left
> 6. Use Ctrl+End to jump to the last used cell — verify correct position

**What it would catch:**
> Viewport calculation errors, virtualization dropping cells, scroll-to-cell failures, large dataset rendering crashes, jump-navigation regressions

**Estimated complexity:** Medium

---

### [core.dimensions] Column Width & Row Height
**Priority:** Tier 1
**Current coverage:** unit-only
**Suggested scenario:**
> 1. Enter a long text string in A1 ("This is a very long cell value for testing auto-fit")
> 2. Double-click the column A header border to auto-fit width
> 3. Verify column A width increased from the default
> 4. Manually drag column B header border to resize to ~200px
> 5. Verify column B width changed
> 6. Select row 3 and set row height to 50px via context menu
> 7. Verify row 3 height reflects the change

**What it would catch:**
> Auto-fit calculation errors, manual resize not persisting, row height changes not rendering, header-border drag interaction failures

**Estimated complexity:** Medium

---

### [feat.tables] Structured Tables
**Priority:** Tier 2
**Current coverage:** unit-only
**Suggested scenario:**
> 1. Enter headers "Name", "Score", "Grade" in A1:C1 and 5 rows of data
> 2. Select A1:C6 and insert a table (via ribbon or Ctrl+T)
> 3. Verify table formatting applies (banded rows, header row)
> 4. Toggle the totals row on — verify it appears with a default aggregation
> 5. Type a structured reference formula `=SUM(Table1[Score])` in E1
> 6. Verify the formula resolves correctly
> 7. Add a new data row by tabbing past the last row — verify table auto-expands

**What it would catch:**
> Table creation/formatting failures, totals row rendering bugs, structured reference resolution errors, auto-expansion regressions

**Estimated complexity:** Complex

---

### [feat.paste-special] Paste Special
**Priority:** Tier 2
**Current coverage:** unit-only
**Suggested scenario:**
> 1. Enter "100" in A1, "=A1*2" in A2, apply bold + yellow background to both
> 2. Select A1:A2 and copy (Ctrl+C)
> 3. Select C1, open Paste Special, choose "Values Only" — verify C1=100, C2=200 (no formulas), no formatting
> 4. Select E1, open Paste Special, choose "Formulas Only" — verify E2 has formula "=E1*2", no formatting
> 5. Select G1, open Paste Special, choose "Formatting Only" — verify bold + yellow applied, cells empty
> 6. Select I1, open Paste Special, choose "Transpose" — verify data appears in I1:J1 (horizontal)

**What it would catch:**
> Paste mode selection failures, formula vs. value stripping errors, format-only paste not applying styles, transpose logic bugs

**Estimated complexity:** Medium

---

### [feat.ribbon] Ribbon & Home Tab
**Priority:** Tier 2
**Current coverage:** none
**Suggested scenario:**
> 1. Verify the Home tab is visible and active by default
> 2. Click the Bold button — verify active cell toggles bold
> 3. Click the font size dropdown, select 14pt — verify font size changes
> 4. Switch to the "Formulas" tab — verify tab content changes
> 5. Switch to the "Data" tab — verify Data-specific buttons appear
> 6. Return to Home tab — verify it reloads correctly

**What it would catch:**
> Ribbon not rendering, tab switching failures, formatting buttons not wired to commands, contextual tab breakage

**Estimated complexity:** Simple

---

### [feat.formula-autocomplete] Formula Autocomplete
**Priority:** Tier 2
**Current coverage:** unit-only
**Suggested scenario:**
> 1. Click on an empty cell and type "=SU"
> 2. Verify an autocomplete dropdown appears with SUM, SUMIF, SUMIFS, etc.
> 3. Verify SUM is highlighted (first match)
> 4. Press Tab to accept "SUM" — verify cell editor shows "=SUM("
> 5. Type "A1:A5)" and press Enter — verify formula resolves
> 6. In another cell, type "=VLO" — verify VLOOKUP appears in dropdown
> 7. Press Escape — verify dropdown closes and input is cancelled

**What it would catch:**
> Autocomplete dropdown not triggering, fuzzy matching failures, Tab/Enter acceptance bugs, tooltip rendering, dropdown dismissal on Escape

**Estimated complexity:** Medium

---

### [feat.status-bar] Status Bar & Aggregations
**Priority:** Tier 2
**Current coverage:** none
**Suggested scenario:**
> 1. Enter values 10, 20, 30, 40, 50 in cells A1:A5
> 2. Select range A1:A5
> 3. Verify the status bar shows Sum: 150, Average: 30, Count: 5
> 4. Change selection to A1:A3 — verify status bar updates to Sum: 60, Average: 20, Count: 3
> 5. Select a single empty cell — verify aggregation values clear or show appropriate defaults

**What it would catch:**
> Status bar not updating on selection change, incorrect aggregation calculations, status bar not rendering at all

**Estimated complexity:** Simple

---

### [feat.grouping] Row/Column Grouping
**Priority:** Tier 3
**Current coverage:** unit-only
**Suggested scenario:**
> 1. Enter data in A1:C10
> 2. Select rows 3–6 and group them (Data > Group)
> 3. Verify outline level indicator appears
> 4. Click the collapse button — verify rows 3–6 are hidden
> 5. Click the expand button — verify rows 3–6 reappear with data intact
> 6. Ungroup the rows — verify outline indicators are removed

**What it would catch:**
> Group/ungroup command failures, collapse/expand not hiding/showing rows, outline level rendering bugs, data loss on collapse

**Estimated complexity:** Medium

---

### [feat.comments] Comments & Notes
**Priority:** Tier 3
**Current coverage:** none
**Suggested scenario:**
> 1. Right-click on cell B3 and select "New Comment"
> 2. Type "Review this value" and submit
> 3. Verify a comment indicator (triangle) appears on B3
> 4. Hover over B3 — verify comment popup shows "Review this value"
> 5. Edit the comment to "Approved" — verify text updates
> 6. Delete the comment — verify indicator is removed

**What it would catch:**
> Comment creation/edit/delete failures, indicator not rendering, popup not showing on hover, comment data loss

**Estimated complexity:** Medium

---

### [feat.hyperlinks] Hyperlinks
**Priority:** Tier 3
**Current coverage:** none
**Suggested scenario:**
> 1. Select cell A1 and insert a hyperlink via menu (Insert > Hyperlink)
> 2. Set display text "Click Here" and URL to a test destination
> 3. Verify A1 shows underlined blue "Click Here" text
> 4. Edit the hyperlink — change display text to "Updated Link"
> 5. Verify the display text updates
> 6. Remove the hyperlink — verify cell reverts to normal text styling

**What it would catch:**
> Hyperlink insertion dialog failures, display text not rendering with link styling, edit/remove not working

**Estimated complexity:** Simple

---

### [feat.format-cells-dialog] Format Cells Dialog
**Priority:** Tier 3
**Current coverage:** none
**Suggested scenario:**
> 1. Enter the number 1234.5 in A1
> 2. Right-click and open Format Cells dialog
> 3. Select "Number" category with 2 decimal places and thousands separator
> 4. Click OK — verify A1 displays "1,234.50"
> 5. Reopen Format Cells, switch to "Alignment" tab, set horizontal center
> 6. Click OK — verify cell alignment changes
> 7. Verify the value is still 1234.5 (not the formatted string)

**What it would catch:**
> Format dialog not opening, category selection failures, number format not applying, alignment tab not working, format corrupting underlying value

**Estimated complexity:** Medium

---

### [feat.format-painter] Format Painter
**Priority:** Tier 3
**Current coverage:** none
**Suggested scenario:**
> 1. Format A1 with bold, red text, yellow background
> 2. Select A1 and click the Format Painter button
> 3. Click on C1 — verify C1 gets bold, red text, yellow background
> 4. Verify Format Painter deactivates after single use
> 5. Double-click Format Painter (lock mode), paint D1 and E1
> 6. Press Escape to exit lock mode — verify painter deactivates

**What it would catch:**
> Format painter not copying styles, single-click vs double-click mode confusion, painter not deactivating, styles partially copied

**Estimated complexity:** Simple

---

### [feat.csv-import-export] CSV Import/Export
**Priority:** Tier 3
**Current coverage:** none
**Suggested scenario:**
> 1. Enter a small dataset (3 columns, 5 rows including headers) in the grid
> 2. Export to CSV via File > Export as CSV
> 3. Verify the CSV file is created and contains correct comma-separated values
> 4. Create a new workbook
> 5. Import the exported CSV file
> 6. Verify all data matches the original (values, column count, row count)

**What it would catch:**
> Export producing malformed CSV, import parsing failures, data loss during round-trip, delimiter handling errors, encoding issues

**Estimated complexity:** Medium

---

### [feat.search] Search Panel
**Priority:** Tier 3
**Current coverage:** none
**Suggested scenario:**
> 1. Enter data across A1:C10 with the word "total" in cells A5 and C8
> 2. Open Find & Replace (Ctrl+H or via menu)
> 3. Search for "total" — verify both matches are found
> 4. Navigate between matches — verify cursor moves to A5, then C8
> 5. Replace "total" with "sum" — verify one replacement occurs
> 6. Replace All remaining — verify all instances updated

**What it would catch:**
> Find not locating matches, navigation between results broken, replace corrupting cell data, Replace All missing instances

**Estimated complexity:** Simple

---

These 15 scenarios cover all Tier 1 features (3), all Tier 2 features (5), and the 7 most impactful Tier 3 features — prioritized by how fundamental each is to daily spreadsheet workflows.
