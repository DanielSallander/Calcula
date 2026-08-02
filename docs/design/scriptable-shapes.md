# Scriptable Shapes

## Overview

Scriptable Shapes extends Calcula's shape controls with user-programmable behavior via TypeScript. Any shape can have an attached script that controls its appearance, responds to events, reads live cell data, and renders interactive HTML content. This turns simple shapes into dashboard widgets, KPI cards, status indicators, and custom interactive components.

The feature builds on the existing [Scriptable Objects](scriptable-objects.md) system, adding `"shape"` as a new scriptable object type with a rich context API tailored for visual rendering and data binding.

Scriptable shapes are a direct expression of Calcula's founding vision: they deliver the custom visuals that locked-down BI tools reserve for their vendors. Where Power BI users wait for Microsoft (or a marketplace) to ship the widget they need, a Calcula user builds their own KPI card or status indicator in TypeScript, on the spot — with the script visible on the shape that carries it, limited by tiered access levels, and its rendered HTML isolated in an iframe overlay, rather than VBA-style hidden code.

## Architecture

### Layer Responsibilities

| Layer | What it does |
|-------|-------------|
| **ShapeContext** (`src/api/scriptableObjects.ts`) | Defines the TypeScript API surface available to shape scripts. Handles events, properties, cell binding, and rendering commands. |
| **Shape Renderer** (`extensions/Controls/Shape/shapeRenderer.ts`) | Manages canvas rendering, iframe overlays, custom renderers, script badges, and the postMessage bridge. |
| **Controls Extension** (`extensions/Controls/index.ts`) | Wires all events between the script runtime, renderer, and backend. Handles template application, undo integration, and lifecycle management. |
| **Rust Persistence** (`core/persistence`, `core/calcula-format`, `src-tauri/src/scripting`) | Stores shape scripts in `.cala` files alongside other object scripts. |

### Data Flow

```
User inserts shape
  --> Controls extension creates FloatingControl + ControlMetadata
  --> Shape rendered on canvas via shapeRenderer

User attaches script (Edit Script / Apply Template)
  --> Script saved to backend via save_object_script
  --> ScriptableObjects extension mounts script
  --> buildShapeContext() creates typed context
  --> setup(shape) executes, registers handlers

Script calls shape.render.setHtmlContent(html)
  --> emits "shape:setHtmlContent" event
  --> Controls extension calls setShapeHtmlContent()
  --> Renderer creates sandboxed iframe with postMessage bridge
  --> iframe positioned over canvas at shape coordinates

User edits cell that shape reads
  --> CELL_VALUES_CHANGED event fires
  --> shape.onCellChange() handler triggers
  --> Script calls getCellValue() for new data
  --> Script re-renders with updated values
```

## ShapeContext API

Every shape script receives a `ShapeContext` object in its `setup()` function. This context provides the full API surface for controlling the shape.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `objectType` | `"shape"` | Always `"shape"` |
| `instanceId` | `string` | Unique ID, e.g., `"control-0-195-2"` |
| `shapeType` | `string` | Shape type, e.g., `"rectangle"`, `"snipSingleCorner"` |
| `accessLevel` | `"restricted" \| "unlocked"` | Script access level |
| `api` | `UnlockedAPI \| null` | Full API (only when `accessLevel` is `"unlocked"`) |

### Events

```typescript
// Called when the shape is clicked (design or run mode)
shape.onClick(({ x, y }) => { ... }): CleanupFn;

// Called when the shape is resized (drag handles)
shape.onResize(({ width, height }) => { ... }): CleanupFn;

// Called when any property changes (from panel or script)
shape.onPropertyChange(({ key, oldValue, newValue }) => { ... }): CleanupFn;

// Called when any cell value changes (for live data binding)
shape.onCellChange(({ changes }) => { ... }): CleanupFn;
```

All event methods return a `CleanupFn` that unsubscribes the handler.

### Property Access

```typescript
// Read a resolved property value
const fill = shape.getProperty("fill");  // "#4472C4"

// Write a property value (wrapped in undo transaction)
await shape.setProperty("fill", "#ff0000");
```

