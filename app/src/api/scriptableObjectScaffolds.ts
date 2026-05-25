//! FILENAME: app/src/api/scriptableObjectScaffolds.ts
// PURPOSE: Default scaffold templates for each scriptable object type.
// CONTEXT: When a user opens the Code tab for an object, they see a pre-populated
//          script with commented-out event handlers. These templates provide that.

import type { ScriptableObjectType } from "./scriptableObjects";

/** Get the default scaffold template for an object type. */
export function getScaffoldTemplate(objectType: ScriptableObjectType, objectName?: string): string {
  const name = objectName || objectType.charAt(0).toUpperCase() + objectType.slice(1);

  switch (objectType) {
    case "workbook":
      return `// Workbook Script
// Access level: restricted (unlock full API via access level setting)
//
// This script runs once when the workbook opens.
// Use it to set up global behaviors, automation, and event handlers.

function setup(workbook) {
  // == Lifecycle Events ==
  // workbook.onOpen(() => {
  //   workbook.log("Workbook opened!");
  // });

  // workbook.onBeforeSave(() => {
  //   workbook.log("Saving...");
  // });

  // workbook.onAfterSave(() => {
  //   workbook.log("Saved!");
  // });

  // workbook.onBeforeClose(() => {
  //   workbook.log("Closing...");
  // });

  // == Sheet Events ==
  // workbook.onSheetChange(({ sheetIndex, sheetName }) => {
  //   workbook.log("Switched to sheet:", sheetName);
  // });

  // == Custom Methods ==
  // workbook.expose("myMethod", () => {
  //   workbook.log("Custom method called!");
  // });
}
`;

    case "sheet":
      return `// Sheet Script (applies to ALL sheets)
// Access level: restricted

function setup(sheet) {
  // == Sheet Events ==
  // sheet.onActivate(({ sheetIndex, sheetName }) => {
  //   sheet.log("Sheet activated:", sheetName);
  // });

  // sheet.onDeactivate(({ sheetIndex, sheetName }) => {
  //   sheet.log("Sheet deactivated:", sheetName);
  // });

  // sheet.onSelectionChange(({ sheetIndex, row, col, endRow, endCol }) => {
  //   sheet.log("Selection:", row, col, "to", endRow, endCol);
  // });

  // sheet.onDataChange(({ sheetIndex, changes }) => {
  //   for (const change of changes) {
  //     sheet.log("Cell changed:", change.row, change.col, "->", change.newValue);
  //   }
  // });

  // == Data Access ==
  // const value = sheet.getCellValue(0, 0);  // A1
  // sheet.setCellValue(0, 0, "Hello!");
}
`;

    case "cell":
      return `// Cell Script (applies to ALL cells)
// Access level: restricted

function setup(cell) {
  // == Cell Events ==
  // cell.onEdit(({ row, col, sheetIndex, oldValue, newValue, formula }) => {
  //   cell.log("Cell edited:", row, col, "new value:", newValue);
  // });

  // cell.onSelect(({ row, col, sheetIndex }) => {
  //   cell.log("Cell selected:", row, col);
  // });

  // cell.onEditStart(({ row, col, sheetIndex }) => {
  //   cell.log("Editing started:", row, col);
  // });

  // cell.onEditEnd(({ row, col, sheetIndex, committed }) => {
  //   cell.log("Editing ended:", row, col, committed ? "committed" : "cancelled");
  // });

  // == Custom Rendering ==
  // cell.onRender(({ row, col, sheetIndex, value }) => {
  //   // Return style overrides for cells matching a condition
  //   if (value === "ERROR") {
  //     return { textColor: "#ff0000", bold: true };
  //   }
  //   return null;  // Use default styling
  // });
}
`;

    case "row":
      return `// Row Script (applies to ALL rows)
// Access level: restricted

function setup(row) {
  // == Row Events ==
  // row.onInsert(({ sheetIndex, startRow, count }) => {
  //   row.log("Rows inserted at", startRow, "count:", count);
  // });

  // row.onDelete(({ sheetIndex, startRow, count }) => {
  //   row.log("Rows deleted at", startRow, "count:", count);
  // });

  // row.onResize(({ sheetIndex, row: rowIndex, height }) => {
  //   row.log("Row resized:", rowIndex, "new height:", height);
  // });
}
`;

    case "column":
      return `// Column Script (applies to ALL columns)
// Access level: restricted

function setup(column) {
  // == Column Events ==
  // column.onInsert(({ sheetIndex, startCol, count }) => {
  //   column.log("Columns inserted at", startCol, "count:", count);
  // });

  // column.onDelete(({ sheetIndex, startCol, count }) => {
  //   column.log("Columns deleted at", startCol, "count:", count);
  // });

  // column.onResize(({ sheetIndex, col, width }) => {
  //   column.log("Column resized:", col, "new width:", width);
  // });
}
`;

    case "slicer":
      return `// Slicer: "${name}"
// Access level: restricted (unlock full API via access level setting)

function setup(slicer) {
  // == Events ==
  // slicer.onSelectionChange(({ selectedItems }) => {
  //   slicer.log("Selection changed:", selectedItems);
  // });

  // slicer.onDataRefresh(({ items }) => {
  //   slicer.log("Data refreshed:", items.length, "items");
  // });

  // slicer.onResize(({ x, y, width, height }) => {
  //   slicer.log("Resized:", width, "x", height);
  // });

  // == Data Access ==
  // const selected = slicer.getSelectedItems();
  // slicer.setSelectedItems(["Item1", "Item2"]);
  // slicer.clearSelection();
  // slicer.selectAll();

  // == Appearance ==
  // slicer.style.itemRenderer((item, ctx, bounds) => {
  //   ctx.fillStyle = item.selected ? "#0078d4" : "#ffffff";
  //   ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  //   ctx.fillStyle = item.selected ? "#ffffff" : "#333333";
  //   ctx.fillText(item.text, bounds.x + 8, bounds.y + bounds.height / 2);
  // });

  // == Custom Methods ==
  // slicer.expose("reset", () => {
  //   slicer.clearSelection();
  //   slicer.notify("Slicer reset!", "info");
  // });
}
`;

    case "chart":
      return `// Chart: "${name}"
// Access level: restricted

function setup(chart) {
  // == Events ==
  // chart.onDataChange(() => {
  //   chart.log("Chart data changed");
  // });

  // chart.onClick(({ x, y }) => {
  //   chart.log("Chart clicked at:", x, y);
  // });

  // chart.onResize(({ x, y, width, height }) => {
  //   chart.log("Chart resized:", width, "x", height);
  // });

  // == Data Access ==
  // const spec = chart.getSpec();
  // chart.updateSpec({ title: "Updated Title" });
}
`;

    case "pivot":
      return `// Pivot Table: "${name}"
// Access level: restricted

function setup(pivot) {
  // == Events ==
  // pivot.onRefresh(() => {
  //   pivot.log("Pivot refreshed");
  // });

  // pivot.onLayoutChange(({ rows, columns, values, filters }) => {
  //   pivot.log("Layout changed - rows:", rows, "values:", values);
  // });

  // pivot.onResize(({ x, y, width, height }) => {
  //   pivot.log("Pivot resized:", width, "x", height);
  // });

  // == Data Access ==
  // const fields = pivot.getFields();
  // pivot.refresh();
}
`;

    case "button":
      return `// Button: "${name}"
// Access level: restricted

function setup(button) {
  // == Custom Methods ==
  // button.expose("onClick", () => {
  //   button.log("Button clicked!");
  //   button.notify("Hello from button!", "info");
  // });
}
`;

    case "textbox":
      return `// Text Box: "${name}"
// Access level: restricted

function setup(textbox) {
  // == Custom Methods ==
  // textbox.expose("getText", () => {
  //   return "Hello, World!";
  // });
}
`;

    case "timeline":
      return `// Timeline: "${name}"
// Access level: restricted

function setup(timeline) {
  // == Events ==
  // timeline.expose("onPeriodChange", (period) => {
  //   timeline.log("Period changed:", period);
  // });
}
`;

    case "shape":
      return `// Shape: "${name}"
// Access level: restricted (unlock full API via access level setting)
//
// This script runs when the shape is mounted.
// Use it to customize rendering, add interactivity, and declare custom properties.

function setup(shape) {
  // == Events ==
  // shape.onClick(({ x, y }) => {
  //   shape.log("Shape clicked at:", x, y);
  // });

  // shape.onResize(({ width, height }) => {
  //   shape.log("Shape resized:", width, "x", height);
  // });

  // shape.onPropertyChange(({ key, oldValue, newValue }) => {
  //   shape.log("Property changed:", key, oldValue, "->", newValue);
  // });

  // == Property Access ==
  // const fill = shape.getProperty("fill");
  // shape.setProperty("fill", "#ff0000");

  // == Live Cell Data Binding ==
  // const value = await shape.getCellValue("A1");
  // shape.onCellChange(() => {
  //   // Re-render when any cell changes
  //   render();
  // });

  // == Custom Canvas Rendering ==
  // shape.render.canvasRenderer((ctx, bounds) => {
  //   ctx.fillStyle = shape.getProperty("fill") || "#4472C4";
  //   ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  //   ctx.fillStyle = "#fff";
  //   ctx.font = "14px sans-serif";
  //   ctx.textAlign = "center";
  //   ctx.fillText("Custom!", bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  // });

  // == Interactive HTML Rendering ==
  // shape.render.setHtmlContent(\`
  //   <div style="padding: 12px; font-family: sans-serif; height: 100%; box-sizing: border-box;">
  //     <h3 style="margin: 0 0 8px 0;">My Widget</h3>
  //     <p style="margin: 0; color: #666;">Interactive HTML inside a shape</p>
  //     <button onclick="calcula.sendMessage('click', { button: 'ok' })">Click Me</button>
  //   </div>
  // \`);

  // == Receive Messages from HTML ==
  // shape.render.onMessage(({ type, data }) => {
  //   shape.log("Message from HTML:", type, data);
  //   shape.notify("Got message: " + type, "info");
  // });

  // == Send Messages to HTML ==
  // shape.render.sendMessage("update", { value: 42 });
  // (Inside iframe: window.addEventListener('shape-message', (e) => { ... }));

  // == Declare Custom Properties (appear in Properties pane) ==
  // shape.render.declareProperties([
  //   { key: "dataSource", label: "Data Source", type: "text", defaultValue: "" },
  //   { key: "refreshInterval", label: "Refresh (sec)", type: "number", defaultValue: "30" },
  //   { key: "accentColor", label: "Accent Color", type: "color", defaultValue: "#0078d4" },
  // ]);

  // == Expose Custom Methods (callable from other scripts) ==
  // shape.expose("refresh", () => {
  //   shape.log("Refreshing shape data...");
  //   shape.notify("Shape refreshed!", "success");
  // });
}
`;

    default:
      return `// ${name} Script
// Access level: restricted

function setup(context) {
  // Write your script here
}
`;
  }
}

