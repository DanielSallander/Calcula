//! FILENAME: app/src/api/__tests__/cascadeAnnouncementCensus.test.ts
// PURPOSE: An EIGHTH census, and the frontend half of the seventh.
//
//          §3bt made the backend cascade correct: deleting a table deletes the
//          slicers bound to it, deleting a pivot prunes it out of every ribbon
//          filter, deleting a chart clears the pane control that drove it. That
//          matrix lives as DATA in `app/src-tauri/src/object_deps.rs` and
//          `object_deps_census_tests.rs` fails the build if a new delete
//          command appears without declaring what happens to its dependents.
//
//          NONE OF THAT REACHES THE SCREEN BY ITSELF. Every one of those
//          dependents lives in an extension store that caches its own objects
//          and paints its own overlay. A slicer the backend deleted goes on
//          rendering — and on CLAIMING POINTER EVENTS over the cells underneath
//          — until its store re-reads. That is the wedge that took
//          `state-consistency` to a 120 s click-retry timeout on seed
//          1786421716252; the object was already gone from the backend.
//
//          So the Rust census proves the cascade RAN, and this one proves the
//          frontend was TOLD. It reads the Rust matrix — the same file, not a
//          transcription — works out which owners cascade into a store the
//          frontend caches, and requires every frontend route that deletes such
//          an owner to reach an announcement naming those domains.
//
// WHY IT FOUND SOMETHING. `api.deleteTable` in the script broker announced the
//          "objects" domain, which fans out to charts, sparklines, the
//          table-definitions event, animation, grid and protection — and NOT to
//          slicers or ribbon filters. The Table extension's own
//          `deleteTableAsync` had announced the cascade since §3bt; the broker
//          calls `backend.deleteTable` directly (the tier checks and the
//          active-sheet assertion live in the host), so a script deleting a
//          table left exactly the §3bn wedge behind. Same for
//          `table.convertToRange`. Both fixed; this census is what stops the
//          third one.
//
// DOMAINS, NEVER FEATURE EVENTS. The routes announce `MUTATION_REFRESH` with a
//          list of DOMAINS and the Shell translator owns the mapping to
//          per-feature events (bootstrap.ts). An extension naming another
//          extension's event would be the seam violation the domains exist to
//          prevent, so this census reads domains too.
//
// TEETH. `the_census_finds_a_route_that_forgets` runs the same analyser over a
//          synthetic route that announces only "objects" and requires it to be
//          reported, naming the domain it missed. Without that, a rule that
//          silently matched nothing would pass forever.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const repoRoot = path.resolve(__dirname, "../../../..");
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");

// ===========================================================================
// 1. The Rust matrix, parsed — not transcribed
// ===========================================================================

interface RustRow {
  owner: string;
  dependent: string;
  dependentKind: string | null;
  policy: string;
}

function rustSource(): string {
  return read("app/src-tauri/src/object_deps.rs");
}

function rustMatrix(): RustRow[] {
  const src = rustSource();
  const start = src.indexOf("pub const DEPENDENCY_MATRIX");
  expect(start, "DEPENDENCY_MATRIX has moved or been renamed").toBeGreaterThan(-1);
  const body = src.slice(start);
  const rows: RustRow[] = [];
  const re =
    /owner: ObjectKind::(\w+),\s*\n?\s*(?:\/\/[^\n]*\n\s*)*dependent: "((?:[^"\\]|\\[\s\S])*)",\s*\n?\s*dependent_kind: (None|Some\(ObjectKind::(\w+)\)),\s*\n?\s*policy: DeletePolicy::(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    rows.push({
      owner: m[1],
      dependent: m[2].replace(/\\\s+/g, ""),
      dependentKind: m[3] === "None" ? null : m[4],
      policy: m[5],
    });
  }
  return rows;
}

/**
 * `ObjectKind::ui_domain` — parsed out of the Rust `match`, not restated here.
 *
 * THIS USED TO BE A LIST OF REGEXES IN THIS FILE, matching the dependent's
 * free TEXT ("^slicer\." -> "slicer"), with a second list of prose excuses for
 * the rest. Two problems, both of which the parse removes. A new object kind
 * could be added to the Rust matrix and match neither list, and the census's
 * answer to that was a hand-written excuse — a checklist entry, exactly what a
 * census exists to replace. And the mapping was a SECOND source of truth for
 * something the backend also has to know, now that a backend-initiated
 * cascade announces its own domains (§3cd): two copies that drift is how the
 * timeline slicers came to be mapped to the "slicer" domain here while the
 * Shell translator reached only the canvas slicers.
 *
 * The Rust side is an exhaustive `match`, so the COMPILER now forces an answer
 * for every object kind and this file just reads it.
 */
function uiDomains(): Map<string, string | null> {
  const src = rustSource();
  const at = src.indexOf("pub fn ui_domain(self) -> UiDomain {");
  expect(at, "ObjectKind::ui_domain has moved or been renamed").toBeGreaterThan(-1);
  const body = braceBody(src, src.indexOf("{", at));
  const out = new Map<string, string | null>();
  // `A | B | C => UiDomain::X,` — arms wrap over several lines.
  const armRe = /((?:\s*ObjectKind::\w+\s*\|?)+)=>\s*UiDomain::(\w+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = armRe.exec(body)) !== null) {
    const domain = m[2] === "None" ? null : m[2][0].toLowerCase() + m[2].slice(1);
    for (const kind of m[1].matchAll(/ObjectKind::(\w+)/g)) {
      out.set(kind[1], domain);
    }
  }
  return out;
}

/** The policies that CHANGE another object; the rest run no code. */
const CASCADING_POLICIES = new Set(["Cascade", "CascadeOrRebind", "Prune"]);
/** The policies that REMOVE the dependent, so its own dependents cascade too. */
const DELETING_POLICIES = new Set(["Cascade", "CascadeOrRebind"]);

