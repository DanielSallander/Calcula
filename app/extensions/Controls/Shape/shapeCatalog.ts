//! FILENAME: app/extensions/Controls/Shape/shapeCatalog.ts
// PURPOSE: Complete shape definitions catalog matching Excel shapes.
// CONTEXT: Each shape defined with normalized 0-1 path coordinates, scaled at render time.

// ============================================================================
// Types
// ============================================================================

export type ShapePathCommand =
  | { op: "M"; x: number; y: number }
  | { op: "L"; x: number; y: number }
  | { op: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: "Q"; x1: number; y1: number; x: number; y: number }
  | { op: "Z" };

export interface ShapeDefinition {
  /** Unique shape type identifier */
  id: string;
  /** Display name for menus and properties */
  label: string;
  /** Normalized path commands (0-1 coordinate space) */
  path: ShapePathCommand[];
  /** Default width when inserted */
  defaultWidth: number;
  /** Default height when inserted */
  defaultHeight: number;
  /** Whether the shape is a line (no fill, only stroke) */
  isLine?: boolean;
  /** Whether text should be rendered inside this shape (default true) */
  supportsText?: boolean;
}

export interface ShapeCategory {
  id: string;
  label: string;
  shapes: ShapeDefinition[];
}

// ============================================================================
// Helper: Generate regular polygon points
// ============================================================================

function regularPolygon(n: number, startAngle: number = -Math.PI / 2): ShapePathCommand[] {
  const cmds: ShapePathCommand[] = [];
  for (let i = 0; i <= n; i++) {
    const angle = startAngle + (2 * Math.PI * i) / n;
    const x = 0.5 + 0.5 * Math.cos(angle);
    const y = 0.5 + 0.5 * Math.sin(angle);
    cmds.push(i === 0 ? { op: "M", x, y } : { op: "L", x, y });
  }
  cmds.push({ op: "Z" });
  return cmds;
}

// ============================================================================
// Helper: Generate star points
// ============================================================================

function starShape(points: number, innerRadius: number = 0.4): ShapePathCommand[] {
  const cmds: ShapePathCommand[] = [];
  const total = points * 2;
  const startAngle = -Math.PI / 2;
  for (let i = 0; i <= total; i++) {
    const angle = startAngle + (2 * Math.PI * i) / total;
    const r = i % 2 === 0 ? 0.5 : innerRadius;
    const x = 0.5 + r * Math.cos(angle);
    const y = 0.5 + r * Math.sin(angle);
    cmds.push(i === 0 ? { op: "M", x, y } : { op: "L", x, y });
  }
  cmds.push({ op: "Z" });
  return cmds;
}

// ============================================================================
// Bezier kappa for quarter-circle approximation
// ============================================================================

const K = 0.5523;

// ============================================================================
// Oval path (4 cubic beziers)
// ============================================================================

const OVAL_PATH: ShapePathCommand[] = [
  { op: "M", x: 0.5, y: 0 },
  { op: "C", x1: 0.5 + 0.5 * K, y1: 0, x2: 1, y2: 0.5 - 0.5 * K, x: 1, y: 0.5 },
  { op: "C", x1: 1, y1: 0.5 + 0.5 * K, x2: 0.5 + 0.5 * K, y2: 1, x: 0.5, y: 1 },
  { op: "C", x1: 0.5 - 0.5 * K, y1: 1, x2: 0, y2: 0.5 + 0.5 * K, x: 0, y: 0.5 },
  { op: "C", x1: 0, y1: 0.5 - 0.5 * K, x2: 0.5 - 0.5 * K, y2: 0, x: 0.5, y: 0 },
  { op: "Z" },
];

// ============================================================================
// Rounded rectangle path
// ============================================================================

function roundedRect(r: number): ShapePathCommand[] {
  return [
    { op: "M", x: r, y: 0 },
    { op: "L", x: 1 - r, y: 0 },
    { op: "C", x1: 1 - r + r * K, y1: 0, x2: 1, y2: r - r * K, x: 1, y: r },
    { op: "L", x: 1, y: 1 - r },
    { op: "C", x1: 1, y1: 1 - r + r * K, x2: 1 - r + r * K, y2: 1, x: 1 - r, y: 1 },
    { op: "L", x: r, y: 1 },
    { op: "C", x1: r - r * K, y1: 1, x2: 0, y2: 1 - r + r * K, x: 0, y: 1 - r },
    { op: "L", x: 0, y: r },
    { op: "C", x1: 0, y1: r - r * K, x2: r - r * K, y2: 0, x: r, y: 0 },
    { op: "Z" },
  ];
}

// ============================================================================
// SHAPE CATEGORIES
// ============================================================================

