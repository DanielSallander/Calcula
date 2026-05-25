//! FILENAME: app/extensions/Controls/Shape/shapeTemplateCatalog.ts
// PURPOSE: Built-in shape script templates for data-bound interactive shapes.
// CONTEXT: Users pick from these in the template gallery to quickly create
//          KPI cards, progress bars, and other dashboard widgets.

// ============================================================================
// Types
// ============================================================================

export interface ShapeTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  previewHtml: string;
  scriptSource: string;
  defaultWidth: number;
  defaultHeight: number;
}

// ============================================================================
// Templates
// ============================================================================

const KPI_CARD: ShapeTemplate = {
  id: "tpl-kpi-card",
  name: "KPI Card",
  description: "Large metric display with title and delta indicator, bound to cell values.",
  category: "Data Cards",
  defaultWidth: 200,
  defaultHeight: 110,
  previewHtml: `<div style="padding:10px;font-family:sans-serif;height:100%;display:flex;flex-direction:column;justify-content:center;background:#fff;border-radius:4px;">
    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Revenue</div>
    <div style="font-size:28px;font-weight:700;color:#1a1a1a;margin:2px 0;">$12,450</div>
    <div style="font-size:11px;color:#10b981;">+12.5%</div>
  </div>`,
  scriptSource: `// KPI Card — displays a metric value with title and delta
// Set "Value Cell" and "Delta Cell" to cell references like "A1"

function setup(shape) {
  shape.render.declareProperties([
    { key: "title", label: "Title", type: "text", defaultValue: "Metric" },
    { key: "valueCell", label: "Value Cell", type: "text", defaultValue: "" },
    { key: "deltaCell", label: "Delta Cell", type: "text", defaultValue: "" },
    { key: "accentColor", label: "Accent Color", type: "color", defaultValue: "#10b981" },
  ]);

  async function render() {
    var title = shape.getProperty("title") || "Metric";
    var valueCellRef = shape.getProperty("valueCell");
    var deltaCellRef = shape.getProperty("deltaCell");
    var accent = shape.getProperty("accentColor") || "#10b981";

    var value = valueCellRef ? await shape.getCellValue(valueCellRef) : "--";
    var delta = deltaCellRef ? await shape.getCellValue(deltaCellRef) : "";
    if (!value) value = "--";

    shape.render.setHtmlContent(
      '<div style="padding:12px;font-family:' + "'Segoe UI Variable',sans-serif" + ';height:100%;display:flex;flex-direction:column;justify-content:center;background:#fff;">' +
        '<div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">' + title + '</div>' +
        '<div style="font-size:28px;font-weight:700;color:#1a1a1a;margin:4px 0;">' + value + '</div>' +
        (delta ? '<div style="font-size:11px;color:' + accent + ';">' + delta + '</div>' : '') +
      '</div>'
    );
  }

  render();
  shape.onPropertyChange(function() { render(); });
  shape.onCellChange(function() { render(); });
}
`,
};

const PROGRESS_BAR: ShapeTemplate = {
  id: "tpl-progress-bar",
  name: "Progress Bar",
  description: "Horizontal progress bar with percentage, color transitions red to green.",
  category: "Indicators",
  defaultWidth: 220,
  defaultHeight: 50,
  previewHtml: `<div style="padding:8px 12px;font-family:sans-serif;height:100%;display:flex;flex-direction:column;justify-content:center;background:#fff;">
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#555;margin-bottom:4px;"><span>Progress</span><span>72%</span></div>
    <div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;"><div style="width:72%;height:100%;background:linear-gradient(90deg,#f59e0b,#10b981);border-radius:4px;"></div></div>
  </div>`,
  scriptSource: `// Progress Bar — horizontal bar bound to a cell value (0-100)
// Set "Value Cell" to a cell reference like "A1" containing a number

function setup(shape) {
  shape.render.declareProperties([
    { key: "label", label: "Label", type: "text", defaultValue: "Progress" },
    { key: "valueCell", label: "Value Cell", type: "text", defaultValue: "" },
    { key: "barHeight", label: "Bar Height", type: "number", defaultValue: "8" },
  ]);

  function getColor(pct) {
    var r, g, b;
    if (pct < 50) {
      r = 239; g = Math.round(68 + (158 - 68) * (pct / 50)); b = 68;
    } else {
      r = Math.round(245 - (245 - 16) * ((pct - 50) / 50)); g = Math.round(158 + (185 - 158) * ((pct - 50) / 50)); b = Math.round(11 + (129 - 11) * ((pct - 50) / 50));
    }
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  async function render() {
    var label = shape.getProperty("label") || "Progress";
    var cellRef = shape.getProperty("valueCell");
    var rawStr = cellRef ? await shape.getCellValue(cellRef) : "0";
    var raw = parseFloat(rawStr) || 0;
    var pct = Math.max(0, Math.min(100, raw));
    var barH = parseInt(shape.getProperty("barHeight")) || 8;
    var color = getColor(pct);

    shape.render.setHtmlContent(
      '<div style="padding:8px 12px;font-family:' + "'Segoe UI Variable',sans-serif" + ';height:100%;display:flex;flex-direction:column;justify-content:center;background:#fff;">' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:#555;margin-bottom:4px;"><span>' + label + '</span><span>' + Math.round(pct) + '%</span></div>' +
        '<div style="height:' + barH + 'px;background:#e5e7eb;border-radius:' + (barH / 2) + 'px;overflow:hidden;">' +
          '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:' + (barH / 2) + 'px;transition:width 0.3s;"></div>' +
        '</div>' +
      '</div>'
    );
  }

  render();
  shape.onPropertyChange(function() { render(); });
  shape.onCellChange(function() { render(); });
}
`,
};