/**
 * Every domain that deleting `owner` leaves stale — TRANSITIVELY, and without
 * the owner's own.
 *
 * The transitive step is the whole reason `dependent_kind` exists in the Rust
 * matrix. Deleting a table deletes its slicers, and deleting a slicer prunes it
 * out of every ribbon filter that cross-filters it, so a table delete owes the
 * ribbon-filter store. Before this walk, the census asked only for the domains
 * of the owner's DIRECT dependents — `deleteTableAsync` announced "ribbonFilter"
 * anyway, and nothing would have noticed if it stopped.
 *
 * The owner's OWN domain is excluded: the frontend route that deletes an object
 * is, by construction, the one that knows about it, and it updates its own
 * store on the spot. The BACKEND announcer includes it, because there a
 * mutation has nobody to return to (`cascade_domains` in object_deps.rs, and
 * `cascade_domains_are_derived_transitively_from_the_matrix` pins both halves).
 */
function requiredDomainsFor(owner: string, rows: RustRow[], domains: Map<string, string | null>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue = [owner];
  while (queue.length > 0) {
    const kind = queue.pop()!;
    if (seen.has(kind)) continue;
    seen.add(kind);
    for (const row of rows) {
      if (row.owner !== kind) continue;
      if (!CASCADING_POLICIES.has(row.policy)) continue;
      if (!row.dependentKind) continue;
      const domain = domains.get(row.dependentKind);
      if (domain) out.add(domain);
      if (DELETING_POLICIES.has(row.policy)) queue.push(row.dependentKind);
    }
  }
  const own = domains.get(owner);
  if (own) out.delete(own);
  return out;
}

// ===========================================================================
// 2. The frontend delete routes
// ===========================================================================

interface Route {
  /** Repo-relative file. */
  file: string;
  /** A free function name, or `case "<label>"` for a broker switch arm. */
  symbol: string;
  /**
   * The domain this route's OWN store covers. A route that re-reads its own
   * cache from the backend needs no announcement for it — `deleteFilterAsync`
   * calls `refreshCache()`, which is what re-pulls the siblings the backend
   * just pruned.
   */
  ownDomain?: string;
  why: string;
}

const DELETE_ROUTES: Record<string, Route[]> = {
  Table: [
    {
      file: "app/extensions/Table/lib/tableStore.ts",
      symbol: "deleteTableAsync",
      why: "The Table Design tab's Delete button.",
    },
    {
      file: "app/extensions/Table/lib/tableStore.ts",
      symbol: "convertToRangeAsync",
      why: "Convert to Range dissolves the table and carries the identical cascade.",
    },
    {
      file: "app/src/api/scriptHost/host.ts",
      symbol: 'case "api.deleteTable"',
      why: "A script deleting a table. Calls backend.deleteTable directly.",
    },
    {
      file: "app/src/api/scriptHost/host.ts",
      symbol: "executeTableStructureAspect",
      why: "The object-script aspect family, which includes table.convertToRange.",
    },
  ],
  Pivot: [
    {
      file: "app/extensions/Pivot/lib/pivot-api.ts",
      symbol: "deletePivotTable",
      ownDomain: "pivot",
      why: "Every pivot delete, including the broker's api.deletePivot, ends here.",
    },
  ],
  Chart: [
    {
      file: "app/extensions/Charts/lib/chartStore.ts",
      symbol: "deleteChart",
      ownDomain: "objects",
      why: "Every chart delete, including the broker's api.deleteChart, ends here.",
    },
  ],
  Slicer: [
    {
      file: "app/extensions/Slicer/lib/slicerStore.ts",
      symbol: "deleteSlicerAsync",
      ownDomain: "slicer",
      why: "The slicer's own delete, which prunes it out of every ribbon filter.",
    },
  ],
  Sheet: [
    {
      file: "app/src/core/lib/tauri-api.ts",
      symbol: "deleteSheet",
      ownDomain: "objects",
      why: "The widest deletion in the workbook; the broker's api.deleteSheet routes here.",
    },
  ],
  RibbonFilter: [
    {
      file: "app/extensions/ControlsPane/lib/filterPaneStore.ts",
      symbol: "deleteFilterAsync",
      ownDomain: "ribbonFilter",
      why: "Deleting one filter prunes the cross-filter targets of its siblings.",
    },
  ],
};

/**
 * Owners with a cascading row that the frontend cannot delete at all, each with
 * the reason. Keeps `every cascading owner has a route` honest.
 */
const NO_FRONTEND_DELETE_ROUTE: Record<string, string> = {
  TimelineSlicer:
    "Its only cascading row is objectScript.instanceId, which is excused above; " +
    "TimelineSlicerState is not even persisted (§3bt residual).",
  FloatingControl:
    "Its only cascading row is objectScript.instanceId (excused); the control " +
    "itself is grid-anchored and repainted from the backend on CONTROLS_CHANGED.",
  NamedRange: "Cascading row is objectScript.instanceId (excused).",
  Script: "Cascading rows are scheduler jobs and capability grants (both excused).",
  ComputedProperty: "Cascading row is backend dependency edges (excused).",
};

// ===========================================================================
// 3. The analyser
// ===========================================================================

/** Brace-matched body of a free function, or of a `case "x":` arm. */
export function routeBody(src: string, symbol: string): string {
  if (symbol.startsWith("case ")) {
    const at = src.indexOf(`${symbol}: {`);
    if (at < 0) return "";
    return braceBody(src, src.indexOf("{", at));
  }
  const re = new RegExp(`function\\s+${symbol}\\s*[(<]`);
  const m = re.exec(src);
  if (!m) return "";
  const open = src.indexOf("{", m.index + m[0].length);
  if (open < 0) return "";
  return braceBody(src, open);
}

function braceBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/**
 * The domains a route's body reaches, following ONE level of delegation into a
 * helper in the same file — the same depth the Rust census uses, and for the
 * same reason: without the hop `announceObjectCascade()` reads as nothing, and
 * with two hops the closure becomes the whole module and stops discriminating.
 */