### Cell Data Binding

```typescript
// Read a cell value by A1-style reference
const revenue = await shape.getCellValue("B5");  // "12450"

// Re-render when cells change
shape.onCellChange(() => {
  render();  // re-fetch cell values and update display
});
```

The `getCellValue()` method accepts A1-style references (A1, AB123, etc.) and returns the cell's display value as a string.

### Rendering

Shapes support three rendering modes:

#### 1. Default Rendering (no script needed)
Standard shape path rendering from the shape catalog. Fill, stroke, text, opacity, rotation all controlled via properties.

#### 2. Custom Canvas Rendering
Replace the default path rendering with a custom canvas draw function:

```typescript
shape.render.canvasRenderer((ctx, bounds) => {
  ctx.fillStyle = shape.getProperty("fill") || "#4472C4";
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.fillStyle = "#fff";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Custom!", bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}): CleanupFn;
```

The renderer function is called on every frame. The `bounds` parameter provides `{ x, y, width, height }` in canvas coordinates.

#### 3. Interactive HTML Rendering
Replace canvas rendering with a sandboxed iframe overlay:

```typescript
shape.render.setHtmlContent(`
  <div style="padding: 12px; font-family: sans-serif;">
    <h3>My Widget</h3>
    <button onclick="calcula.sendMessage('click', { id: 'btn1' })">Click Me</button>
  </div>
`);
```

The HTML is rendered inside an `<iframe>` with `sandbox="allow-scripts allow-same-origin"`. A postMessage bridge is automatically injected.

### Two-Way Messaging (HTML <-> Script)

**Inside the iframe**, a global `calcula` object is available:

```javascript
// Send a message from HTML to the shape script
calcula.sendMessage("buttonClicked", { buttonId: "submit" });

// Receive a message from the shape script
window.addEventListener("shape-message", (e) => {
  console.log(e.detail.type, e.detail.data);
});
```

**In the shape script**, use the render messaging API:

```typescript
// Listen for messages from the HTML
shape.render.onMessage(({ type, data }) => {
  if (type === "buttonClicked") {
    shape.log("Button clicked:", data.buttonId);
    shape.notify("Clicked!", "success");
  }
});

// Send a message to the HTML
shape.render.sendMessage("update", { count: 42 });
```

### Custom Properties

Scripts can declare custom properties that appear in the Properties pane:

```typescript
shape.render.declareProperties([
  { key: "dataSource", label: "Data Source", type: "text", defaultValue: "" },
  { key: "refreshInterval", label: "Refresh (sec)", type: "number", defaultValue: "30" },
  { key: "accentColor", label: "Accent Color", type: "color", defaultValue: "#0078d4" },
  { key: "showBorder", label: "Show Border", type: "boolean", defaultValue: "true" },
]);
```

Declared properties appear in a "Custom" section in the Properties pane. Types: `text`, `number`, `color`, `boolean`.

### Base Context Methods

Inherited from `BaseObjectContext`:

```typescript
shape.log(...args);                      // Log to script console
shape.notify(message, type?);            // Show toast notification ("info"|"success"|"warning"|"error")
shape.expose(name, handler);             // Expose method callable by other scripts
shape.callMethod(type, id, name, args);  // Call exposed method on another script
```

## Properties Pane

The Properties Pane for shapes has three tabs:

### Properties Tab
Displays all shape properties organized in collapsible sections:
- **Shape** — Shape type
- **Fill & Outline** — Fill color, outline color, outline width (slider)
- **Text** — Content, color, size (slider), bold/italic (toggle switches)
- **Transform** — Opacity (slider 0-1), rotation (slider 0-360), flip H/V (toggles)
- **Size** — Width and height (side-by-side)
- **Custom** — Any properties declared by the shape script via `declareProperties()`

Properties support both static values and formulas (prefix with `=`).

### Code Tab
Shows the "Open Script Editor" button and an inline template gallery. Users can:
- Open the full Monaco-based script editor
- Browse and apply built-in templates with a single click