const STATUS_INDICATOR: ShapeTemplate = {
  id: "tpl-status-indicator",
  name: "Status Indicator",
  description: "Traffic light indicator with label. Responds to ok/warn/error or numeric thresholds.",
  category: "Indicators",
  defaultWidth: 160,
  defaultHeight: 60,
  previewHtml: `<div style="padding:8px 12px;font-family:sans-serif;height:100%;display:flex;align-items:center;gap:10px;background:#fff;">
    <div style="width:20px;height:20px;border-radius:50%;background:#10b981;box-shadow:0 0 6px rgba(16,185,129,0.4);flex-shrink:0;"></div>
    <div><div style="font-size:12px;font-weight:600;color:#1a1a1a;">System Status</div><div style="font-size:10px;color:#888;">Operational</div></div>
  </div>`,
  scriptSource: `// Status Indicator — traffic light with label
// Set "Value Cell" to a cell containing "ok"/"warn"/"error" or a number (0-100)

function setup(shape) {
  shape.render.declareProperties([
    { key: "label", label: "Label", type: "text", defaultValue: "Status" },
    { key: "valueCell", label: "Value Cell", type: "text", defaultValue: "" },
  ]);

  var STATUS_MAP = {
    ok:    { color: "#10b981", glow: "rgba(16,185,129,0.4)", text: "Operational" },
    warn:  { color: "#f59e0b", glow: "rgba(245,158,11,0.4)", text: "Warning" },
    error: { color: "#ef4444", glow: "rgba(239,68,68,0.4)",  text: "Critical" },
  };

  function resolveStatus(val) {
    if (!val || val === "--" || val === "") return STATUS_MAP.ok;
    var lower = String(val).toLowerCase().trim();
    if (STATUS_MAP[lower]) return STATUS_MAP[lower];
    var num = parseFloat(val);
    if (!isNaN(num)) {
      if (num > 70) return STATUS_MAP.ok;
      if (num > 30) return STATUS_MAP.warn;
      return STATUS_MAP.error;
    }
    return STATUS_MAP.ok;
  }

  async function render() {
    var label = shape.getProperty("label") || "Status";
    var cellRef = shape.getProperty("valueCell");
    var val = cellRef ? await shape.getCellValue(cellRef) : "";
    var s = resolveStatus(val);

    shape.render.setHtmlContent(
      '<div style="padding:8px 12px;font-family:' + "'Segoe UI Variable',sans-serif" + ';height:100%;display:flex;align-items:center;gap:10px;background:#fff;">' +
        '<div style="width:20px;height:20px;border-radius:50%;background:' + s.color + ';box-shadow:0 0 6px ' + s.glow + ';flex-shrink:0;"></div>' +
        '<div>' +
          '<div style="font-size:12px;font-weight:600;color:#1a1a1a;">' + label + '</div>' +
          '<div style="font-size:10px;color:#888;">' + s.text + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  render();
  shape.onPropertyChange(function() { render(); });
  shape.onCellChange(function() { render(); });
}
`,
};