export function domainsAnnounced(src: string, symbol: string): Set<string> {
  // COMMENTS ARE STRIPPED FIRST. Every one of these routes explains its
  // cascade in prose above the call, and several quote the domain list while
  // doing it — a census that read the comment would accept a route that
  // announces nothing and describes everything. The six existing censuses read
  // comment-stripped source for exactly this reason.
  const body = stripComments(routeBody(src, symbol));
  const seen = new Set<string>();
  const collect = (text: string): void => {
    const re = /domains:\s*\[([^\]]*)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^["']|["']$/g, "");
        if (name) seen.add(name);
      }
    }
  };
  collect(body);
  // ...and TRANSITIVELY, but ONLY through announcement helpers.
  //
  // The original rule followed exactly one hop, on the reasoning that two hops
  // make the closure the whole module and stop discriminating. That reasoning
  // holds for arbitrary callees and not for these: the frontier is restricted
  // to functions whose NAME says they announce, so the closure is "the
  // announcement helpers this route reaches" however many of them are chained,
  // and a route that calls anything else still gets no credit for it.
  //
  // One hop was not enough in practice. `announceObjectCascade` in
  // `scriptHost/host.ts` delegates its own-domain half to
  // `announceObjectsChanged`, so a broker route reaching "objects" through the
  // pair looked as though it announced nothing of the kind — a FALSE report,
  // which is the one thing a census must never produce (it teaches the next
  // reader to disbelieve it).
  const visited = new Set<string>([symbol]);
  const frontier = [body];
  while (frontier.length > 0) {
    const text = frontier.pop()!;
    for (const callee of text.matchAll(/\b(announce\w*|\w*Cascade\w*)\s*\(/g)) {
      const name = callee[1];
      if (visited.has(name)) continue;
      visited.add(name);
      const helper = routeBody(src, name);
      if (!helper) continue;
      const stripped = stripComments(helper);
      collect(stripped);
      frontier.push(stripped);
    }
  }
  return seen;
}