### Preview Tab
Live preview of the shape's HTML content in a sandboxed iframe. Shows a message when no HTML content is set.

### Visual Indicators
- **Script badge** — A blue `<>` icon in the top-right corner of shapes with scripts (visible in design mode)
- **JS pill** — A "JS" badge in the Properties pane header when a script is attached

## Built-in Templates

Five pre-built templates are available via the template gallery:

### Data Cards
| Template | Description | Custom Properties |
|----------|-------------|-------------------|
| **KPI Card** | Large metric with title and delta indicator | Title, Value Cell, Delta Cell, Accent Color |
| **Metric Tile** | Clean large number with subtitle | Value Cell, Subtitle, Value Color |

### Indicators
| Template | Description | Custom Properties |
|----------|-------------|-------------------|
| **Progress Bar** | Horizontal bar (0-100%), color red->green | Label, Value Cell, Bar Height |
| **Status Indicator** | Traffic light (ok/warn/error or numeric) | Label, Value Cell |

### Interactive
| Template | Description | Custom Properties |
|----------|-------------|-------------------|
| **Interactive Counter** | +/- buttons with postMessage demo | Start Value, Button Color |

All data templates use `getCellValue()` for live binding and `onCellChange()` for automatic updates when cell data changes. Set the "Value Cell" property to a cell reference like "A1" to bind.

## Accessing Templates

### Context Menu
Right-click a shape in design mode:
- **Edit Script...** — Opens the script editor for this shape
- **Apply Template...** — Opens the template gallery modal

### Code Tab
The Properties pane Code tab shows an inline template gallery below the script editor button.

### Programmatically
```typescript
// From Controls extension
emitAppEvent("shape:applyTemplate", {
  instanceId: "control-0-10-5",
  templateId: "tpl-kpi-card",
});
```

## Persistence

Shape scripts are stored as part of the `.cala` file format under `object_scripts/script_{id}.json`, using the same mechanism as all other scriptable object scripts. The Rust persistence layer includes `Shape` as a variant in `ScriptableObjectType`.

Script format:
```json
{
  "id": "uuid",
  "name": "KPI Card",
  "objectType": "shape",
  "instanceId": "control-0-195-2",
  "source": "function setup(shape) { ... }",
  "accessLevel": "restricted",
  "description": "KPI Card template"
}
```

## Undo Support

Shape property changes made via `shape.setProperty()` are wrapped in undo transactions, making them reversible with Ctrl+Z. This includes property changes from scripts and from the Properties pane.

## Security Model

- **Sandboxed iframe**: HTML content renders in an `<iframe>` with `sandbox="allow-scripts allow-same-origin"`. Scripts inside the iframe can execute JavaScript but cannot access the parent window's DOM directly.
- **postMessage bridge**: Communication between iframe and shape script is mediated through structured `postMessage` calls with instance ID filtering.
- **Restricted access**: By default, shape scripts run at the `"restricted"` access level with read-only cell access. The `"unlocked"` level provides full cell read/write, sheet operations, and command execution.
- **No import/require**: Shape scripts run in a sandboxed function scope — no module system access.

## Event Reference

Internal events used by the shape scripting system:

| Event | Direction | Payload |
|-------|-----------|---------|
| `shape:clicked` | Controls -> Script | `{ instanceId, x, y }` |
| `shape:resized` | Controls -> Script | `{ instanceId, width, height }` |
| `shape:propertyChanged` | Controls -> Script | `{ instanceId, key, oldValue, newValue }` |
| `shape:setProperty` | Script -> Controls | `{ instanceId, key, value, oldValue }` |
| `shape:setHtmlContent` | Script -> Controls | `{ instanceId, html }` |
| `shape:sendMessage` | Script -> Controls | `{ instanceId, type, data }` |
| `shape:htmlMessage` | iframe -> Script | `{ instanceId, type, data }` |
| `shape:setCanvasRenderer` | Script -> Controls | `{ instanceId, renderer }` |
| `shape:removeCanvasRenderer` | Script -> Controls | `{ instanceId }` |
| `shape:declareProperties` | Script -> Controls | `{ instanceId, props }` |
| `shape:applyTemplate` | UI -> Controls | `{ instanceId, templateId }` |
| `shape:openTemplateGallery` | UI -> Controls | `{ instanceId }` |
| `scriptable-objects:edit-script` | Controls -> ScriptableObjects | `{ objectType, instanceId, objectName }` |

