// FILENAME: app/extensions/ModelEditor/components/navIcons.tsx
// PURPOSE: One 16px icon per rail item, so the navigation can be read by shape
//          before it is read by word.
// CONTEXT: The target IA called for "a 16px icon" on every rail row and the row
//          shipped without one, so the rail was twenty lines of text in six
//          groups — findable by reading, not by glancing. That is the
//          difference the icons make: after a week you stop reading "Measures"
//          and start aiming at the sigma.
//
//          THE SET IS DRAWN, NOT BORROWED. `@api`'s RibbonIcon is the
//          spreadsheet's vocabulary — Cut, Paste, AlignLeft, MergeCells — and
//          has nothing to say about a semantic model. What it does have is a
//          house style, and `treeKit`'s FolderIcon and CalcGroupIcon are the
//          same style at the same size in this very window, so these match
//          those: a 16 grid, stroke-only, `currentColor`, 1.3 width, round
//          joins, no fills and no second colour.
//
//          WHY STROKE-ONLY AND currentColor. The rail row sets the colour —
//          muted at rest, full strength when active — and an icon that carried
//          its own would need a second rule for every state and a third for the
//          dark skin. Inheriting means the icon is correct in states nobody
//          thought about, and it keeps the whole set outside the hex ban by
//          construction rather than by exemption.
//
//          DRAWN FOR 16px, WHICH IS A CONSTRAINT NOT A SIZE. Every shape here
//          is three or four strokes: at this size a fifth is a smudge. Where a
//          concept had an obvious detailed picture and an obvious simple one,
//          the simple one won — a "hierarchy" is three boxes and two lines, not
//          an org chart.

import React from "react";
import type { SectionId } from "./editorShared";

export interface NavIconProps {
  size?: number;
}

/** The shared frame. `strokeWidth` 1.3 and round joins are treeKit's, so an
 *  icon here and a folder there read as one family. */
function Svg({ size = 16, children }: { size?: number; children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0, display: "block" }}
    >
      {children}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

/** Overview — an ASYMMETRIC dashboard: one wide pane and two narrow ones.
 *
 *  Not four equal squares, which is what it was: calculation groups are four
 *  equal squares too (matching treeKit's CalcGroupIcon, where that shape means
 *  "a group of items"), and at 16px the two were the same picture. Two icons
 *  that differ only by a detail nobody can resolve are one icon used twice. */
export const OverviewIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <rect x="2" y="2" width="12" height="5" rx="1.2" />
    <rect x="2" y="9" width="5" height="5" rx="1.2" />
    <rect x="9" y="9" width="5" height="5" rx="1.2" />
  </Svg>
);

/** Connections — two plugs meeting. A link, not a database: what this section
 *  lists is the connection, and the database is on the far end of it. */
export const ConnectionsIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M6.5 9.5 4.8 11.2a2.4 2.4 0 0 1-3.4-3.4L3.1 6.1" />
    <path d="M9.5 6.5l1.7-1.7a2.4 2.4 0 0 1 3.4 3.4l-1.7 1.7" />
    <path d="M6.2 9.8 9.8 6.2" />
  </Svg>
);

/** Import — into the box, not out of it. The arrowhead points at the tray. */
export const ImportIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M8 2v6.5" />
    <path d="M5.4 6.2 8 8.8l2.6-2.6" />
    <path d="M2.5 10.5v2A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </Svg>
);

/** Settings — sliders rather than a gear. A gear says "machinery"; this
 *  section is a handful of values you set. */
export const SettingsIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    <circle cx="5.5" cy="4.5" r="1.6" />
    <circle cx="10" cy="8" r="1.6" />
    <circle cx="6.5" cy="11.5" r="1.6" />
  </Svg>
);

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** Tables — a header row and a body, which is what distinguishes a table from
 *  a grid. */
export const TablesIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M2 6h12" />
    <path d="M6.5 6v7.5" />
  </Svg>
);