/** Line and block comments out; string literals are left alone. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

/** Does the route re-read its OWN store from the backend? */
function refreshesOwnCache(src: string, symbol: string): boolean {
  const body = routeBody(src, symbol);
  return /refreshCache\s*\(|refreshGridData\s*\(|refreshCacheFor\w*\s*\(/.test(body);
}

interface Gap {
  owner: string;
  file: string;
  symbol: string;
  missing: string[];
}

function auditRoutes(
  requiredByOwner: Map<string, Set<string>>,
  routes: Record<string, Route[]>,
  readFile: (rel: string) => string,
): Gap[] {
  const gaps: Gap[] = [];
  for (const [owner, required] of requiredByOwner) {
    for (const route of routes[owner] ?? []) {
      const src = readFile(route.file);
      const announced = domainsAnnounced(src, route.symbol);
      const missing = [...required].filter((d) => {
        if (announced.has(d)) return false;
        if (route.ownDomain === d && refreshesOwnCache(src, route.symbol)) return false;
        return true;
      });
      if (missing.length > 0) {
        gaps.push({ owner, file: route.file, symbol: route.symbol, missing: missing.sort() });
      }
    }
  }
  return gaps;
}

// ===========================================================================
// 3b. THE SELECTION HALF — the invariant BUG-0026 actually broke (§3cd)
// ===========================================================================
//
// Refreshing the STORE is not the same as reconciling the UI, and BUG-0026 is
// the difference. `table.create -> slicer.create -> table.delete`: the backend
// cascade deleted the slicer correctly (§3bt), the announcement reached the
// Slicer extension correctly (§3bn), the store re-read correctly — and the
// contextual Slicer ribbon tab stayed on screen on a workbook with ZERO
// slicers, because the tab is a function of the SELECTION and the selection is
// a set of ids that nothing compared against the store.
//
// The same shape had already been found once, by the soak walk, on the Table
// Design tab (`syncDesignTabToTables`), and fixed there alone. Slicers,
// timeline slicers and pivots each carried it untouched.
//
// THE RULE, and why it is mechanical. An object kind that (a) some owner
// CASCADE-DELETES in the Rust matrix and (b) drives a contextual ribbon tab —
// which is exactly `addTaskPaneContextKey("<key>")` in its extension — must
// have a reconciliation: a function reachable from the extension's refresh path
// that drops the vanished object out of the selection. The (a) half is read
// from the Rust matrix and the (b) half is found by SCANNING the extension
// tree, so a new contextual tab on a cascade-deleted object fails this census
// without anybody remembering to add a row.

interface SelectionOwner {
  /** The `addTaskPaneContextKey` key this extension registers. */
  contextKey: string;
  /** The ObjectKind whose disappearance must reconcile it. */
  kind: string;
  /** File holding the reconciliation. */
  file: string;
  /** The function that drops a vanished object out of the selection. */
  reconcile: string;
  /** File + symbol whose body must REACH the reconciliation. */
  trigger: { file: string; symbol: string };
  /**
   * The tab LABEL the soak/invariant walk knows this tab by.
   *
   * `contextual-ribbon-tabs` (app/e2e/invariants/invariants.ts) SKIPS a
   * contextual tab whose label it does not recognise -- deliberately, so a new
   * feature cannot flood a fuzzer with false positives. The cost is that a
   * sixth contextual tab would be invisible to the walk that found BUG-0026 in
   * the first place. Naming the label here and checking it exists is the cheap
   * half of the alignment: the census is the guard, and this makes sure the
   * walk gets taught too.
   */
  walkTabLabel: string;
  /**
   * The refresh DOMAIN whose fan-out reaches `reconcile`, or `null` when the
   * delete path reaches it without an announcement.
   *
   * WHY THIS FIELD EXISTS (BUG-0051). The cascade half of this census asks only
   * which OTHER stores a delete disturbs: `requiredDomainsFor` deliberately
   * removes the owner's OWN domain, on the reasoning that a route which
   * re-reads its own cache needs no announcement for itself. That reasoning
   * covers the cache and nothing else -- and the contextual tab is not the
   * cache. `deleteTableAsync` refreshed its own cache to empty and announced
   * only ["slicer", "ribbonFilter"], so TABLE_DEFINITIONS_UPDATED never fired,
   * `syncDesignTabToTables` never ran, and the "Table Design" tab survived a
   * workbook with zero tables -- the exact end state BUG-0026 and this census's
   * selection half exist to prevent, reached through the door the own-domain
   * excuse left open. The two halves of one census contradicted each other: the
   * cascade half excused `objects`, the selection half's own `why` depended on
   * it being announced.
   *
   * So a reconciliation driven by an announcement now says so, and every delete
   * route for that kind must make it -- own domain or not.
   */
  reconcileDomain: string | null;
  /**
   * Required when `reconcileDomain` is null: how the disappearance reaches the
   * reconciliation instead. A null with no reason is the shape that let this
   * defect through, so the type does not permit one.
   */
  reconcileDomainWhy: string;
  why: string;
}

const SELECTION_OWNERS: SelectionOwner[] = [
  {
    contextKey: "slicer",
    walkTabLabel: "Slicer",
    kind: "Slicer",
    file: "app/extensions/Slicer/handlers/selectionHandler.ts",
    reconcile: "dropSlicerFromSelection",
    trigger: { file: "app/extensions/Slicer/lib/slicerStore.ts", symbol: "refreshCache" },
    reconcileDomain: null,
    reconcileDomainWhy:
      "`deleteSlicerAsync` calls the store's OWN `refreshCache`, which diffs the " +
      "id set and dispatches SLICER_DELETED for whatever vanished. No " +
      "announcement is in the path, so no domain can be missing from one.",
    why:
      "BUG-0026 itself. The store's refresh diffs the id set and dispatches " +
      "SLICER_DELETED for whatever vanished; the extension's handler calls the " +
      "reconciliation.",
  },
  {
    contextKey: "timeline-slicer",
    walkTabLabel: "Timeline",
    kind: "TimelineSlicer",
    file: "app/extensions/TimelineSlicer/handlers/selectionHandler.ts",
    reconcile: "dropTimelineFromSelection",
    trigger: {
      file: "app/extensions/TimelineSlicer/lib/timelineSlicerStore.ts",
      symbol: "refreshCache",
    },
    reconcileDomain: null,
    reconcileDomainWhy:
      "There is no frontend delete route at all (NO_FRONTEND_DELETE_ROUTE), so " +
      "there is no route that could owe an announcement. It dies with its pivot " +
      "or its sheet, and both of those announce.",
    why: "The identical defect: a timeline dies with its last pivot, and with its sheet.",
  },
  {
    contextKey: "table",
    walkTabLabel: "Table Design",
    kind: "Table",
    file: "app/extensions/Table/handlers/selectionHandler.ts",
    reconcile: "syncDesignTabToTables",
    trigger: { file: "app/extensions/Table/index.ts", symbol: "activate" },
    reconcileDomain: "objects",
    reconcileDomainWhy: "",
    why:
      "Found first, by the soak walk (seed 20260810). The tab is re-derived from " +
      "the CURRENT table list on TABLE_DEFINITIONS_UPDATED, which the `objects` " +
      "domain dispatches -- and which, until BUG-0051, no table delete announced.",
  },
  {
    contextKey: "pivot",
    walkTabLabel: "Pivot Table",
    kind: "Pivot",
    file: "app/extensions/Pivot/handlers/selectionHandler.ts",
    reconcile: "updateCachedRegions",
    trigger: { file: "app/extensions/Pivot/handlers/selectionHandler.ts", symbol: "updateCachedRegions" },
    reconcileDomain: null,
    reconcileDomainWhy:
      "The regions ARE the store: `updateCachedRegions` is both the trigger and " +
      "the reconciliation, so it cannot be reached without reconciling.",
    why:
      "Reconciles in place: the regions ARE the store, so the function that " +
      "receives them is the one that checks whether the active pivot survived. " +
      "It used to fire only when the sheet had no pivots left at all.",
  },
  {
    contextKey: "chart",
    walkTabLabel: "Chart Design",
    kind: "Chart",
    file: "app/extensions/Charts/handlers/selectionHandler.ts",
    reconcile: "deselectChart",
    trigger: { file: "app/extensions/Charts/index.ts", symbol: "activate" },
    reconcileDomain: null,
    reconcileDomainWhy:
      "`performChartDelete` -- THE one chart delete, which the context menu, the " +
      "Delete key and the script broker all route through -- calls " +
      "`deselectChart()` itself before removing the chart. The charts:refresh " +
      "path below is a second, independent belt.",
    why:
      "Charts reconcile with the blunt instrument: `reloadCharts` (the " +
      "charts:refresh handler, and the file-open path) deselects unconditionally " +
      "before re-reading, so no chart id can outlive its object.",
  },
];

/**
 * Contextual context keys that are NOT a cascade-deleted workbook object, with
 * the reason. Keeps the scan below honest without turning it into a checklist.
 */
const CONTEXT_KEYS_NOT_WORKBOOK_OBJECTS: Record<string, string> = {
  collection: "A preview of a template collection; nothing in the workbook holds it.",
  connections: "The BI connection dialog's own pane key. A connection is WarnAndKeep — never deleted out from under anything.",
  "file-viewer": "The virtual-filesystem viewer. Not a grid object and not in the dependency matrix.",
};

/** Every `addTaskPaneContextKey("x")` in the extension tree. */
function contextKeysInExtensions(): Map<string, string[]> {
  const root = path.join(repoRoot, "app", "extensions");
  const found = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const text = stripComments(fs.readFileSync(full, "utf8"));
      for (const m of text.matchAll(/addTaskPaneContextKey\(\s*["']([^"']+)["']/g)) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
        found.set(m[1], [...(found.get(m[1]) ?? []), rel]);
      }
    }
  };
  walk(root);
  return found;
}

/**
 * Which selection owners declare an announcement-driven reconciliation that
 * some delete route fails to announce (BUG-0051).
 *
 * This is the check `auditRoutes` structurally cannot make: it works from
 * `requiredDomainsFor`, which DELETES the owner's own domain from the required
 * set. `objects` is the Table's own domain, so no amount of cascade analysis
 * would ever ask a table delete to announce it -- and announcing it is the only
 * thing that takes the contextual tab down.
 */
export function unannouncedReconciliations(
  owners: SelectionOwner[],
  routes: Record<string, Route[]>,
  readFile: (rel: string) => string,
): string[] {
  const out: string[] = [];
  for (const owner of owners) {
    if (owner.reconcileDomain === null) {
      if (owner.reconcileDomainWhy.trim().length === 0) {
        out.push(
          `${owner.contextKey}: reconcileDomain is null with no reason — say how the ` +
            `disappearance reaches ${owner.reconcile} instead`,
        );
      }
      continue;
    }
    const declared = routes[owner.kind] ?? [];
    if (declared.length === 0) {
      out.push(
        `${owner.contextKey}: declares reconcileDomain "${owner.reconcileDomain}" but ` +
          `DELETE_ROUTES has no route for ${owner.kind} to make the announcement`,
      );
      continue;
    }
    for (const route of declared) {
      const announced = domainsAnnounced(readFile(route.file), route.symbol);
      if (!announced.has(owner.reconcileDomain)) {
        out.push(
          `${route.symbol} (${route.file}) does not announce "${owner.reconcileDomain}", ` +
            `so ${owner.reconcile} never runs and the "${owner.walkTabLabel}" tab ` +
            `outlives the last ${owner.kind}`,
        );
      }
    }
  }
  return out;
}

/** Which selection owners fail to reconcile, given a reader. */
export function unreconciledSelections(
  owners: SelectionOwner[],
  readFile: (rel: string) => string,
): string[] {
  const out: string[] = [];
  for (const owner of owners) {
    const handler = stripComments(readFile(owner.file));
    if (!new RegExp(`function\\s+${owner.reconcile}\\s*[(<]`).test(handler)) {
      out.push(`${owner.contextKey}: no reconciliation named ${owner.reconcile} in ${owner.file}`);
      continue;
    }
    // The reconciliation must actually take the contextual tab down, or it is a
    // no-op with a reassuring name.
    const body = routeBody(handler, owner.reconcile);
    const takesTabDown =
      /unregisterPanel\s*\(|removeTaskPaneContextKey\s*\(/.test(body) ||
      // ...or it delegates to the deselect that does.
      [...body.matchAll(/\b(deselect\w+|sync\w+|handleSelectionChange)\s*\(/g)].some((m) =>
        /unregisterPanel\s*\(|removeTaskPaneContextKey\s*\(/.test(routeBody(handler, m[1])),
      );
    if (!takesTabDown) {
      out.push(
        `${owner.contextKey}: ${owner.reconcile} never unregisters the contextual panel`,
      );
      continue;
    }
    const trigger = stripComments(readFile(owner.trigger.file));
    if (!trigger.includes(owner.reconcile) && owner.trigger.file !== owner.file) {
      // The store's refresh reaches the reconciliation through the extension's
      // event handler, so accept EITHER a direct call or the announcement that
      // drives it.
      const announces = /DELETED/.test(routeBody(trigger, owner.trigger.symbol));
      if (!announces) {
        out.push(
          `${owner.contextKey}: ${owner.trigger.symbol} in ${owner.trigger.file} neither ` +
            `calls ${owner.reconcile} nor announces a deletion that would`,
        );
      }
    }
  }
  return out;
}

// ===========================================================================
// 4. The census
// ===========================================================================

describe("cascade announcement census — the frontend half of §3bt's seventh census", () => {
  const rows = rustMatrix();
  const domains = uiDomains();

  it("the Rust matrix parses, and is the size the register says", () => {
    // A parse that silently matched nothing would make every assertion below
    // vacuous, which is the failure mode the six existing censuses were
    // hardened against four times.
    expect(rows.length, "DEPENDENCY_MATRIX parsed to too few rows").toBeGreaterThanOrEqual(45);
    expect(rows.some((r) => r.owner === "Table" && /^slicer\./.test(r.dependent))).toBe(true);
  });

  it("every object kind resolves to a declared UI domain, and every domain is a real one", () => {
    // The classification itself is a compile-time property now: `ui_domain` is
    // an exhaustive `match` in Rust, so a new ObjectKind cannot be added
    // without answering. What this checks is that the answer PARSED, and that
    // every kind the matrix actually names has one.
    expect(domains.size, "ui_domain parsed to too few arms").toBeGreaterThanOrEqual(20);
    const unresolved = [
      ...new Set(rows.flatMap((r) => [r.owner, r.dependentKind ?? ""])),
    ].filter((k) => k !== "" && !domains.has(k));
    expect(
      unresolved,
      "an ObjectKind appears in DEPENDENCY_MATRIX but not in ObjectKind::ui_domain — " +
        "the parse is stale, and a stale parse silently maps it to no domain",
    ).toEqual([]);
  });

  it("every owner that cascades into a cached store has a frontend delete route, or a reason", () => {
    const owners = new Set(
      rows
        .filter((r) => CASCADING_POLICIES.has(r.policy))
        .map((r) => r.owner)
        .filter((owner) => requiredDomainsFor(owner, rows, domains).size > 0),
    );
    const unanswered = [...owners].filter(
      (o) => !DELETE_ROUTES[o] && !NO_FRONTEND_DELETE_ROUTE[o],
    );
    expect(
      unanswered,
      "an object kind cascades into a store the frontend caches, and nothing here " +
        "says which frontend route deletes it",
    ).toEqual([]);
  });

  it("every frontend delete route announces the domains its cascade disturbs", () => {
    const required = new Map<string, Set<string>>();
    for (const owner of new Set(rows.map((r) => r.owner))) {
      const domainsOwed = requiredDomainsFor(owner, rows, domains);
      if (domainsOwed.size > 0) required.set(owner, domainsOwed);
    }
    const gaps = auditRoutes(required, DELETE_ROUTES, read);
    expect(
      gaps.map((g) => `${g.symbol} (${g.file}) misses [${g.missing.join(", ")}]`),
      "a delete route runs a backend cascade the frontend is never told about. " +
        "The dependent's store keeps its object, paints its overlay and swallows " +
        "the clicks meant for the cells underneath (§3bn).",
    ).toEqual([]);
  });

  it("the requirement is TRANSITIVE — a table delete owes the ribbon-filter store", () => {
    // The property the walk exists for, asserted directly so that flattening it
    // back to one level fails here rather than silently weakening every route
    // check above. A table cascades into its slicers; a slicer is pruned out of
    // every ribbon filter that cross-filters it.
    const table = requiredDomainsFor("Table", rows, domains);
    expect([...table].sort()).toEqual(["ribbonFilter", "slicer"]);
    // ...and the owner's OWN domain is not demanded of a frontend route.
    expect(table.has("objects")).toBe(false);
    // The sheet is the widest owner in the workbook.
    // The sheet reaches "paneControl" only through TWO hops (sheet -> chart ->
    // pane control), which is the edge the walk was written for and the one the
    // backend cascade was missing entirely.
    expect([...requiredDomainsFor("Sheet", rows, domains)].sort()).toEqual([
      "objects",
      "paneControl",
      "pivot",
      "ribbonFilter",
      "slicer",
    ]);
  });

  it("the routes named here all exist — a renamed function must fail loudly, not silently pass", () => {
    const missing: string[] = [];
    for (const routes of Object.values(DELETE_ROUTES)) {
      for (const route of routes) {
        if (routeBody(read(route.file), route.symbol).length === 0) {
          missing.push(`${route.symbol} in ${route.file}`);
        }
      }
    }
    expect(missing, "a route in this census no longer exists under that name").toEqual([]);
  });

  it("announceObjectCascade names the stores 'objects' does not reach", () => {
    const host = read("app/src/api/scriptHost/host.ts");
    const announced = domainsAnnounced(host, "announceObjectCascade");
    for (const domain of ["slicer", "ribbonFilter", "paneControl"]) {
      expect(announced.has(domain), `announceObjectCascade dropped "${domain}"`).toBe(true);
    }
    // And it must still do what the narrower announcement did, or a script's
    // table delete would stop repainting the grid.
    expect(routeBody(host, "announceObjectCascade")).toContain("announceObjectsChanged(");
  });

  it("the Shell translator can actually fan out every domain this census demands", () => {
    // A domain the translator does not know is dropped on the floor in silence,
    // so a route could satisfy the rule above and still refresh nothing.
    const bootstrap = read("app/src/shell/bootstrap.ts");
    const table = bootstrap.slice(bootstrap.indexOf("MUTATION_DOMAIN_EVENTS"));
    // EVERY domain the Rust side can name, not a hand-kept list: `ui_domain` is
    // where the backend announcer gets its domains from too, so a name the
    // translator does not know is dropped on the floor in silence in BOTH
    // directions.
    const named = [...new Set([...domains.values()].filter((d): d is string => d !== null))];
    expect(named.length, "no domains parsed out of ui_domain").toBeGreaterThan(5);
    for (const domain of named) {
      expect(
        new RegExp(`\\n\\s*${domain}:`).test(table),
        `the Shell translator has no mapping for the "${domain}" domain`,
      ).toBe(true);
    }
  });

  it("the backend announcement lands in the SAME translator", () => {
    // §3cd. A mutation started inside the backend emits `mutation:refresh` as a
    // Tauri event carrying the identical payload. If the Shell stopped bridging
    // it, every MCP object tool would silently go back to changing nothing on
    // screen — and nothing else in the repo would notice, because the bespoke
    // per-kind events it replaced have been deleted.
    const bootstrap = read("app/src/shell/bootstrap.ts");
    expect(bootstrap).toContain('listenTauriEvent<MutationRefreshPayload>("mutation:refresh"');
    expect(
      bootstrap.indexOf("fanOutDomains"),
      "the bridge must reuse the domain fan-out, not re-implement it",
    ).toBeGreaterThan(-1);
    // And the Rust side must still be emitting that exact name.
    expect(rustSource()).toContain('pub const MUTATION_REFRESH_EVENT: &str = "mutation:refresh"');
  });

  // =======================================================================
  // THE SELECTION HALF (§3cd)
  // =======================================================================

  it("every cascade-deleted object with a contextual tab has a selection reconciliation", () => {
    const cascadeDeleted = new Set(
      rows
        .filter((r) => DELETING_POLICIES.has(r.policy))
        .map((r) => r.dependentKind)
        .filter((k): k is string => k !== null),
    );
    expect(
      cascadeDeleted.has("Slicer"),
      "the matrix no longer cascade-deletes a slicer — the parse is stale",
    ).toBe(true);

    const declared = new Map(SELECTION_OWNERS.map((o) => [o.contextKey, o]));
    const missing: string[] = [];
    for (const [key, files] of contextKeysInExtensions()) {
      if (declared.has(key)) continue;
      if (CONTEXT_KEYS_NOT_WORKBOOK_OBJECTS[key]) continue;
      missing.push(`${key} (${files.join(", ")})`);
    }
    expect(
      missing,
      "a contextual ribbon tab appeared whose object may be deleted out from " +
        "under it, and nothing says how the tab comes down. Add it to " +
        "SELECTION_OWNERS with its reconciliation, or to " +
        "CONTEXT_KEYS_NOT_WORKBOOK_OBJECTS with the reason.",
    ).toEqual([]);

    // NON-VACUITY: the scan must be finding the tabs this census is about.
    const scanned = new Set(contextKeysInExtensions().keys());
    for (const key of ["slicer", "timeline-slicer", "table", "pivot", "chart"]) {
      expect(scanned.has(key), `the extension scan lost the "${key}" contextual tab`).toBe(true);
    }
  });

  it("every declared reconciliation exists, takes the tab down, and is reachable", () => {
    expect(
      unreconciledSelections(SELECTION_OWNERS, read),
      "a contextual ribbon tab can outlive the object it addresses. This is " +
        "BUG-0026: three actions (table.create, slicer.create, table.delete) " +
        "left the Slicer tab on a workbook with zero slicers.",
    ).toEqual([]);
  });

  it("a reconciliation driven by an announcement is actually announced — BUG-0051", () => {
    expect(
      unannouncedReconciliations(SELECTION_OWNERS, DELETE_ROUTES, read),
      "a contextual ribbon tab is re-derived by an event that the delete route " +
        "does not fire. This is BUG-0051: `deleteTableAsync` announced only the " +
        "stores it cascaded INTO, because `requiredDomainsFor` drops the owner's " +
        "own domain — and `objects` is the one that dispatches " +
        "TABLE_DEFINITIONS_UPDATED, the only thing that runs " +
        "`syncDesignTabToTables`.",
    ).toEqual([]);

    // NON-VACUITY: at least one owner must actually be exercising this rule, or
    // the assertion above is an empty loop that passes forever.
    expect(
      SELECTION_OWNERS.filter((o) => o.reconcileDomain !== null).map((o) => o.contextKey),
    ).toEqual(["table"]);
  });

  it("the walk that found BUG-0026 knows every contextual tab this census governs", () => {
    // `contextual-ribbon-tabs` skips unrecognised labels on purpose, so a tab
    // it has never heard of is invisible to the very harness that found this
    // bug. Every tab the census governs must therefore be taught to it.
    const invariants = read("app/e2e/invariants/invariants.ts");
    const rules = invariants.slice(
      invariants.indexOf("const CONTEXTUAL_TAB_RULES"),
      invariants.indexOf("// ============", invariants.indexOf("const CONTEXTUAL_TAB_RULES")),
    );
    expect(rules.length, "CONTEXTUAL_TAB_RULES not found").toBeGreaterThan(100);
    // TEETH for this rule: a label the walk does not know must come back false,
    // or the containment check below is a comment.
    expect(rules.includes("\n  Telepathy: {")).toBe(false);

    // Plain string containment, not a regex: the rule keys are object-literal
    // properties, quoted only when the label has a space, and a regex built by
    // interpolating a label with a space in it is one escaping mistake away
    // from matching nothing at all -- which is the vacuous pass this whole file
    // is hardened against.

    const untaught = SELECTION_OWNERS.filter(
      (o) =>
        !rules.includes(`\n  ${o.walkTabLabel}: {`) &&
        !rules.includes(`\n  "${o.walkTabLabel}": {`),
    ).map((o) => `${o.contextKey} -> "${o.walkTabLabel}"`);
    expect(
      untaught,
      "a contextual tab the census governs has no rule in the soak/invariant " +
        "walk, which SKIPS labels it does not recognise — so the walk that " +
        "found BUG-0026 could not find its successor",
    ).toEqual([]);
  });

  it("the store's refresh is the SINGLE announcer of a slicer's disappearance", () => {
    // The specific regression that would re-open BUG-0026: putting the
    // dispatch back on the delete route. The event then fires for the ONE path
    // a user takes by hand and for none of the cascades — which is exactly the
    // state the bug was found in.
    for (const [file, symbol, event] of [
      ["app/extensions/Slicer/lib/slicerStore.ts", "deleteSlicerAsync", "SLICER_DELETED"],
      [
        "app/extensions/TimelineSlicer/lib/timelineSlicerStore.ts",
        "deleteTimelineAsync",
        "TIMELINE_DELETED",
      ],
    ] as const) {
      const store = read(file);
      expect(
        stripComments(routeBody(store, symbol)),
        `${symbol} dispatches ${event} itself again — the refresh must be the ` +
          "one announcer, or a backend cascade emits nothing (§3cd)",
      ).not.toContain(event);
      expect(
        stripComments(routeBody(store, "refreshCache")),
        `refreshCache in ${file} no longer announces ${event}`,
      ).toContain(event);
    }
  });

  it("the item caches are pruned by the same diff, not by the delete route", () => {
    // A cascade-deleted slicer used to leak its cached item list for the whole
    // session, because only `deleteSlicerAsync` ever removed the entry.
    expect(routeBody(read("app/extensions/Slicer/lib/slicerStore.ts"), "refreshCache")).toContain(
      "itemsCache.delete(",
    );
    expect(
      routeBody(read("app/extensions/TimelineSlicer/lib/timelineSlicerStore.ts"), "refreshCache"),
    ).toContain("dataCache.delete(");
  });

  // =======================================================================
  // TEETH
  // =======================================================================
  it("the census finds a route that forgets — the detector is not vacuous", () => {
    const synthetic = `
      export async function deleteThingAsync(id: string): Promise<boolean> {
        const result = await backendDeleteThing(id);
        await refreshCache();
        emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["objects"], source: "commit" });
        return result.success;
      }
    `;
    const required = new Map([["Table", new Set(["slicer"])]]);
    const gaps = auditRoutes(
      required,
      {
        Table: [
          {
            file: "synthetic.ts",
            symbol: "deleteThingAsync",
            ownDomain: "objects",
            why: "planted",
          },
        ],
      },
      () => synthetic,
    );
    expect(gaps.map((g) => g.missing)).toEqual([["slicer"]]);

    // ...and the same route WITH the announcement is accepted, so the rule is
    // discriminating rather than simply always-failing.
    const fixed = synthetic.replace('["objects"]', '["objects", "slicer"]');
    expect(
      auditRoutes(
        required,
        {
          Table: [
            { file: "synthetic.ts", symbol: "deleteThingAsync", ownDomain: "objects", why: "planted" },
          ],
        },
        () => fixed,
      ),
    ).toEqual([]);
  });

  it("the ONE-LEVEL delegation hop is real: an announcement inside a helper counts", () => {
    const synthetic = `
      function announceTheCascade(): void {
        emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["slicer"], source: "commit" });
      }
      export async function deleteThingAsync(id: string): Promise<boolean> {
        await backendDeleteThing(id);
        announceTheCascade();
        return true;
      }
    `;
    expect([...domainsAnnounced(synthetic, "deleteThingAsync")]).toEqual(["slicer"]);
  });

  it("the selection census fires for a tab that never reconciles — teeth", () => {
    // The synthetic extension below has a contextual tab and a reconciliation
    // that does not take it down. Without this case a rule that silently
    // matched nothing would pass forever, which is the failure mode every
    // census in this program has had to be hardened against.
    const noop = `
      export function dropThingFromSelection(id: string): void {
        selected.delete(id);
      }
    `;
    expect(
      unreconciledSelections(
        [
          {
            contextKey: "thing",
            kind: "Thing",
            file: "synthetic.ts",
            reconcile: "dropThingFromSelection",
            trigger: { file: "synthetic.ts", symbol: "dropThingFromSelection" },
            walkTabLabel: "Thing",
            reconcileDomain: null,
            reconcileDomainWhy: "planted",
            why: "planted",
          },
        ],
        () => noop,
      ),
    ).toEqual(["thing: dropThingFromSelection never unregisters the contextual panel"]);

    // A missing function is reported too, and named.
    expect(
      unreconciledSelections(
        [
          {
            contextKey: "thing",
            kind: "Thing",
            file: "synthetic.ts",
            reconcile: "dropThingFromSelection",
            trigger: { file: "synthetic.ts", symbol: "dropThingFromSelection" },
            walkTabLabel: "Thing",
            reconcileDomain: null,
            reconcileDomainWhy: "planted",
            why: "planted",
          },
        ],
        () => "export function somethingElse(): void {}",
      )[0],
    ).toContain("no reconciliation named dropThingFromSelection");

    // ...and the real shape is accepted, so the rule discriminates.
    const real = `
      export function deselectThing(): void {
        removeTaskPaneContextKey("thing");
        unregisterPanel(THING_TAB_ID);
      }
      export function dropThingFromSelection(id: string): void {
        if (!selected.delete(id)) return;
        if (selected.size === 0) { deselectThing(); }
      }
    `;
    expect(
      unreconciledSelections(
        [
          {
            contextKey: "thing",
            kind: "Thing",
            file: "synthetic.ts",
            reconcile: "dropThingFromSelection",
            trigger: { file: "synthetic.ts", symbol: "dropThingFromSelection" },
            walkTabLabel: "Thing",
            reconcileDomain: null,
            reconcileDomainWhy: "planted",
            why: "planted",
          },
        ],
        () => real,
      ),
    ).toEqual([]);
  });

  it("the announcement-driven reconciliation rule fires — teeth for BUG-0051", () => {
    // The synthetic store below is BUG-0051 exactly: it refreshes its own cache
    // and announces the stores it cascaded into, but not the domain that drives
    // its own contextual tab back down.
    const broken = `
      function announceTheCascade(): void {
        emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["slicer"], source: "commit" });
      }
      export async function deleteThingAsync(id: string): Promise<boolean> {
        await backendDeleteThing(id);
        await refreshCache();
        announceTheCascade();
        return true;
      }
    `;
    const owner: SelectionOwner = {
      contextKey: "thing",
      kind: "Thing",
      file: "synthetic.ts",
      reconcile: "dropThingFromSelection",
      trigger: { file: "synthetic.ts", symbol: "dropThingFromSelection" },
      walkTabLabel: "Thing",
      reconcileDomain: "objects",
      reconcileDomainWhy: "",
      why: "planted",
    };
    const routes: Record<string, Route[]> = {
      Thing: [{ file: "synthetic.ts", symbol: "deleteThingAsync", ownDomain: "objects", why: "planted" }],
    };
    expect(unannouncedReconciliations([owner], routes, () => broken)).toEqual([
      'deleteThingAsync (synthetic.ts) does not announce "objects", so ' +
        'dropThingFromSelection never runs and the "Thing" tab outlives the last Thing',
    ]);

    // The FIXED shape is accepted, so the rule discriminates rather than always
    // failing — the other half of every teeth case in this file.
    const fixed = broken.replace('["slicer"]', '["objects", "slicer"]');
    expect(unannouncedReconciliations([owner], routes, () => fixed)).toEqual([]);

    // `ownDomain` + a self-refresh must NOT excuse it. That excuse is exactly
    // what `auditRoutes` grants and exactly why the cascade half could never
    // have caught this: the route above refreshes its own cache and still
    // fails.
    expect(refreshesOwnCache(broken, "deleteThingAsync")).toBe(true);

    // A null domain with no reason is reported rather than silently skipped.
    expect(
      unannouncedReconciliations(
        [{ ...owner, reconcileDomain: null, reconcileDomainWhy: "   " }],
        routes,
        () => broken,
      )[0],
    ).toContain("reconcileDomain is null with no reason");

    // ...and a declared domain with no delete route at all is a gap, not a pass.
    expect(unannouncedReconciliations([owner], {}, () => broken)[0]).toContain(
      "DELETE_ROUTES has no route for Thing",
    );
  });

  it("a COMMENT that names a domain does not satisfy the rule", () => {
    // The register's standing rule for its censuses: prose is not an
    // implementation. Every real route here explains its cascade in a comment
    // directly above the call, so an analyser that read comments would accept
    // a route that announces nothing.
    const commentOnly = `
      export async function deleteThingAsync(id: string): Promise<boolean> {
        // This cascades into domains: ["slicer"] on the backend.
        /* and again: domains: ["ribbonFilter"] */
        await backendDeleteThing(id);
        return true;
      }
    `;
    expect([...domainsAnnounced(commentOnly, "deleteThingAsync")]).toEqual([]);
  });
});