/** Get a description of available context methods for an object type (for documentation panel). */
export function getContextDocumentation(objectType: ScriptableObjectType): Array<{
  category: string;
  methods: Array<{ name: string; signature: string; description: string }>;
}> {
  const common = {
    category: "Base",
    methods: [
      { name: "log", signature: "log(...args)", description: "Log to script console" },
      { name: "notify", signature: "notify(message, type?)", description: "Show a toast notification" },
      { name: "expose", signature: "expose(name, handler)", description: "Expose a custom method" },
    ],
  };

  switch (objectType) {
    case "workbook":
      return [
        common,
        {
          category: "Lifecycle",
          methods: [
            { name: "onOpen", signature: "onOpen(handler)", description: "Called when workbook opens" },
            { name: "onBeforeSave", signature: "onBeforeSave(handler)", description: "Called before saving" },
            { name: "onAfterSave", signature: "onAfterSave(handler)", description: "Called after saving" },
            { name: "onBeforeClose", signature: "onBeforeClose(handler)", description: "Called before closing" },
            { name: "onSheetChange", signature: "onSheetChange(handler)", description: "Called when active sheet changes" },
            { name: "onThemeChange", signature: "onThemeChange(handler)", description: "Called when theme changes" },
          ],
        },
        {
          category: "Properties",
          methods: [
            { name: "properties.title", signature: "properties.title", description: "Workbook title" },
            { name: "properties.author", signature: "properties.author", description: "Workbook author" },
            { name: "properties.sheetCount", signature: "properties.sheetCount", description: "Number of sheets" },
            { name: "properties.getSheetNames", signature: "properties.getSheetNames()", description: "Get all sheet names" },
          ],
        },
      ];

    case "cell":
      return [
        common,
        {
          category: "Events",
          methods: [
            { name: "onEdit", signature: "onEdit(handler)", description: "Called when any cell value is committed" },
            { name: "onSelect", signature: "onSelect(handler)", description: "Called when a cell is selected" },
            { name: "onEditStart", signature: "onEditStart(handler)", description: "Called when editing begins" },
            { name: "onEditEnd", signature: "onEditEnd(handler)", description: "Called when editing ends" },
          ],
        },
        {
          category: "Rendering",
          methods: [
            { name: "onRender", signature: "onRender(handler)", description: "Custom cell renderer (return style overrides)" },
          ],
        },
      ];

    case "slicer":
      return [
        common,
        {
          category: "Events",
          methods: [
            { name: "onSelectionChange", signature: "onSelectionChange(handler)", description: "Called when slicer selection changes" },
            { name: "onDataRefresh", signature: "onDataRefresh(handler)", description: "Called when data refreshes" },
            { name: "onResize", signature: "onResize(handler)", description: "Called when slicer is moved/resized" },
          ],
        },
        {
          category: "Data",
          methods: [
            { name: "getSelectedItems", signature: "getSelectedItems()", description: "Get selected items" },
            { name: "setSelectedItems", signature: "setSelectedItems(items)", description: "Set selected items" },
            { name: "clearSelection", signature: "clearSelection()", description: "Clear all selections" },
            { name: "selectAll", signature: "selectAll()", description: "Select all items" },
          ],
        },
        {
          category: "Appearance",
          methods: [
            { name: "style.itemRenderer", signature: "style.itemRenderer(renderer)", description: "Custom item rendering" },
            { name: "style.setProperty", signature: "style.setProperty(name, value)", description: "Set CSS property" },
          ],
        },
      ];

    case "shape":
      return [
        common,
        {
          category: "Events",
          methods: [
            { name: "onClick", signature: "onClick(handler)", description: "Called when shape is clicked" },
            { name: "onResize", signature: "onResize(handler)", description: "Called when shape is resized" },
            { name: "onPropertyChange", signature: "onPropertyChange(handler)", description: "Called when a property changes" },
          ],
        },
        {
          category: "Properties",
          methods: [
            { name: "getProperty", signature: "getProperty(key)", description: "Get a property value by key" },
            { name: "setProperty", signature: "setProperty(key, value)", description: "Set a property value" },
            { name: "getCellValue", signature: "getCellValue(cellRef)", description: "Read a cell value by reference (e.g., 'A1')" },
            { name: "onCellChange", signature: "onCellChange(handler)", description: "Called when any cell value changes" },
          ],
        },
        {
          category: "Rendering",
          methods: [
            { name: "render.setHtmlContent", signature: "render.setHtmlContent(html)", description: "Replace canvas rendering with interactive HTML iframe" },
            { name: "render.sendMessage", signature: "render.sendMessage(type, data?)", description: "Send a message to the shape's HTML iframe" },
            { name: "render.onMessage", signature: "render.onMessage(handler)", description: "Listen for messages from the shape's HTML (via calcula.sendMessage)" },
            { name: "render.canvasRenderer", signature: "render.canvasRenderer(fn)", description: "Provide a custom canvas render function" },
            { name: "render.declareProperties", signature: "render.declareProperties(props)", description: "Declare custom properties for the Properties pane" },
          ],
        },
      ];

    default:
      return [common];
  }
}