## File Map

| File | Purpose |
|------|---------|
| `app/src/api/scriptableObjects.ts` | ShapeContext interface, buildShapeContext(), parseCellRef() |
| `app/src/api/scriptableObjectScaffolds.ts` | Shape scaffold template and context documentation |
| `app/extensions/ScriptableObjects/objectContexts.d.ts` | IntelliSense type definitions for Monaco editor |
| `app/extensions/Controls/Shape/shapeRenderer.ts` | Canvas rendering, iframe overlays, postMessage bridge, script badges |
| `app/extensions/Controls/Shape/shapeProperties.ts` | Property definitions, script-declared properties runtime |
| `app/extensions/Controls/Shape/shapeTemplateCatalog.ts` | Built-in template definitions and catalog |
| `app/extensions/Controls/Shape/ShapeTemplateGallery.tsx` | Template gallery modal component |
| `app/extensions/Controls/PropertiesPane/PropertiesPane.tsx` | Properties pane with tabs, template picker, script badge |
| `app/extensions/Controls/PropertiesPane/PropertyRow.tsx` | Property editor row with sliders, toggles |
| `app/extensions/Controls/PropertiesPane/CollapsibleSection.tsx` | Collapsible section component |
| `app/extensions/Controls/PropertiesPane/ToggleSwitch.tsx` | Toggle switch component |
| `app/extensions/Controls/PropertiesPane/SliderInput.tsx` | Slider + number input component |
| `app/extensions/Controls/lib/types.ts` | PropertyDefinition with group/min/max/inline |
| `app/extensions/Controls/lib/controlContextMenu.ts` | Edit Script / Apply Template menu items |
| `app/extensions/Controls/index.ts` | Event wiring, template application, undo, cleanup |
| `core/persistence/src/lib.rs` | ScriptableObjectType::Shape |
| `core/calcula-format/src/features/object_scripts.rs` | ObjectScriptObjectTypeDef::Shape |
| `app/src-tauri/src/scripting/object_script_commands.rs` | "shape" string conversion |

## Example: Complete KPI Card Script

```javascript
function setup(shape) {
  // Declare configurable properties
  shape.render.declareProperties([
    { key: "title", label: "Title", type: "text", defaultValue: "Revenue" },
    { key: "valueCell", label: "Value Cell", type: "text", defaultValue: "B2" },
    { key: "deltaCell", label: "Delta Cell", type: "text", defaultValue: "C2" },
    { key: "accentColor", label: "Accent Color", type: "color", defaultValue: "#10b981" },
  ]);

  async function render() {
    var title = shape.getProperty("title") || "Metric";
    var valueCellRef = shape.getProperty("valueCell");
    var deltaCellRef = shape.getProperty("deltaCell");
    var accent = shape.getProperty("accentColor") || "#10b981";

    var value = valueCellRef ? await shape.getCellValue(valueCellRef) : "--";
    var delta = deltaCellRef ? await shape.getCellValue(deltaCellRef) : "";

    shape.render.setHtmlContent(
      '<div style="padding:12px;font-family:sans-serif;height:100%;display:flex;' +
      'flex-direction:column;justify-content:center;background:#fff;">' +
        '<div style="font-size:10px;color:#888;text-transform:uppercase;">' + title + '</div>' +
        '<div style="font-size:28px;font-weight:700;margin:4px 0;">' + (value || "--") + '</div>' +
        (delta ? '<div style="font-size:11px;color:' + accent + ';">' + delta + '</div>' : '') +
      '</div>'
    );
  }

  render();
  shape.onPropertyChange(function() { render(); });
  shape.onCellChange(function() { render(); });
}
```