const METRIC_TILE: ShapeTemplate = {
  id: "tpl-metric-tile",
  name: "Metric Tile",
  description: "Clean large number display with subtitle, ideal for dashboard layouts.",
  category: "Data Cards",
  defaultWidth: 160,
  defaultHeight: 90,
  previewHtml: `<div style="padding:10px;font-family:sans-serif;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff;">
    <div style="font-size:32px;font-weight:700;color:#1a5fb4;">247</div>
    <div style="font-size:10px;color:#888;margin-top:2px;">Active Users</div>
  </div>`,
  scriptSource: `// Metric Tile — large number with subtitle
// Set "Value Cell" to a cell reference like "A1" for live data

function setup(shape) {
  shape.render.declareProperties([
    { key: "valueCell", label: "Value Cell", type: "text", defaultValue: "" },
    { key: "subtitle", label: "Subtitle", type: "text", defaultValue: "Metric" },
    { key: "valueColor", label: "Value Color", type: "color", defaultValue: "#1a5fb4" },
  ]);

  async function render() {
    var cellRef = shape.getProperty("valueCell");
    var value = cellRef ? await shape.getCellValue(cellRef) : "--";
    if (!value) value = "--";
    var subtitle = shape.getProperty("subtitle") || "Metric";
    var color = shape.getProperty("valueColor") || "#1a5fb4";

    shape.render.setHtmlContent(
      '<div style="padding:10px;font-family:' + "'Segoe UI Variable',sans-serif" + ';height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff;">' +
        '<div style="font-size:32px;font-weight:700;color:' + color + ';">' + value + '</div>' +
        '<div style="font-size:10px;color:#888;margin-top:2px;">' + subtitle + '</div>' +
      '</div>'
    );
  }

  render();
  shape.onPropertyChange(function() { render(); });
  shape.onCellChange(function() { render(); });
}
`,
};

const INTERACTIVE_COUNTER: ShapeTemplate = {
  id: "tpl-interactive-counter",
  name: "Interactive Counter",
  description: "Clickable buttons that increment/decrement a counter. Demonstrates two-way messaging.",
  category: "Interactive",
  defaultWidth: 180,
  defaultHeight: 80,
  previewHtml: `<div style="padding:8px;font-family:sans-serif;height:100%;display:flex;align-items:center;justify-content:center;gap:12px;background:#fff;">
    <div style="width:28px;height:28px;border-radius:50%;background:#e5e7eb;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#555;cursor:pointer;">-</div>
    <div style="font-size:28px;font-weight:700;color:#1a1a1a;min-width:40px;text-align:center;">0</div>
    <div style="width:28px;height:28px;border-radius:50%;background:#e5e7eb;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#555;cursor:pointer;">+</div>
  </div>`,
  scriptSource: `// Interactive Counter — demonstrates two-way postMessage communication
// Buttons inside the iframe send messages to the script, which updates the display

function setup(shape) {
  var count = 0;

  shape.render.declareProperties([
    { key: "startValue", label: "Start Value", type: "number", defaultValue: "0" },
    { key: "buttonColor", label: "Button Color", type: "color", defaultValue: "#e5e7eb" },
  ]);

  function render() {
    var btnColor = shape.getProperty("buttonColor") || "#e5e7eb";
    var btnStyle = "width:28px;height:28px;border-radius:50%;background:" + btnColor + ";display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#555;cursor:pointer;border:none;";

    shape.render.setHtmlContent(
      '<div style="padding:8px;font-family:' + "'Segoe UI Variable',sans-serif" + ';height:100%;display:flex;align-items:center;justify-content:center;gap:12px;background:#fff;">' +
        '<button onclick="calcula.sendMessage(' + "'decrement'" + ')" style="' + btnStyle + '">-</button>' +
        '<div style="font-size:28px;font-weight:700;color:#1a1a1a;min-width:40px;text-align:center;">' + count + '</div>' +
        '<button onclick="calcula.sendMessage(' + "'increment'" + ')" style="' + btnStyle + '">+</button>' +
      '</div>'
    );
  }

  shape.render.onMessage(function(msg) {
    if (msg.type === "increment") count++;
    if (msg.type === "decrement") count--;
    render();
  });

  // Initialize from property
  var startVal = parseInt(shape.getProperty("startValue"));
  if (!isNaN(startVal)) count = startVal;

  shape.onPropertyChange(function(change) {
    if (change.key === "startValue") {
      var sv = parseInt(change.newValue);
      if (!isNaN(sv)) { count = sv; render(); }
    } else {
      render();
    }
  });

  render();
}
`,
};

// ============================================================================
// Catalog
// ============================================================================

export const SHAPE_TEMPLATES: ShapeTemplate[] = [
  KPI_CARD,
  PROGRESS_BAR,
  STATUS_INDICATOR,
  METRIC_TILE,
  INTERACTIVE_COUNTER,
];

/** Get all template categories with their templates. */
export function getTemplateCategories(): Array<{ category: string; templates: ShapeTemplate[] }> {
  const catMap = new Map<string, ShapeTemplate[]>();
  for (const tpl of SHAPE_TEMPLATES) {
    if (!catMap.has(tpl.category)) catMap.set(tpl.category, []);
    catMap.get(tpl.category)!.push(tpl);
  }
  return Array.from(catMap.entries()).map(([category, templates]) => ({ category, templates }));
}

/** Get a template by ID. */
export function getShapeTemplate(id: string): ShapeTemplate | undefined {
  return SHAPE_TEMPLATES.find((t) => t.id === id);
}