/** Relationships — two TABLES and the join between them.
 *
 *  The header line on each box is what makes them tables rather than two
 *  rounded blobs, which is how the first version read: the eye needs one
 *  interior detail to tell a table from a pill at this size. Static shapes
 *  joined by a plain line, where Lineage is round nodes with direction — the
 *  two sections differ by exactly that, and so do their icons. */
export const RelationshipsIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <rect x="1.3" y="4.5" width="4.6" height="7" rx="1" />
    <path d="M1.3 6.6h4.6" />
    <rect x="10.1" y="4.5" width="4.6" height="7" rx="1" />
    <path d="M10.1 6.6h4.6" />
    <path d="M5.9 8h4.2" />
  </Svg>
);

/** Hierarchies — a parent and two children, drawn as a bracket rather than as
 *  three separate connectors. One continuous stroke down, across and down again
 *  is legible at 16px where three short segments meeting at corners is a
 *  smudge. */
export const HierarchiesIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <rect x="5.9" y="1.6" width="4.2" height="3.4" rx="1" />
    <rect x="1.4" y="11" width="4.2" height="3.4" rx="1" />
    <rect x="10.4" y="11" width="4.2" height="3.4" rx="1" />
    <path d="M8 5v3.2" />
    <path d="M3.5 11V8.2h9V11" />
  </Svg>
);

/** Lineage — flow with a branch. Directional, where Relationships is not:
 *  that is the whole difference between the two sections. */
export const LineageIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <circle cx="3" cy="8" r="1.6" />
    <circle cx="13" cy="4" r="1.6" />
    <circle cx="13" cy="12" r="1.6" />
    <path d="M4.5 7.2 11.4 4.6" />
    <path d="M4.5 8.8 11.4 11.4" />
  </Svg>
);

// ---------------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------------

/** Measures — a sigma. The one glyph every BI author already reads as
 *  "aggregate", and the reason this icon is a letter where the rest are not. */
export const MeasuresIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M11.5 3H4.5l4 5-4 5h7" />
  </Svg>
);

/** Calculation groups — a group of items, matching treeKit's CalcGroupIcon so
 *  the rail and the section's own tree agree about what a calc group looks
 *  like. */
export const CalcGroupsIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <rect x="2" y="2" width="5" height="5" rx="1.2" />
    <rect x="9" y="2" width="5" height="5" rx="1.2" />
    <rect x="2" y="9" width="5" height="5" rx="1.2" />
    <rect x="9" y="9" width="5" height="5" rx="1.2" />
    <path d="M4.5 4.5h0M11.5 4.5h0M4.5 11.5h0M11.5 11.5h0" />
  </Svg>
);

/** Script functions — angle brackets. Code, in one stroke each. */
export const ScriptFunctionsIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M5.5 4.5 2 8l3.5 3.5" />
    <path d="M10.5 4.5 14 8l-3.5 3.5" />
  </Svg>
);

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

/** Calculated tables — a table whose contents are computed. The spark is the
 *  "calculated"; the frame keeps it in the Tables family. */
export const CalculatedTablesIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M2 6h12" />
    <path d="M8.6 7.8 6.6 10.4h2.3l-1.5 2.2" />
  </Svg>
);

/** Table variables — a bracketed value. Brackets read as "a named thing
 *  standing for another", which is what a variable is. */
export const TableVariablesIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M5.5 2.5h-2A1.5 1.5 0 0 0 2 4v8a1.5 1.5 0 0 0 1.5 1.5h2" />
    <path d="M10.5 2.5h2A1.5 1.5 0 0 1 14 4v8a1.5 1.5 0 0 1-1.5 1.5h-2" />
    <path d="M6.5 6.2 9.5 9.8M9.5 6.2 6.5 9.8" />
  </Svg>
);

/** Contexts — a crop frame: the EXTENT a calculation is allowed to see.
 *
 *  Not a magnifying glass, which is what it was — the top bar's search field
 *  and its Ctrl+K palette already own that shape in this window, and a rail
 *  item that looks like the search control is a rail item people click by
 *  mistake. Not a funnel either: a funnel is the ribbon's word for a slicer,
 *  and a context is not one. Corner marks say "this much and no more", which
 *  is precisely what a context does. */