export const SHAPE_CATEGORIES: ShapeCategory[] = [
  // ========================================================================
  // LINES
  // ========================================================================
  {
    id: "lines",
    label: "Lines",
    shapes: [
      {
        id: "line",
        label: "Line",
        path: [{ op: "M", x: 0, y: 0.5 }, { op: "L", x: 1, y: 0.5 }],
        defaultWidth: 120, defaultHeight: 2, isLine: true, supportsText: false,
      },
      {
        id: "diagonalLine",
        label: "Diagonal Line",
        path: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 1 }],
        defaultWidth: 100, defaultHeight: 100, isLine: true, supportsText: false,
      },
      {
        id: "diagonalLineReverse",
        label: "Diagonal Line (Reverse)",
        path: [{ op: "M", x: 0, y: 1 }, { op: "L", x: 1, y: 0 }],
        defaultWidth: 100, defaultHeight: 100, isLine: true, supportsText: false,
      },
      {
        id: "lineArrow",
        label: "Arrow Line",
        path: [
          { op: "M", x: 0, y: 0.5 }, { op: "L", x: 0.85, y: 0.5 },
          { op: "M", x: 0.85, y: 0.25 }, { op: "L", x: 1, y: 0.5 }, { op: "L", x: 0.85, y: 0.75 },
        ],
        defaultWidth: 120, defaultHeight: 20, isLine: true, supportsText: false,
      },
      {
        id: "doubleArrow",
        label: "Double Arrow Line",
        path: [
          { op: "M", x: 0.15, y: 0.5 }, { op: "L", x: 0.85, y: 0.5 },
          { op: "M", x: 0.85, y: 0.25 }, { op: "L", x: 1, y: 0.5 }, { op: "L", x: 0.85, y: 0.75 },
          { op: "M", x: 0.15, y: 0.25 }, { op: "L", x: 0, y: 0.5 }, { op: "L", x: 0.15, y: 0.75 },
        ],
        defaultWidth: 120, defaultHeight: 20, isLine: true, supportsText: false,
      },
      {
        id: "elbowConnector",
        label: "Elbow Connector",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 0.5, y: 0 },
          { op: "L", x: 0.5, y: 1 }, { op: "L", x: 1, y: 1 },
        ],
        defaultWidth: 100, defaultHeight: 80, isLine: true, supportsText: false,
      },
      {
        id: "elbowConnectorArrow",
        label: "Elbow Arrow Connector",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 0.5, y: 0 },
          { op: "L", x: 0.5, y: 1 }, { op: "L", x: 0.88, y: 1 },
          { op: "M", x: 0.88, y: 0.85 }, { op: "L", x: 1, y: 1 }, { op: "L", x: 0.88, y: 1 },
        ],
        defaultWidth: 100, defaultHeight: 80, isLine: true, supportsText: false,
      },
      {
        id: "curvedConnector",
        label: "Curved Connector",
        path: [
          { op: "M", x: 0, y: 0 },
          { op: "C", x1: 0.5, y1: 0, x2: 0.5, y2: 1, x: 1, y: 1 },
        ],
        defaultWidth: 100, defaultHeight: 80, isLine: true, supportsText: false,
      },
    ],
  },

  // ========================================================================
  // RECTANGLES
  // ========================================================================
  {
    id: "rectangles",
    label: "Rectangles",
    shapes: [
      {
        id: "rectangle",
        label: "Rectangle",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "roundedRectangle",
        label: "Rounded Rectangle",
        path: roundedRect(0.15),
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "snipSingleCorner",
        label: "Snip Single Corner",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 0.85, y: 0 },
          { op: "L", x: 1, y: 0.15 }, { op: "L", x: 1, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "snipSameSide",
        label: "Snip Same Side",
        path: [
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 0.85, y: 0 },
          { op: "L", x: 1, y: 0.15 }, { op: "L", x: 1, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "L", x: 0, y: 0.15 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "snipDiagonal",
        label: "Snip Diagonal",
        path: [
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.85 }, { op: "L", x: 0.85, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "L", x: 0, y: 0.15 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "snipAndRound",
        label: "Snip and Round",
        path: [
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 0.85, y: 0 },
          { op: "L", x: 1, y: 0.15 }, { op: "L", x: 1, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "L", x: 0, y: 0.15 },
          { op: "C", x1: 0, y1: 0.15 * (1 - K), x2: 0.15 * (1 - K), y2: 0, x: 0.15, y: 0 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "roundSingleCorner",
        label: "Round Single Corner",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 0.85, y: 0 },
          { op: "C", x1: 0.85 + 0.15 * K, y1: 0, x2: 1, y2: 0.15 * (1 - K), x: 1, y: 0.15 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "roundSameSide",
        label: "Round Same Side",
        path: [
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 0.85, y: 0 },
          { op: "C", x1: 0.85 + 0.15 * K, y1: 0, x2: 1, y2: 0.15 * (1 - K), x: 1, y: 0.15 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 },
          { op: "L", x: 0, y: 0.15 },
          { op: "C", x1: 0, y1: 0.15 * (1 - K), x2: 0.15 * (1 - K), y2: 0, x: 0.15, y: 0 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "roundDiagonal",
        label: "Round Diagonal",
        path: [
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.85 },
          { op: "C", x1: 1, y1: 0.85 + 0.15 * K, x2: 0.85 + 0.15 * K, y2: 1, x: 0.85, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "L", x: 0, y: 0.15 },
          { op: "C", x1: 0, y1: 0.15 * (1 - K), x2: 0.15 * (1 - K), y2: 0, x: 0.15, y: 0 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "halfFrame",
        label: "Half Frame",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 0.7, y: 0.3 }, { op: "L", x: 0.3, y: 0.3 },
          { op: "L", x: 0.3, y: 0.7 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: false,
      },
    ],
  },

  // ========================================================================
  // BASIC SHAPES
  // ========================================================================
  {
    id: "basicShapes",
    label: "Basic Shapes",
    shapes: [
      {
        id: "textBox",
        label: "Text Box",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 140, defaultHeight: 60, supportsText: true,
      },
      {
        id: "oval",
        label: "Oval",
        path: OVAL_PATH,
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "isoscelesTriangle",
        label: "Triangle",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 1, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 90, supportsText: true,
      },
      {
        id: "rightTriangle",
        label: "Right Triangle",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "diamond",
        label: "Diamond",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 1, y: 0.5 },
          { op: "L", x: 0.5, y: 1 }, { op: "L", x: 0, y: 0.5 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "parallelogram",
        label: "Parallelogram",
        path: [
          { op: "M", x: 0.2, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 0.8, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "trapezoid",
        label: "Trapezoid",
        path: [
          { op: "M", x: 0.2, y: 0 }, { op: "L", x: 0.8, y: 0 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "pentagon",
        label: "Pentagon",
        path: regularPolygon(5),
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "hexagon",
        label: "Hexagon",
        path: regularPolygon(6),
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "heptagon",
        label: "Heptagon",
        path: regularPolygon(7),
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "octagon",
        label: "Octagon",
        path: regularPolygon(8),
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "decagon",
        label: "Decagon",
        path: regularPolygon(10),
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "dodecagon",
        label: "Dodecagon",
        path: regularPolygon(12),
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "cross",
        label: "Cross",
        path: [
          { op: "M", x: 0.35, y: 0 }, { op: "L", x: 0.65, y: 0 },
          { op: "L", x: 0.65, y: 0.35 }, { op: "L", x: 1, y: 0.35 },
          { op: "L", x: 1, y: 0.65 }, { op: "L", x: 0.65, y: 0.65 },
          { op: "L", x: 0.65, y: 1 }, { op: "L", x: 0.35, y: 1 },
          { op: "L", x: 0.35, y: 0.65 }, { op: "L", x: 0, y: 0.65 },
          { op: "L", x: 0, y: 0.35 }, { op: "L", x: 0.35, y: 0.35 }, { op: "Z" },
        ],
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "frame",
        label: "Frame",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
          { op: "M", x: 0.15, y: 0.15 }, { op: "L", x: 0.15, y: 0.85 },
          { op: "L", x: 0.85, y: 0.85 }, { op: "L", x: 0.85, y: 0.15 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: false,
      },
      {
        id: "lShape",
        label: "L-Shape",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 0.4, y: 0 },
          { op: "L", x: 0.4, y: 0.6 }, { op: "L", x: 1, y: 0.6 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: false,
      },
      {
        id: "diagonalStripe",
        label: "Diagonal Stripe",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: false,
      },
      {
        id: "plaque",
        label: "Plaque",
        path: [
          { op: "M", x: 0.1, y: 0 }, { op: "L", x: 0.9, y: 0 },
          { op: "C", x1: 0.8, y1: 0.1, x2: 0.8, y2: 0.1, x: 0.9, y: 0.1 },
          { op: "L", x: 1, y: 0.1 }, { op: "L", x: 1, y: 0.9 },
          { op: "L", x: 0.9, y: 0.9 },
          { op: "C", x1: 0.8, y1: 0.9, x2: 0.8, y2: 0.9, x: 0.9, y: 1 },
          { op: "L", x: 0.1, y: 1 },
          { op: "C", x1: 0.2, y1: 0.9, x2: 0.2, y2: 0.9, x: 0.1, y: 0.9 },
          { op: "L", x: 0, y: 0.9 }, { op: "L", x: 0, y: 0.1 },
          { op: "L", x: 0.1, y: 0.1 },
          { op: "C", x1: 0.2, y1: 0.1, x2: 0.2, y2: 0.1, x: 0.1, y: 0 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "donut",
        label: "Donut",
        path: [
          // Outer circle
          { op: "M", x: 0.5, y: 0 },
          { op: "C", x1: 0.5 + 0.5 * K, y1: 0, x2: 1, y2: 0.5 - 0.5 * K, x: 1, y: 0.5 },
          { op: "C", x1: 1, y1: 0.5 + 0.5 * K, x2: 0.5 + 0.5 * K, y2: 1, x: 0.5, y: 1 },
          { op: "C", x1: 0.5 - 0.5 * K, y1: 1, x2: 0, y2: 0.5 + 0.5 * K, x: 0, y: 0.5 },
          { op: "C", x1: 0, y1: 0.5 - 0.5 * K, x2: 0.5 - 0.5 * K, y2: 0, x: 0.5, y: 0 },
          { op: "Z" },
          // Inner circle (hole) - counterclockwise for cutout
          { op: "M", x: 0.5, y: 0.25 },
          { op: "C", x1: 0.5 - 0.25 * K, y1: 0.25, x2: 0.25, y2: 0.5 - 0.25 * K, x: 0.25, y: 0.5 },
          { op: "C", x1: 0.25, y1: 0.5 + 0.25 * K, x2: 0.5 - 0.25 * K, y2: 0.75, x: 0.5, y: 0.75 },
          { op: "C", x1: 0.5 + 0.25 * K, y1: 0.75, x2: 0.75, y2: 0.5 + 0.25 * K, x: 0.75, y: 0.5 },
          { op: "C", x1: 0.75, y1: 0.5 - 0.25 * K, x2: 0.5 + 0.25 * K, y2: 0.25, x: 0.5, y: 0.25 },
          { op: "Z" },
        ],
        defaultWidth: 80, defaultHeight: 80, supportsText: false,
      },
      {
        id: "noSymbol",
        label: "No Symbol",
        path: [
          // Outer circle
          ...OVAL_PATH.slice(0, -1),
          { op: "Z" } as ShapePathCommand,
          // Diagonal line (rendered as stroke, but included in path for fill)
          { op: "M", x: 0.146, y: 0.146 },
          { op: "L", x: 0.854, y: 0.854 },
        ],
        defaultWidth: 80, defaultHeight: 80, supportsText: false,
      },
      {
        id: "heart",
        label: "Heart",
        path: [
          { op: "M", x: 0.5, y: 0.3 },
          { op: "C", x1: 0.5, y1: 0.15, x2: 0.35, y2: 0, x: 0.175, y: 0 },
          { op: "C", x1: 0, y1: 0, x2: 0, y2: 0.2, x: 0, y: 0.3 },
          { op: "C", x1: 0, y1: 0.55, x2: 0.2, y2: 0.7, x: 0.5, y: 1 },
          { op: "C", x1: 0.8, y1: 0.7, x2: 1, y2: 0.55, x: 1, y: 0.3 },
          { op: "C", x1: 1, y1: 0.2, x2: 1, y2: 0, x: 0.825, y: 0 },
          { op: "C", x1: 0.65, y1: 0, x2: 0.5, y2: 0.15, x: 0.5, y: 0.3 },
          { op: "Z" },
        ],
        defaultWidth: 80, defaultHeight: 80, supportsText: false,
      },
      {
        id: "lightningBolt",
        label: "Lightning Bolt",
        path: [
          { op: "M", x: 0.55, y: 0 }, { op: "L", x: 0.2, y: 0.45 },
          { op: "L", x: 0.45, y: 0.45 }, { op: "L", x: 0.3, y: 1 },
          { op: "L", x: 0.8, y: 0.5 }, { op: "L", x: 0.55, y: 0.5 },
          { op: "L", x: 0.75, y: 0 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 100, supportsText: false,
      },
      {
        id: "sun",
        label: "Sun",
        path: starShape(12, 0.3),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "moon",
        label: "Moon",
        path: [
          { op: "M", x: 0.6, y: 0 },
          { op: "C", x1: 0.25, y1: 0.05, x2: 0, y2: 0.3, x: 0, y: 0.5 },
          { op: "C", x1: 0, y1: 0.7, x2: 0.25, y2: 0.95, x: 0.6, y: 1 },
          { op: "C", x1: 0.4, y1: 0.85, x2: 0.3, y2: 0.65, x: 0.3, y: 0.5 },
          { op: "C", x1: 0.3, y1: 0.35, x2: 0.4, y2: 0.15, x: 0.6, y: 0 },
          { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 80, supportsText: false,
      },
      {
        id: "cloud",
        label: "Cloud",
        path: [
          { op: "M", x: 0.25, y: 0.75 },
          { op: "C", x1: 0.05, y1: 0.75, x2: 0, y2: 0.6, x: 0.05, y: 0.5 },
          { op: "C", x1: 0.0, y1: 0.35, x2: 0.1, y2: 0.25, x: 0.2, y: 0.25 },
          { op: "C", x1: 0.2, y1: 0.1, x2: 0.35, y2: 0, x: 0.5, y: 0.05 },
          { op: "C", x1: 0.6, y1: 0, x2: 0.75, y2: 0.05, x: 0.8, y: 0.15 },
          { op: "C", x1: 0.9, y1: 0.1, x2: 1, y2: 0.25, x: 0.95, y: 0.4 },
          { op: "C", x1: 1, y1: 0.55, x2: 0.9, y2: 0.7, x: 0.75, y: 0.75 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "smileyFace",
        label: "Smiley Face",
        path: [
          // Outer circle
          ...OVAL_PATH.slice(0, -1),
          { op: "Z" } as ShapePathCommand,
          // Left eye
          { op: "M", x: 0.35, y: 0.35 },
          { op: "C", x1: 0.37, y1: 0.32, x2: 0.39, y2: 0.32, x: 0.4, y: 0.35 },
          { op: "C", x1: 0.39, y1: 0.38, x2: 0.37, y2: 0.38, x: 0.35, y: 0.35 },
          { op: "Z" },
          // Right eye
          { op: "M", x: 0.6, y: 0.35 },
          { op: "C", x1: 0.62, y1: 0.32, x2: 0.64, y2: 0.32, x: 0.65, y: 0.35 },
          { op: "C", x1: 0.64, y1: 0.38, x2: 0.62, y2: 0.38, x: 0.6, y: 0.35 },
          { op: "Z" },
          // Smile
          { op: "M", x: 0.3, y: 0.6 },
          { op: "C", x1: 0.35, y1: 0.75, x2: 0.65, y2: 0.75, x: 0.7, y: 0.6 },
        ],
        defaultWidth: 80, defaultHeight: 80, supportsText: false,
      },
      {
        id: "foldedCorner",
        label: "Folded Corner",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.75 }, { op: "L", x: 0.75, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "Z" },
          // Fold
          { op: "M", x: 1, y: 0.75 }, { op: "L", x: 0.75, y: 0.75 },
          { op: "L", x: 0.75, y: 1 },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "teardrop",
        label: "Teardrop",
        path: [
          { op: "M", x: 0.5, y: 0 },
          { op: "L", x: 1, y: 0.5 },
          { op: "C", x1: 1, y1: 0.5 + 0.5 * K, x2: 0.5 + 0.5 * K, y2: 1, x: 0.5, y: 1 },
          { op: "C", x1: 0.5 - 0.5 * K, y1: 1, x2: 0, y2: 0.5 + 0.5 * K, x: 0, y: 0.5 },
          { op: "Z" },
        ],
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "pie",
        label: "Pie (3/4)",
        path: [
          { op: "M", x: 0.5, y: 0.5 }, { op: "L", x: 0.5, y: 0 },
          { op: "C", x1: 0.5 + 0.5 * K, y1: 0, x2: 1, y2: 0.5 - 0.5 * K, x: 1, y: 0.5 },
          { op: "C", x1: 1, y1: 0.5 + 0.5 * K, x2: 0.5 + 0.5 * K, y2: 1, x: 0.5, y: 1 },
          { op: "C", x1: 0.5 - 0.5 * K, y1: 1, x2: 0, y2: 0.5 + 0.5 * K, x: 0, y: 0.5 },
          { op: "Z" },
        ],
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "blockArc",
        label: "Block Arc",
        path: [
          { op: "M", x: 0.5, y: 0 },
          { op: "C", x1: 0.5 + 0.5 * K, y1: 0, x2: 1, y2: 0.5 - 0.5 * K, x: 1, y: 0.5 },
          { op: "L", x: 0.75, y: 0.5 },
          { op: "C", x1: 0.75, y1: 0.5 - 0.25 * K, x2: 0.5 + 0.25 * K, y2: 0.25, x: 0.5, y: 0.25 },
          { op: "Z" },
        ],
        defaultWidth: 80, defaultHeight: 80, supportsText: false,
      },
      {
        id: "leftBracket",
        label: "Left Bracket",
        path: [
          { op: "M", x: 1, y: 0 },
          { op: "C", x1: 0.3, y1: 0, x2: 0, y2: 0.2, x: 0, y: 0.5 },
          { op: "C", x1: 0, y1: 0.8, x2: 0.3, y2: 1, x: 1, y: 1 },
        ],
        defaultWidth: 30, defaultHeight: 80, isLine: true, supportsText: false,
      },
      {
        id: "rightBracket",
        label: "Right Bracket",
        path: [
          { op: "M", x: 0, y: 0 },
          { op: "C", x1: 0.7, y1: 0, x2: 1, y2: 0.2, x: 1, y: 0.5 },
          { op: "C", x1: 1, y1: 0.8, x2: 0.7, y2: 1, x: 0, y: 1 },
        ],
        defaultWidth: 30, defaultHeight: 80, isLine: true, supportsText: false,
      },
      {
        id: "leftBrace",
        label: "Left Brace",
        path: [
          { op: "M", x: 1, y: 0 },
          { op: "C", x1: 0.4, y1: 0, x2: 0.4, y2: 0.2, x: 0.4, y: 0.35 },
          { op: "C", x1: 0.4, y1: 0.45, x2: 0, y2: 0.45, x: 0, y: 0.5 },
          { op: "C", x1: 0, y1: 0.55, x2: 0.4, y2: 0.55, x: 0.4, y: 0.65 },
          { op: "C", x1: 0.4, y1: 0.8, x2: 0.4, y2: 1, x: 1, y: 1 },
        ],
        defaultWidth: 30, defaultHeight: 80, isLine: true, supportsText: false,
      },
      {
        id: "rightBrace",
        label: "Right Brace",
        path: [
          { op: "M", x: 0, y: 0 },
          { op: "C", x1: 0.6, y1: 0, x2: 0.6, y2: 0.2, x: 0.6, y: 0.35 },
          { op: "C", x1: 0.6, y1: 0.45, x2: 1, y2: 0.45, x: 1, y: 0.5 },
          { op: "C", x1: 1, y1: 0.55, x2: 0.6, y2: 0.55, x: 0.6, y: 0.65 },
          { op: "C", x1: 0.6, y1: 0.8, x2: 0.6, y2: 1, x: 0, y: 1 },
        ],
        defaultWidth: 30, defaultHeight: 80, isLine: true, supportsText: false,
      },
    ],
  },

  // ========================================================================
  // BLOCK ARROWS
  // ========================================================================
  {
    id: "blockArrows",
    label: "Block Arrows",
    shapes: [
      {
        id: "rightArrow",
        label: "Right Arrow",
        path: [
          { op: "M", x: 0, y: 0.25 }, { op: "L", x: 0.65, y: 0.25 },
          { op: "L", x: 0.65, y: 0 }, { op: "L", x: 1, y: 0.5 },
          { op: "L", x: 0.65, y: 1 }, { op: "L", x: 0.65, y: 0.75 },
          { op: "L", x: 0, y: 0.75 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "leftArrow",
        label: "Left Arrow",
        path: [
          { op: "M", x: 1, y: 0.25 }, { op: "L", x: 0.35, y: 0.25 },
          { op: "L", x: 0.35, y: 0 }, { op: "L", x: 0, y: 0.5 },
          { op: "L", x: 0.35, y: 1 }, { op: "L", x: 0.35, y: 0.75 },
          { op: "L", x: 1, y: 0.75 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "upArrow",
        label: "Up Arrow",
        path: [
          { op: "M", x: 0.25, y: 1 }, { op: "L", x: 0.25, y: 0.35 },
          { op: "L", x: 0, y: 0.35 }, { op: "L", x: 0.5, y: 0 },
          { op: "L", x: 1, y: 0.35 }, { op: "L", x: 0.75, y: 0.35 },
          { op: "L", x: 0.75, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 120, supportsText: true,
      },
      {
        id: "downArrow",
        label: "Down Arrow",
        path: [
          { op: "M", x: 0.25, y: 0 }, { op: "L", x: 0.75, y: 0 },
          { op: "L", x: 0.75, y: 0.65 }, { op: "L", x: 1, y: 0.65 },
          { op: "L", x: 0.5, y: 1 }, { op: "L", x: 0, y: 0.65 },
          { op: "L", x: 0.25, y: 0.65 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 120, supportsText: true,
      },
      {
        id: "leftRightArrow",
        label: "Left-Right Arrow",
        path: [
          { op: "M", x: 0, y: 0.5 }, { op: "L", x: 0.2, y: 0 },
          { op: "L", x: 0.2, y: 0.25 }, { op: "L", x: 0.8, y: 0.25 },
          { op: "L", x: 0.8, y: 0 }, { op: "L", x: 1, y: 0.5 },
          { op: "L", x: 0.8, y: 1 }, { op: "L", x: 0.8, y: 0.75 },
          { op: "L", x: 0.2, y: 0.75 }, { op: "L", x: 0.2, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 140, defaultHeight: 60, supportsText: true,
      },
      {
        id: "upDownArrow",
        label: "Up-Down Arrow",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 1, y: 0.2 },
          { op: "L", x: 0.75, y: 0.2 }, { op: "L", x: 0.75, y: 0.8 },
          { op: "L", x: 1, y: 0.8 }, { op: "L", x: 0.5, y: 1 },
          { op: "L", x: 0, y: 0.8 }, { op: "L", x: 0.25, y: 0.8 },
          { op: "L", x: 0.25, y: 0.2 }, { op: "L", x: 0, y: 0.2 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 140, supportsText: true,
      },
      {
        id: "quadArrow",
        label: "Quad Arrow",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 0.65, y: 0.2 },
          { op: "L", x: 0.57, y: 0.2 }, { op: "L", x: 0.57, y: 0.43 },
          { op: "L", x: 0.8, y: 0.43 }, { op: "L", x: 0.8, y: 0.35 },
          { op: "L", x: 1, y: 0.5 }, { op: "L", x: 0.8, y: 0.65 },
          { op: "L", x: 0.8, y: 0.57 }, { op: "L", x: 0.57, y: 0.57 },
          { op: "L", x: 0.57, y: 0.8 }, { op: "L", x: 0.65, y: 0.8 },
          { op: "L", x: 0.5, y: 1 }, { op: "L", x: 0.35, y: 0.8 },
          { op: "L", x: 0.43, y: 0.8 }, { op: "L", x: 0.43, y: 0.57 },
          { op: "L", x: 0.2, y: 0.57 }, { op: "L", x: 0.2, y: 0.65 },
          { op: "L", x: 0, y: 0.5 }, { op: "L", x: 0.2, y: 0.35 },
          { op: "L", x: 0.2, y: 0.43 }, { op: "L", x: 0.43, y: 0.43 },
          { op: "L", x: 0.43, y: 0.2 }, { op: "L", x: 0.35, y: 0.2 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "bentArrow",
        label: "Bent Arrow",
        path: [
          { op: "M", x: 0, y: 1 }, { op: "L", x: 0, y: 0.4 },
          { op: "L", x: 0.55, y: 0.4 }, { op: "L", x: 0.55, y: 0 },
          { op: "L", x: 1, y: 0.5 }, { op: "L", x: 0.55, y: 1 },
          { op: "L", x: 0.55, y: 0.65 }, { op: "L", x: 0.25, y: 0.65 },
          { op: "L", x: 0.25, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "uturnArrow",
        label: "U-Turn Arrow",
        path: [
          { op: "M", x: 0, y: 0.4 },
          { op: "C", x1: 0, y1: 0.15, x2: 0.2, y2: 0, x: 0.45, y: 0 },
          { op: "C", x1: 0.7, y1: 0, x2: 0.85, y2: 0.15, x: 0.85, y: 0.4 },
          { op: "L", x: 0.85, y: 0.65 }, { op: "L", x: 1, y: 0.65 },
          { op: "L", x: 0.7, y: 1 }, { op: "L", x: 0.4, y: 0.65 },
          { op: "L", x: 0.55, y: 0.65 }, { op: "L", x: 0.55, y: 0.4 },
          { op: "C", x1: 0.55, y1: 0.3, x2: 0.5, y2: 0.25, x: 0.45, y: 0.25 },
          { op: "C", x1: 0.4, y1: 0.25, x2: 0.3, y2: 0.3, x: 0.3, y: 0.4 },
          { op: "L", x: 0.3, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 120, supportsText: false,
      },
      {
        id: "chevron",
        label: "Chevron",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 0.75, y: 0 },
          { op: "L", x: 1, y: 0.5 }, { op: "L", x: 0.75, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "L", x: 0.25, y: 0.5 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "homePentagon",
        label: "Pentagon Arrow",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 0.75, y: 0 },
          { op: "L", x: 1, y: 0.5 }, { op: "L", x: 0.75, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "notchedRightArrow",
        label: "Notched Right Arrow",
        path: [
          { op: "M", x: 0, y: 0.25 }, { op: "L", x: 0.65, y: 0.25 },
          { op: "L", x: 0.65, y: 0 }, { op: "L", x: 1, y: 0.5 },
          { op: "L", x: 0.65, y: 1 }, { op: "L", x: 0.65, y: 0.75 },
          { op: "L", x: 0, y: 0.75 }, { op: "L", x: 0.1, y: 0.5 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "stripedRightArrow",
        label: "Striped Right Arrow",
        path: [
          { op: "M", x: 0, y: 0.3 }, { op: "L", x: 0.04, y: 0.3 },
          { op: "L", x: 0.04, y: 0.7 }, { op: "L", x: 0, y: 0.7 }, { op: "Z" },
          { op: "M", x: 0.06, y: 0.3 }, { op: "L", x: 0.1, y: 0.3 },
          { op: "L", x: 0.1, y: 0.7 }, { op: "L", x: 0.06, y: 0.7 }, { op: "Z" },
          { op: "M", x: 0.12, y: 0.3 }, { op: "L", x: 0.16, y: 0.3 },
          { op: "L", x: 0.16, y: 0.7 }, { op: "L", x: 0.12, y: 0.7 }, { op: "Z" },
          { op: "M", x: 0.2, y: 0.3 }, { op: "L", x: 0.65, y: 0.3 },
          { op: "L", x: 0.65, y: 0 }, { op: "L", x: 1, y: 0.5 },
          { op: "L", x: 0.65, y: 1 }, { op: "L", x: 0.65, y: 0.7 },
          { op: "L", x: 0.2, y: 0.7 }, { op: "Z" },
        ],
        defaultWidth: 140, defaultHeight: 60, supportsText: true,
      },
      {
        id: "leftUpArrow",
        label: "Left-Up Arrow",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 0.75, y: 0.3 },
          { op: "L", x: 0.62, y: 0.3 }, { op: "L", x: 0.62, y: 0.62 },
          { op: "L", x: 0.3, y: 0.62 }, { op: "L", x: 0.3, y: 0.75 },
          { op: "L", x: 0, y: 0.5 }, { op: "L", x: 0.3, y: 0.25 },
          { op: "L", x: 0.3, y: 0.38 }, { op: "L", x: 0.38, y: 0.38 },
          { op: "L", x: 0.38, y: 0.3 }, { op: "L", x: 0.25, y: 0.3 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: false,
      },
      {
        id: "leftRightUpArrow",
        label: "Left-Right-Up Arrow",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 0.65, y: 0.2 },
          { op: "L", x: 0.57, y: 0.2 }, { op: "L", x: 0.57, y: 0.43 },
          { op: "L", x: 0.8, y: 0.43 }, { op: "L", x: 0.8, y: 0.35 },
          { op: "L", x: 1, y: 0.5 }, { op: "L", x: 0.8, y: 0.65 },
          { op: "L", x: 0.8, y: 0.57 }, { op: "L", x: 0.57, y: 0.57 },
          { op: "L", x: 0.57, y: 0.8 }, { op: "L", x: 0.43, y: 0.8 },
          { op: "L", x: 0.43, y: 0.57 }, { op: "L", x: 0.2, y: 0.57 },
          { op: "L", x: 0.2, y: 0.65 }, { op: "L", x: 0, y: 0.5 },
          { op: "L", x: 0.2, y: 0.35 }, { op: "L", x: 0.2, y: 0.43 },
          { op: "L", x: 0.43, y: 0.43 }, { op: "L", x: 0.43, y: 0.2 },
          { op: "L", x: 0.35, y: 0.2 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: false,
      },
    ],
  },

  // ========================================================================
  // EQUATION SHAPES
  // ========================================================================
  {
    id: "equationShapes",
    label: "Equation Shapes",
    shapes: [
      {
        id: "mathPlus",
        label: "Plus",
        path: [
          { op: "M", x: 0.35, y: 0 }, { op: "L", x: 0.65, y: 0 },
          { op: "L", x: 0.65, y: 0.35 }, { op: "L", x: 1, y: 0.35 },
          { op: "L", x: 1, y: 0.65 }, { op: "L", x: 0.65, y: 0.65 },
          { op: "L", x: 0.65, y: 1 }, { op: "L", x: 0.35, y: 1 },
          { op: "L", x: 0.35, y: 0.65 }, { op: "L", x: 0, y: 0.65 },
          { op: "L", x: 0, y: 0.35 }, { op: "L", x: 0.35, y: 0.35 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "mathMinus",
        label: "Minus",
        path: [
          { op: "M", x: 0, y: 0.35 }, { op: "L", x: 1, y: 0.35 },
          { op: "L", x: 1, y: 0.65 }, { op: "L", x: 0, y: 0.65 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "mathMultiply",
        label: "Multiply",
        path: [
          { op: "M", x: 0.2, y: 0 }, { op: "L", x: 0.5, y: 0.3 },
          { op: "L", x: 0.8, y: 0 }, { op: "L", x: 1, y: 0.2 },
          { op: "L", x: 0.7, y: 0.5 }, { op: "L", x: 1, y: 0.8 },
          { op: "L", x: 0.8, y: 1 }, { op: "L", x: 0.5, y: 0.7 },
          { op: "L", x: 0.2, y: 1 }, { op: "L", x: 0, y: 0.8 },
          { op: "L", x: 0.3, y: 0.5 }, { op: "L", x: 0, y: 0.2 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "mathDivide",
        label: "Divide",
        path: [
          // Horizontal bar
          { op: "M", x: 0, y: 0.4 }, { op: "L", x: 1, y: 0.4 },
          { op: "L", x: 1, y: 0.6 }, { op: "L", x: 0, y: 0.6 }, { op: "Z" },
          // Top dot (small circle approximated as diamond)
          { op: "M", x: 0.5, y: 0.1 }, { op: "L", x: 0.58, y: 0.2 },
          { op: "L", x: 0.5, y: 0.3 }, { op: "L", x: 0.42, y: 0.2 }, { op: "Z" },
          // Bottom dot
          { op: "M", x: 0.5, y: 0.7 }, { op: "L", x: 0.58, y: 0.8 },
          { op: "L", x: 0.5, y: 0.9 }, { op: "L", x: 0.42, y: 0.8 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "mathEqual",
        label: "Equal",
        path: [
          { op: "M", x: 0.1, y: 0.25 }, { op: "L", x: 0.9, y: 0.25 },
          { op: "L", x: 0.9, y: 0.42 }, { op: "L", x: 0.1, y: 0.42 }, { op: "Z" },
          { op: "M", x: 0.1, y: 0.58 }, { op: "L", x: 0.9, y: 0.58 },
          { op: "L", x: 0.9, y: 0.75 }, { op: "L", x: 0.1, y: 0.75 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
    ],
  },

  // ========================================================================
  // FLOWCHART
  // ========================================================================
  {
    id: "flowchart",
    label: "Flowchart",
    shapes: [
      {
        id: "flowchartProcess",
        label: "Process",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartAlternateProcess",
        label: "Alternate Process",
        path: roundedRect(0.2),
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartDecision",
        label: "Decision",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 1, y: 0.5 },
          { op: "L", x: 0.5, y: 1 }, { op: "L", x: 0, y: 0.5 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "flowchartData",
        label: "Data",
        path: [
          { op: "M", x: 0.2, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 0.8, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartPredefinedProcess",
        label: "Predefined Process",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
          { op: "M", x: 0.1, y: 0 }, { op: "L", x: 0.1, y: 1 },
          { op: "M", x: 0.9, y: 0 }, { op: "L", x: 0.9, y: 1 },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartInternalStorage",
        label: "Internal Storage",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 0.15, y: 1 },
          { op: "M", x: 0, y: 0.15 }, { op: "L", x: 1, y: 0.15 },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "flowchartDocument",
        label: "Document",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.8 },
          { op: "C", x1: 0.75, y1: 0.95, x2: 0.55, y2: 1, x: 0.5, y: 0.85 },
          { op: "C", x1: 0.45, y1: 0.7, x2: 0.25, y2: 0.75, x: 0, y: 0.9 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "flowchartMultidocument",
        label: "Multidocument",
        path: [
          // Front document
          { op: "M", x: 0, y: 0.1 }, { op: "L", x: 0.9, y: 0.1 },
          { op: "L", x: 0.9, y: 0.8 },
          { op: "C", x1: 0.7, y1: 0.95, x2: 0.5, y2: 1, x: 0.45, y: 0.85 },
          { op: "C", x1: 0.4, y1: 0.7, x2: 0.2, y2: 0.75, x: 0, y: 0.9 },
          { op: "Z" },
          // Back tabs
          { op: "M", x: 0.05, y: 0.05 }, { op: "L", x: 0.95, y: 0.05 },
          { op: "L", x: 0.95, y: 0.1 },
          { op: "M", x: 0.1, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.05 },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "flowchartTerminator",
        label: "Terminator",
        path: [
          { op: "M", x: 0.25, y: 0 }, { op: "L", x: 0.75, y: 0 },
          { op: "C", x1: 1, y1: 0, x2: 1, y2: 1, x: 0.75, y: 1 },
          { op: "L", x: 0.25, y: 1 },
          { op: "C", x1: 0, y1: 1, x2: 0, y2: 0, x: 0.25, y: 0 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 50, supportsText: true,
      },
      {
        id: "flowchartPreparation",
        label: "Preparation",
        path: [
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 0.85, y: 0 },
          { op: "L", x: 1, y: 0.5 }, { op: "L", x: 0.85, y: 1 },
          { op: "L", x: 0.15, y: 1 }, { op: "L", x: 0, y: 0.5 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartManualInput",
        label: "Manual Input",
        path: [
          { op: "M", x: 0, y: 0.2 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartManualOperation",
        label: "Manual Operation",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 0.8, y: 1 }, { op: "L", x: 0.2, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartConnector",
        label: "Connector",
        path: OVAL_PATH,
        defaultWidth: 50, defaultHeight: 50, supportsText: true,
      },
      {
        id: "flowchartOffpageConnector",
        label: "Off-page Connector",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.7 }, { op: "L", x: 0.5, y: 1 },
          { op: "L", x: 0, y: 0.7 }, { op: "Z" },
        ],
        defaultWidth: 50, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartCard",
        label: "Card",
        path: [
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 1 }, { op: "L", x: 0, y: 1 },
          { op: "L", x: 0, y: 0.15 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 80, supportsText: true,
      },
      {
        id: "flowchartPunchedTape",
        label: "Punched Tape",
        path: [
          { op: "M", x: 0, y: 0.1 },
          { op: "C", x1: 0.25, y1: 0.25, x2: 0.75, y2: -0.05, x: 1, y: 0.1 },
          { op: "L", x: 1, y: 0.9 },
          { op: "C", x1: 0.75, y1: 0.75, x2: 0.25, y2: 1.05, x: 0, y: 0.9 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 80, supportsText: true,
      },
      {
        id: "flowchartSummingJunction",
        label: "Summing Junction",
        path: [
          ...OVAL_PATH.slice(0, -1),
          { op: "Z" } as ShapePathCommand,
          { op: "M", x: 0.146, y: 0.146 }, { op: "L", x: 0.854, y: 0.854 },
          { op: "M", x: 0.854, y: 0.146 }, { op: "L", x: 0.146, y: 0.854 },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "flowchartOr",
        label: "Or",
        path: [
          ...OVAL_PATH.slice(0, -1),
          { op: "Z" } as ShapePathCommand,
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 0.5, y: 1 },
          { op: "M", x: 0, y: 0.5 }, { op: "L", x: 1, y: 0.5 },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "flowchartCollate",
        label: "Collate",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 0, y: 1 }, { op: "L", x: 1, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "flowchartSort",
        label: "Sort",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 1, y: 0.5 },
          { op: "L", x: 0.5, y: 1 }, { op: "L", x: 0, y: 0.5 }, { op: "Z" },
          { op: "M", x: 0, y: 0.5 }, { op: "L", x: 1, y: 0.5 },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "flowchartExtract",
        label: "Extract",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 1, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "flowchartMerge",
        label: "Merge",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 0.5, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 60, defaultHeight: 60, supportsText: false,
      },
      {
        id: "flowchartStoredData",
        label: "Stored Data",
        path: [
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "C", x1: 0.85, y1: 0, x2: 0.85, y2: 1, x: 1, y: 1 },
          { op: "L", x: 0.15, y: 1 },
          { op: "C", x1: 0, y1: 1, x2: 0, y2: 0, x: 0.15, y: 0 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartDelay",
        label: "Delay",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 0.6, y: 0 },
          { op: "C", x1: 1, y1: 0, x2: 1, y2: 1, x: 0.6, y: 1 },
          { op: "L", x: 0, y: 1 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 60, supportsText: true,
      },
      {
        id: "flowchartMagneticDisk",
        label: "Magnetic Disk",
        path: [
          { op: "M", x: 0, y: 0.15 },
          { op: "C", x1: 0, y1: -0.05, x2: 1, y2: -0.05, x: 1, y: 0.15 },
          { op: "L", x: 1, y: 0.85 },
          { op: "C", x1: 1, y1: 1.05, x2: 0, y2: 1.05, x: 0, y: 0.85 },
          { op: "Z" },
          // Top ellipse
          { op: "M", x: 0, y: 0.15 },
          { op: "C", x1: 0, y1: 0.35, x2: 1, y2: 0.35, x: 1, y: 0.15 },
        ],
        defaultWidth: 100, defaultHeight: 80, supportsText: true,
      },
      {
        id: "flowchartDisplay",
        label: "Display",
        path: [
          { op: "M", x: 0.15, y: 0 }, { op: "L", x: 0.7, y: 0 },
          { op: "C", x1: 1, y1: 0, x2: 1, y2: 1, x: 0.7, y: 1 },
          { op: "L", x: 0.15, y: 1 }, { op: "L", x: 0, y: 0.5 }, { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
    ],
  },

  // ========================================================================
  // STARS AND BANNERS
  // ========================================================================
  {
    id: "starsAndBanners",
    label: "Stars and Banners",
    shapes: [
      {
        id: "star4",
        label: "4-Point Star",
        path: starShape(4, 0.3),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "star5",
        label: "5-Point Star",
        path: starShape(5, 0.38),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "star6",
        label: "6-Point Star",
        path: starShape(6, 0.35),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "star7",
        label: "7-Point Star",
        path: starShape(7, 0.35),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "star8",
        label: "8-Point Star",
        path: starShape(8, 0.35),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "star10",
        label: "10-Point Star",
        path: starShape(10, 0.38),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "star12",
        label: "12-Point Star",
        path: starShape(12, 0.38),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "star16",
        label: "16-Point Star",
        path: starShape(16, 0.4),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "star24",
        label: "24-Point Star",
        path: starShape(24, 0.42),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "star32",
        label: "32-Point Star",
        path: starShape(32, 0.43),
        defaultWidth: 80, defaultHeight: 80, supportsText: true,
      },
      {
        id: "explosion1",
        label: "Explosion 1",
        path: [
          { op: "M", x: 0.5, y: 0 }, { op: "L", x: 0.6, y: 0.3 },
          { op: "L", x: 0.85, y: 0.05 }, { op: "L", x: 0.75, y: 0.35 },
          { op: "L", x: 1, y: 0.3 }, { op: "L", x: 0.85, y: 0.55 },
          { op: "L", x: 1, y: 0.7 }, { op: "L", x: 0.75, y: 0.65 },
          { op: "L", x: 0.8, y: 0.95 }, { op: "L", x: 0.55, y: 0.75 },
          { op: "L", x: 0.4, y: 1 }, { op: "L", x: 0.4, y: 0.7 },
          { op: "L", x: 0.1, y: 0.85 }, { op: "L", x: 0.25, y: 0.6 },
          { op: "L", x: 0, y: 0.55 }, { op: "L", x: 0.2, y: 0.4 },
          { op: "L", x: 0.05, y: 0.15 }, { op: "L", x: 0.35, y: 0.3 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "explosion2",
        label: "Explosion 2",
        path: [
          { op: "M", x: 0.45, y: 0 }, { op: "L", x: 0.5, y: 0.2 },
          { op: "L", x: 0.65, y: 0.02 }, { op: "L", x: 0.63, y: 0.22 },
          { op: "L", x: 0.85, y: 0.08 }, { op: "L", x: 0.78, y: 0.3 },
          { op: "L", x: 1, y: 0.25 }, { op: "L", x: 0.88, y: 0.42 },
          { op: "L", x: 1, y: 0.55 }, { op: "L", x: 0.82, y: 0.58 },
          { op: "L", x: 0.95, y: 0.75 }, { op: "L", x: 0.72, y: 0.68 },
          { op: "L", x: 0.78, y: 0.92 }, { op: "L", x: 0.58, y: 0.78 },
          { op: "L", x: 0.5, y: 1 }, { op: "L", x: 0.42, y: 0.78 },
          { op: "L", x: 0.25, y: 0.95 }, { op: "L", x: 0.3, y: 0.7 },
          { op: "L", x: 0.08, y: 0.8 }, { op: "L", x: 0.18, y: 0.6 },
          { op: "L", x: 0, y: 0.5 }, { op: "L", x: 0.15, y: 0.42 },
          { op: "L", x: 0, y: 0.25 }, { op: "L", x: 0.2, y: 0.3 },
          { op: "L", x: 0.12, y: 0.1 }, { op: "L", x: 0.35, y: 0.22 }, { op: "Z" },
        ],
        defaultWidth: 100, defaultHeight: 100, supportsText: true,
      },
      {
        id: "horizontalScroll",
        label: "Horizontal Scroll",
        path: [
          { op: "M", x: 0.08, y: 0.08 }, { op: "L", x: 0.95, y: 0.08 },
          { op: "C", x1: 1, y1: 0.08, x2: 1, y2: 0.2, x: 0.95, y: 0.2 },
          { op: "L", x: 0.08, y: 0.2 }, { op: "L", x: 0.08, y: 0.88 },
          { op: "L", x: 0.92, y: 0.88 },
          { op: "L", x: 0.92, y: 0.2 },
          { op: "M", x: 0.92, y: 0.88 },
          { op: "C", x1: 0.97, y1: 0.88, x2: 0.97, y2: 1, x: 0.92, y: 1 },
          { op: "L", x: 0.05, y: 1 },
          { op: "C", x1: 0, y1: 1, x2: 0, y2: 0.88, x: 0.05, y: 0.88 },
          { op: "L", x: 0.08, y: 0.88 },
          { op: "M", x: 0.08, y: 0.08 },
          { op: "C", x1: 0.03, y1: 0.08, x2: 0.03, y2: 0, x: 0.08, y: 0 },
          { op: "L", x: 0.95, y: 0 },
        ],
        defaultWidth: 140, defaultHeight: 100, supportsText: true,
      },
      {
        id: "verticalScroll",
        label: "Vertical Scroll",
        path: [
          { op: "M", x: 0.08, y: 0.08 }, { op: "L", x: 0.08, y: 0.95 },
          { op: "C", x1: 0.08, y1: 1, x2: 0.2, y2: 1, x: 0.2, y: 0.95 },
          { op: "L", x: 0.2, y: 0.08 }, { op: "L", x: 0.88, y: 0.08 },
          { op: "L", x: 0.88, y: 0.92 },
          { op: "L", x: 0.2, y: 0.92 },
          { op: "M", x: 0.88, y: 0.92 },
          { op: "C", x1: 0.88, y1: 0.97, x2: 1, y2: 0.97, x: 1, y: 0.92 },
          { op: "L", x: 1, y: 0.05 },
          { op: "C", x1: 1, y1: 0, x2: 0.88, y2: 0, x: 0.88, y: 0.05 },
          { op: "L", x: 0.88, y: 0.08 },
          { op: "M", x: 0.08, y: 0.08 },
          { op: "C", x1: 0.08, y1: 0.03, x2: 0, y2: 0.03, x: 0, y: 0.08 },
          { op: "L", x: 0, y: 0.95 },
        ],
        defaultWidth: 100, defaultHeight: 140, supportsText: true,
      },
      {
        id: "wave",
        label: "Wave",
        path: [
          { op: "M", x: 0, y: 0.2 },
          { op: "C", x1: 0.2, y1: 0, x2: 0.35, y2: 0, x: 0.5, y: 0.15 },
          { op: "C", x1: 0.65, y1: 0.3, x2: 0.8, y2: 0.3, x: 1, y: 0.1 },
          { op: "L", x: 1, y: 0.8 },
          { op: "C", x1: 0.8, y1: 1, x2: 0.65, y2: 1, x: 0.5, y: 0.85 },
          { op: "C", x1: 0.35, y1: 0.7, x2: 0.2, y2: 0.7, x: 0, y: 0.9 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
      {
        id: "doubleWave",
        label: "Double Wave",
        path: [
          { op: "M", x: 0, y: 0.25 },
          { op: "C", x1: 0.12, y1: 0.1, x2: 0.25, y2: 0.1, x: 0.37, y: 0.2 },
          { op: "C", x1: 0.5, y1: 0.3, x2: 0.62, y2: 0.3, x: 0.75, y: 0.15 },
          { op: "C", x1: 0.87, y1: 0, x2: 1, y2: 0.05, x: 1, y: 0.15 },
          { op: "L", x: 1, y: 0.75 },
          { op: "C", x1: 0.88, y1: 0.9, x2: 0.75, y2: 0.9, x: 0.63, y: 0.8 },
          { op: "C", x1: 0.5, y1: 0.7, x2: 0.38, y2: 0.7, x: 0.25, y: 0.85 },
          { op: "C", x1: 0.13, y1: 1, x2: 0, y2: 0.95, x: 0, y: 0.85 },
          { op: "Z" },
        ],
        defaultWidth: 120, defaultHeight: 60, supportsText: true,
      },
    ],
  },

  // ========================================================================
  // CALLOUTS
  // ========================================================================
  {
    id: "callouts",
    label: "Callouts",
    shapes: [
      {
        id: "rectangularCallout",
        label: "Rectangular Callout",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.7 }, { op: "L", x: 0.4, y: 0.7 },
          { op: "L", x: 0.15, y: 1 }, { op: "L", x: 0.25, y: 0.7 },
          { op: "L", x: 0, y: 0.7 }, { op: "Z" },
        ],
        defaultWidth: 140, defaultHeight: 100, supportsText: true,
      },
      {
        id: "roundedRectangularCallout",
        label: "Rounded Rectangular Callout",
        path: [
          { op: "M", x: 0.1, y: 0 }, { op: "L", x: 0.9, y: 0 },
          { op: "C", x1: 0.95, y1: 0, x2: 1, y2: 0.05, x: 1, y: 0.1 },
          { op: "L", x: 1, y: 0.6 },
          { op: "C", x1: 1, y1: 0.65, x2: 0.95, y2: 0.7, x: 0.9, y: 0.7 },
          { op: "L", x: 0.4, y: 0.7 }, { op: "L", x: 0.15, y: 1 },
          { op: "L", x: 0.25, y: 0.7 }, { op: "L", x: 0.1, y: 0.7 },
          { op: "C", x1: 0.05, y1: 0.7, x2: 0, y2: 0.65, x: 0, y: 0.6 },
          { op: "L", x: 0, y: 0.1 },
          { op: "C", x1: 0, y1: 0.05, x2: 0.05, y2: 0, x: 0.1, y: 0 },
          { op: "Z" },
        ],
        defaultWidth: 140, defaultHeight: 100, supportsText: true,
      },
      {
        id: "ovalCallout",
        label: "Oval Callout",
        path: [
          { op: "M", x: 0.5, y: 0 },
          { op: "C", x1: 0.5 + 0.5 * K, y1: 0, x2: 1, y2: 0.3 - 0.3 * K, x: 1, y: 0.3 },
          { op: "C", x1: 1, y1: 0.3 + 0.3 * K, x2: 0.5 + 0.5 * K, y2: 0.6, x: 0.5, y: 0.6 },
          { op: "C", x1: 0.45, y1: 0.6, x2: 0.4, y2: 0.6, x: 0.35, y: 0.59 },
          { op: "L", x: 0.15, y: 1 },
          { op: "L", x: 0.28, y: 0.58 },
          { op: "C", x1: 0.5 - 0.5 * K, y1: 0.6, x2: 0, y2: 0.3 + 0.3 * K, x: 0, y: 0.3 },
          { op: "C", x1: 0, y1: 0.3 - 0.3 * K, x2: 0.5 - 0.5 * K, y2: 0, x: 0.5, y: 0 },
          { op: "Z" },
        ],
        defaultWidth: 140, defaultHeight: 100, supportsText: true,
      },
      {
        id: "cloudCallout",
        label: "Cloud Callout",
        path: [
          { op: "M", x: 0.25, y: 0.7 },
          { op: "C", x1: 0.05, y1: 0.7, x2: 0, y2: 0.55, x: 0.05, y: 0.45 },
          { op: "C", x1: 0.0, y1: 0.3, x2: 0.1, y2: 0.2, x: 0.2, y: 0.2 },
          { op: "C", x1: 0.2, y1: 0.05, x2: 0.35, y2: -0.05, x: 0.5, y: 0.02 },
          { op: "C", x1: 0.6, y1: -0.05, x2: 0.75, y2: 0, x: 0.8, y: 0.1 },
          { op: "C", x1: 0.9, y1: 0.05, x2: 1, y2: 0.2, x: 0.95, y: 0.35 },
          { op: "C", x1: 1, y1: 0.5, x2: 0.9, y2: 0.65, x: 0.75, y: 0.7 },
          { op: "Z" },
          // Thought bubbles
          { op: "M", x: 0.2, y: 0.78 },
          { op: "C", x1: 0.17, y1: 0.75, x2: 0.15, y2: 0.78, x: 0.18, y: 0.82 },
          { op: "C", x1: 0.21, y1: 0.86, x2: 0.23, y2: 0.83, x: 0.2, y: 0.78 },
          { op: "Z" },
          { op: "M", x: 0.12, y: 0.9 },
          { op: "C", x1: 0.1, y1: 0.87, x2: 0.08, y2: 0.9, x: 0.1, y: 0.94 },
          { op: "C", x1: 0.12, y1: 0.98, x2: 0.14, y2: 0.95, x: 0.12, y: 0.9 },
          { op: "Z" },
        ],
        defaultWidth: 160, defaultHeight: 120, supportsText: true,
      },
      {
        id: "lineCallout1",
        label: "Line Callout 1",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.7 }, { op: "L", x: 0, y: 0.7 }, { op: "Z" },
          { op: "M", x: 0.25, y: 0.7 }, { op: "L", x: 0.15, y: 1 },
        ],
        defaultWidth: 140, defaultHeight: 100, supportsText: true,
      },
      {
        id: "lineCallout2",
        label: "Line Callout 2",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.7 }, { op: "L", x: 0, y: 0.7 }, { op: "Z" },
          { op: "M", x: 0.25, y: 0.7 }, { op: "L", x: 0.2, y: 0.85 },
          { op: "L", x: 0.1, y: 1 },
        ],
        defaultWidth: 140, defaultHeight: 100, supportsText: true,
      },
      {
        id: "lineCallout3",
        label: "Line Callout 3",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.7 }, { op: "L", x: 0, y: 0.7 }, { op: "Z" },
          { op: "M", x: 0.25, y: 0.7 }, { op: "L", x: 0.3, y: 0.85 },
          { op: "L", x: 0.1, y: 1 },
        ],
        defaultWidth: 140, defaultHeight: 100, supportsText: true,
      },
      {
        id: "lineCalloutAccentBar1",
        label: "Line Callout with Accent Bar 1",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.7 }, { op: "L", x: 0, y: 0.7 }, { op: "Z" },
          { op: "M", x: 0.2, y: 0.7 }, { op: "L", x: 0.2, y: 0.75 },
          { op: "M", x: 0.25, y: 0.7 }, { op: "L", x: 0.15, y: 1 },
        ],
        defaultWidth: 140, defaultHeight: 100, supportsText: true,
      },
      {
        id: "lineCalloutAccentBar2",
        label: "Line Callout with Accent Bar 2",
        path: [
          { op: "M", x: 0, y: 0 }, { op: "L", x: 1, y: 0 },
          { op: "L", x: 1, y: 0.7 }, { op: "L", x: 0, y: 0.7 }, { op: "Z" },
          { op: "M", x: 0.2, y: 0.7 }, { op: "L", x: 0.2, y: 0.75 },
          { op: "M", x: 0.25, y: 0.7 }, { op: "L", x: 0.2, y: 0.85 },
          { op: "L", x: 0.1, y: 1 },
        ],
        defaultWidth: 140, defaultHeight: 100, supportsText: true,
      },
    ],
  },
];

// ============================================================================
// Lookup Helpers
// ============================================================================

const shapeMap = new Map<string, ShapeDefinition>();
for (const cat of SHAPE_CATEGORIES) {
  for (const shape of cat.shapes) {
    shapeMap.set(shape.id, shape);
  }
}

/** Look up a shape definition by its unique ID. */
export function getShapeDefinition(shapeType: string): ShapeDefinition | null {
  return shapeMap.get(shapeType) ?? null;
}

/** Get all shape categories (for building the insert menu). */
export function getShapeCategories(): ShapeCategory[] {
  return SHAPE_CATEGORIES;
}
