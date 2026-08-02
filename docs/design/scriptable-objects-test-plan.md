# Scriptable Objects — E2E Test Plan (Playwright)

## Context
The Scriptable Objects feature allows users to attach TypeScript scripts to any object in Calcula (slicers, charts, pivots, cells, sheets, workbooks). This test plan covers all user-facing flows implemented across the feature set.

## Prerequisites
- The ScriptableObjects extension must be registered and loaded (it's in the extension manifest)
- Developer menu must be accessible (it contains Object Scripts, Script Templates, and Script Marketplace entries)

---

## 1. Object Script CRUD via Developer Menu

### 1a. Create a primitive script (Workbook)
1. Open Developer > Object Scripts...
2. In the Code Editor dialog, use the "+ Add Script..." dropdown and select "Workbook"
3. Verify a new script appears in the script selector with scaffold template source
4. Verify the Monaco editor shows the scaffold with commented-out event handlers
5. Verify the status bar shows "workbook | restricted mode"

### 1b. Create primitive scripts for all types
- Repeat 1a for: Sheet, Cell, Row, Column
- Verify each shows its own scaffold template with type-specific event handlers

### 1c. Edit and save a script
1. Create a Workbook script
2. Uncomment the `onOpen` handler and add `workbook.log("Hello!");`
3. Click "Save & Apply"
4. Verify toast notification "Script saved and applied."
5. Verify the console panel shows no errors

### 1d. Delete a script
1. Open Developer > Object Scripts... (or the Object Scripts task pane)
2. Hover over a script and click "Delete"
3. Verify it's removed from the list

---

## 2. Console Output Panel

### 2a. Script logging appears in console
1. Create a Cell script with: `cell.onSelect(({ row, col }) => { cell.log("Selected:", row, col); });`
2. Save & Apply
3. Click on various cells in the grid
4. Verify the console panel shows timestamped "Selected: X Y" messages

### 2b. Console clear button
1. After generating some console output, click the "Clear" button in the console header
2. Verify all entries are removed and placeholder text appears

### 2c. Console toggle
1. Click "Hide Console" in the toolbar
2. Verify the console panel disappears
3. Click "Show Console" to restore it

---

## 3. Error Display

### 3a. Syntax errors show in console
1. Create a Workbook script with invalid syntax: `function setup(ctx { BAD }`
2. Click "Save & Apply"
3. Verify toast "Script has errors. Check the console."
4. Verify the console auto-opens (if it was hidden)
5. Verify a red error entry appears with the compilation error message
6. Verify the console toggle button turns red and shows "(!)"
7. Verify the status bar shows an error count

### 3b. Runtime errors show in console
1. Create a Workbook script: `function setup(ctx) { throw new Error("boom"); }`
2. Save & Apply
3. Verify a red error entry appears in the console with "boom" and a stack trace

---

## 4. Slicer Context Menu — Edit Script

### 4a. Open script editor from slicer
1. Insert a slicer connected to a table/pivot
2. Right-click the slicer
3. Verify "Edit Script..." appears in the context menu
4. Click it
5. Verify the Code Editor dialog opens with a slicer scaffold template
6. Verify the status bar shows "slicer | restricted mode"

### 4b. Slicer onSelectionChange handler
1. From the slicer script editor, write:
   ```javascript
   function setup(slicer) {
     slicer.onSelectionChange(({ selectedItems }) => {
       slicer.log("Selected:", selectedItems.join(", "));
     });
   }
   ```
2. Save & Apply
3. Click items in the slicer
4. Verify the console shows the selected items

---

## 5. Chart Context Menu — Edit Script

### 5a. Open script editor from chart
1. Insert a chart
2. Right-click on the chart body/title/legend area
3. Verify a context menu appears with "Edit Script..."
4. Click it
5. Verify the Code Editor dialog opens with a chart scaffold template

---

## 6. Pivot Context Menu — Edit Script

### 6a. Open script editor from pivot
1. Create a pivot table
2. Right-click inside the pivot area
3. Verify "Edit Script..." appears in the context menu
4. Click it
5. Verify the Code Editor dialog opens with a pivot scaffold template

---

## 7. Tiered Access (Restricted vs Unlocked)

### 7a. Restricted mode — api is null
1. Create a Workbook script (default: restricted)
2. Add: `workbook.log("api:", workbook.api);`
3. Save & Apply
4. Verify console shows "api: null"

### 7b. Toggle to unlocked mode
1. In the Code Editor, click the "Restricted" button in the toolbar
2. Verify it changes to "Unlocked"
3. Verify the status bar shows "unlocked mode"
4. Add: `workbook.log("api:", typeof workbook.api);`
5. Save & Apply
6. Verify console shows "api: object"

### 7c. Unlocked mode — cell read/write
1. In unlocked mode, write:
   ```javascript
   function setup(workbook) {
     workbook.onOpen(async () => {
       const val = await workbook.api.getCellValue(0, 0);
       workbook.log("A1 =", val);
     });
   }
   ```
2. Save & Apply, then reload the workbook
3. Verify console shows the value of cell A1

---

## 8. Template System

### 8a. Save as Template
1. Create a slicer script with some custom logic
2. Click "Save as Template" in the Code Editor toolbar
3. Enter a name in the prompt (e.g., "My Slicer Template")
4. Verify toast "Saved template..."

### 8b. Create from Template
1. Create a new slicer script (or select a different slicer)
2. In the Code Editor, use the "From Template..." dropdown
3. Select the previously saved template
4. Verify the script source is populated from the template

### 8c. Template Manager dialog
1. Open Developer > Script Templates...
2. Verify the previously saved template appears in the list
3. Hover over it — verify Rename, Export, Delete buttons appear
4. Click "Export" — verify a .calcula-template file is downloaded
5. Click "Delete" — verify it's removed

### 8d. Import template
1. Open Developer > Script Templates...
2. Click "Import Template..."
3. Select a .calcula-template file
4. Verify it appears in the list

---

## 9. Marketplace

### 9a. Open marketplace
1. Open Developer > Script Marketplace...
2. Verify the dialog shows a drop zone and sharing instructions

### 9b. Import via drag-and-drop
1. Drag a .calcula-template file onto the drop zone
2. Verify a preview card shows (name, type, script preview)
3. Click "Install Template"
4. Verify toast "Installed..."

---

## 10. Breakpoints / Debugging

### 10a. Toggle breakpoint
1. Open the Code Editor for any script
2. Click in the gutter margin (left of line numbers) on a line
3. Verify a red breakpoint dot appears
4. Click again to remove it

### 10b. Breakpoint logging
1. Set a breakpoint on a line inside an event handler
2. Save & Apply
3. Trigger the event (e.g., select a cell for a Cell script)
4. Verify the console shows "[BP L{line}] reached breakpoint at line {line}"

---

## 11. Persistence (.cala Save/Load)

### 11a. Scripts survive save/reload
1. Create a Workbook script and a Cell script with simple logic
2. Save the workbook as .cala
3. Close and reopen the .cala file
4. Open Developer > Object Scripts...
5. Verify both scripts are present with their source code intact

### 11b. Script access levels persist
1. Create a script and set it to "unlocked" mode
2. Save and reopen
3. Verify it's still in "unlocked" mode

---

## 12. .calp Distribution

### 12a. Publish with scripts
1. Create a workbook with a Cell script
2. Publish as a .calp package
3. Verify the publish response includes "scripts_published: 1" (check via developer console or UI feedback)

### 12b. Subscribe and consent
1. In a fresh workbook, subscribe to the published .calp package
2. Verify a "Script Security" consent dialog appears
3. Verify it shows the package name and script count
4. Click "Block" — verify scripts are NOT mounted (objects use default behavior)
5. Re-subscribe (or refresh) and click "Allow Scripts"
6. Verify scripts are mounted and active

### 12c. Distributed scripts are read-only
1. After allowing scripts from a .calp package, open the Code Editor
2. Select the distributed script
3. Verify the editor is read-only (can't type)
4. Verify the "Save & Apply" button says "Read Only" and is disabled
5. Verify the status bar shows "distributed (read-only)"

---

## 13. Inter-Script Communication

### 13a. Cross-object method call
1. Create a Workbook script that exposes a method:
   ```javascript
   function setup(workbook) {
     workbook.expose("getGreeting", (name) => "Hello " + name + "!");
   }
   ```
2. Create a Cell script that calls it:
   ```javascript
   function setup(cell) {
     cell.onSelect(({ row, col }) => {
       const greeting = cell.callMethod("workbook", null, "getGreeting", "World");
       cell.log(greeting);
     });
   }
   ```
3. Save both scripts
4. Click on a cell
5. Verify console shows "Hello World!"

### 13b. Calling non-existent method
1. Create a script that calls a method that doesn't exist:
   ```javascript
   function setup(cell) {
     cell.onSelect(() => {
       const result = cell.callMethod("slicer", "999", "nonExistent");
       cell.log("Result:", result);
     });
   }
   ```
2. Click a cell
3. Verify console shows "Result: undefined" (no crash)

---

## 14. API Versioning

### 14a. Check apiVersion on context
1. Create a script: `function setup(ctx) { ctx.log("API version:", ctx.apiVersion); }`
2. Save & Apply
3. Verify console shows "API version: 1.0.0"

---

## 15. Batch Transactions (Unlocked Mode)

### 15a. Batch update groups into single undo
1. Create an unlocked Workbook script:
   ```javascript
   function setup(workbook) {
     workbook.expose("fillRange", async () => {
       await workbook.api.beginBatch("Fill A1:A5");
       for (let i = 0; i < 5; i++) {
         await workbook.api.setCellValue(i, 0, "Row " + (i + 1));
       }
       await workbook.api.commitBatch();
       workbook.notify("Filled A1:A5");
     });
   }
   ```
2. Save & Apply
3. Call the method (e.g., from another script or via console)
4. Verify cells A1:A5 are filled
5. Press Ctrl+Z once
6. Verify ALL 5 cells are undone at once (single undo step)

---

## 16. Row/Column Resize Events

### 16a. Row resize event fires
1. Create a Row script:
   ```javascript
   function setup(row) {
     row.onResize(({ row: r, height }) => {
       row.log("Row", r, "resized to", height);
     });
   }
   ```
2. Save & Apply
3. Drag a row header border to resize a row
4. Verify console shows the resize event

### 16b. Column resize event fires
1. Create a Column script with similar logic for `onResize`
2. Resize a column header
3. Verify console shows the resize event

---

## 17. Auto-Mount on Component Creation

### 17a. Single template auto-applies
1. Save a slicer script as a template (only one slicer template should exist)
2. Insert a new slicer
3. Verify toast "Applied template ... to [slicer name]"
4. Right-click the slicer > Edit Script
5. Verify the script source matches the template

### 17b. Multiple templates show hint
1. Save a second slicer template
2. Insert another slicer
3. Verify toast mentions multiple templates available

---

## 18. Documentation Sidebar

### 18a. API reference shows context methods
1. Open the Code Editor for a Slicer script
2. Verify the sidebar shows "API Reference" with SlicerContext methods
3. Verify categories: Base, Events, Data, Appearance
4. Click a method name — verify it's inserted at the cursor position

### 18b. Toggle sidebar
1. Click "Hide Docs" — verify sidebar disappears
2. Click "Show Docs" — verify sidebar reappears

---

## Notes for Test Implementation

- The Code Editor dialog is opened via Developer menu or context menu. Use `page.click()` to navigate menus.
- The Monaco editor can be targeted via its container div. Use `page.keyboard.type()` or `page.evaluate()` to set content.
- Console output is rendered as `<div>` elements inside the console panel — use text content assertions.
- Toasts appear as temporary DOM elements — may need short waits.
- For .calp tests, you'll need to set up a test registry directory and use the publish/pull Tauri commands.
- Breakpoint gutter clicks target the Monaco glyph margin area.
- Some features (batch transactions, .calp integration) require backend interaction — these may need Tauri IPC mocking or real backend execution depending on your E2E setup.