export const ContextsIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M2 5.5V3.4A1.4 1.4 0 0 1 3.4 2h2.1" />
    <path d="M10.5 2h2.1A1.4 1.4 0 0 1 14 3.4v2.1" />
    <path d="M14 10.5v2.1a1.4 1.4 0 0 1-1.4 1.4h-2.1" />
    <path d="M5.5 14H3.4A1.4 1.4 0 0 1 2 12.6v-2.1" />
    <path d="M6 8h4" />
  </Svg>
);

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

/** Security roles — a shield. */
export const RolesIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M8 1.8 13 3.6v4.2c0 3-2.1 5.4-5 6.4-2.9-1-5-3.4-5-6.4V3.6z" />
  </Svg>
);

/** Perspectives — an eye. What a given audience is allowed to see. */
export const PerspectivesIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M1.5 8S3.9 3.8 8 3.8 14.5 8 14.5 8 12.1 12.2 8 12.2 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="1.8" />
  </Svg>
);

/** Translations — a globe, meridian and equator. */
export const TranslationsIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12" />
    <path d="M8 2c1.9 2 2.9 4 2.9 6s-1 4-2.9 6c-1.9-2-2.9-4-2.9-6s1-4 2.9-6z" />
  </Svg>
);

// ---------------------------------------------------------------------------
// Meaning
// ---------------------------------------------------------------------------

/** KPIs — a target with a hit. A KPI is a measure judged against a goal, and
 *  the rings are the goal. */
export const KpisIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="2.6" />
    <circle cx="8" cy="8" r="0.4" />
  </Svg>
);

/** Strategy — a compass. Direction, which is literally the first thing the
 *  Strategy tab asks you for about every measure. */
export const StrategyIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <circle cx="8" cy="8" r="6" />
    <path d="M10.6 5.4 9.2 9.2 5.4 10.6 6.8 6.8z" />
  </Svg>
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Testing ground — a flask. Somewhere to try something without consequences,
 *  which is exactly what the section is for. */
export const TestingIcon = ({ size }: NavIconProps): React.ReactElement => (
  <Svg size={size}>
    <path d="M6.5 2v4.2L2.9 12a1.4 1.4 0 0 0 1.2 2.1h7.8a1.4 1.4 0 0 0 1.2-2.1L9.5 6.2V2" />
    <path d="M5.6 2h4.8" />
    <path d="M4.7 9.8h6.6" />
  </Svg>
);

/**
 * Rail id -> icon, keyed by `SectionId` itself.
 *
 * `Record<SectionId, …>` and not `Record<string, …>`: the point is that adding
 * a section without an icon FAILS TO COMPILE, rather than rendering a row with
 * a blank where every neighbour has a picture. The first version of this said
 * exactly that in its comment and was typed `Record<string, …>`, which enforces
 * nothing at all — the same complete-looking-but-incomplete claim this codebase
 * has been caught by before, written into the very line that was supposed to
 * prevent it.
 */
export const NAV_ICONS: Record<SectionId, React.ComponentType<NavIconProps>> = {
  overview: OverviewIcon,
  connections: ConnectionsIcon,
  import: ImportIcon,
  settings: SettingsIcon,
  tables: TablesIcon,
  relationships: RelationshipsIcon,
  hierarchies: HierarchiesIcon,
  lineage: LineageIcon,
  measures: MeasuresIcon,
  calcGroups: CalcGroupsIcon,
  scriptFunctions: ScriptFunctionsIcon,
  globals: CalculatedTablesIcon,
  tableVariables: TableVariablesIcon,
  contexts: ContextsIcon,
  roles: RolesIcon,
  perspectives: PerspectivesIcon,
  translations: TranslationsIcon,
  kpis: KpisIcon,
  strategy: StrategyIcon,
  testing: TestingIcon,
};
