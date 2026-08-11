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
  policy: string;
}

function rustMatrix(): RustRow[] {
  const src = read("app/src-tauri/src/object_deps.rs");
  const start = src.indexOf("pub const DEPENDENCY_MATRIX");
  expect(start, "DEPENDENCY_MATRIX has moved or been renamed").toBeGreaterThan(-1);
  const body = src.slice(start);
  const rows: RustRow[] = [];
  const re =
    /owner: ObjectKind::(\w+),\s*\n?\s*(?:\/\/[^\n]*\n\s*)*dependent: "((?:[^"\\]|\\[\s\S])*)",\s*\n?\s*policy: DeletePolicy::(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    rows.push({ owner: m[1], dependent: m[2].replace(/\\\s+/g, ""), policy: m[3] });
  }
  return rows;
}

/** The three policies that CHANGE another object; the rest run no code. */
const CASCADING_POLICIES = new Set(["Cascade", "CascadeOrRebind", "Prune"]);

/**
 * Which MUTATION_REFRESH domain reaches the store that caches a dependent.
 *
 * Keyed by a substring of the Rust row's `dependent` text, which names the
 * EDGE ("slicer.cacheSourceId / slicer.connectedSources"), so the mapping is
 * from the thing that goes stale to the domain that refreshes it.
 */
const DEPENDENT_TO_DOMAIN: Array<{ match: RegExp; domain: string }> = [
  { match: /^slicer\./, domain: "slicer" },
  { match: /^timelineSlicer\./, domain: "slicer" },
  { match: /^ribbonFilter\./, domain: "ribbonFilter" },
  { match: /^paneControl\./, domain: "paneControl" },
  { match: /^chart\.sheetIndex/, domain: "objects" },
  { match: /^table \/ pivot on the sheet/, domain: "pivot" },
];

/**
 * Dependents that are NOT a frontend-cached overlay, each with the reason.
 *
 * A new Rust row whose dependent matches neither this list nor the mapping
 * above fails `every dependent is classified`, which is the property that makes
 * this a census instead of a checklist.
 */
const NOT_FRONTEND_CACHED: Array<{ match: RegExp; reason: string }> = [
  {
    match: /^autoFilter/,
    reason:
      "The AutoFilter extension reads row visibility from the backend on every " +
      "repaint; it holds no object cache that can outlive the delete.",
  },
  {
    match: /^formula\.|^grid cells|^definedName|^row visibility/,
    reason: "Cell values, not objects. The recalculation writes them and the grid re-fetches.",
  },
  {
    match: /^objectScript\.|^cellBehavior\.|^control\.properties\.macroRef|^scheduler job|^capability grants/,
    reason:
      "Script-side records. They paint nothing and claim no rectangle; a stale " +
      "one is a failed lookup, not a swallowed click.",
  },
  {
    match: /^slicer\.computedProperties|^computed-prop dependency edges/,
    reason:
      "Backend dependency edges. The slicer that owns them is itself covered by " +
      "the slicer domain.",
  },
  {
    match: /^sheet-index-keyed stores|^report\.sheetIndex|^ribbonFilter\.connectionId/,
    reason:
      "Re-read from the backend whenever the sheet changes (the sheet switch is " +
      "itself the refresh), or, for the BI connection row, WarnAndKeep — nothing " +
      "is deleted.",
  },
  { match: /^-$/, reason: "NoDependents rows carry a placeholder dependent." },
];

function domainFor(dependent: string): string | null {
  for (const { match, domain } of DEPENDENT_TO_DOMAIN) {
    if (match.test(dependent)) return domain;
  }
  return null;
}

function isExcused(dependent: string): boolean {
  return NOT_FRONTEND_CACHED.some(({ match }) => match.test(dependent));
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
  for (const callee of body.matchAll(/\b(announce\w*|\w*Cascade\w*)\s*\(/g)) {
    const name = callee[1];
    if (name === symbol) continue;
    const helper = routeBody(src, name);
    if (helper) collect(stripComments(helper));
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
// 4. The census
// ===========================================================================

describe("cascade announcement census — the frontend half of §3bt's seventh census", () => {
  const rows = rustMatrix();

  it("the Rust matrix parses, and is the size the register says", () => {
    // A parse that silently matched nothing would make every assertion below
    // vacuous, which is the failure mode the six existing censuses were
    // hardened against four times.
    expect(rows.length, "DEPENDENCY_MATRIX parsed to too few rows").toBeGreaterThanOrEqual(45);
    expect(rows.some((r) => r.owner === "Table" && /^slicer\./.test(r.dependent))).toBe(true);
  });

  it("every dependent in the matrix is either mapped to a domain or excused with a reason", () => {
    const unclassified = rows
      .filter((r) => CASCADING_POLICIES.has(r.policy))
      .filter((r) => domainFor(r.dependent) === null && !isExcused(r.dependent))
      .map((r) => `${r.owner} -> ${r.dependent}`);
    expect(
      unclassified,
      "a cascading dependency was added to the Rust matrix without saying whether " +
        "a frontend store caches it. Add it to DEPENDENT_TO_DOMAIN (with the " +
        "domain that refreshes it) or to NOT_FRONTEND_CACHED (with the reason).",
    ).toEqual([]);
  });

  it("every owner that cascades into a cached store has a frontend delete route, or a reason", () => {
    const owners = new Set(
      rows
        .filter((r) => CASCADING_POLICIES.has(r.policy) && domainFor(r.dependent) !== null)
        .map((r) => r.owner),
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
    for (const r of rows) {
      if (!CASCADING_POLICIES.has(r.policy)) continue;
      const domain = domainFor(r.dependent);
      if (!domain) continue;
      if (!required.has(r.owner)) required.set(r.owner, new Set());
      required.get(r.owner)!.add(domain);
    }
    const gaps = auditRoutes(required, DELETE_ROUTES, read);
    expect(
      gaps.map((g) => `${g.symbol} (${g.file}) misses [${g.missing.join(", ")}]`),
      "a delete route runs a backend cascade the frontend is never told about. " +
        "The dependent's store keeps its object, paints its overlay and swallows " +
        "the clicks meant for the cells underneath (§3bn).",
    ).toEqual([]);
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
    for (const domain of ["slicer", "ribbonFilter", "paneControl", "pivot", "objects"]) {
      expect(
        new RegExp(`\\n\\s*${domain}:`).test(table),
        `the Shell translator has no mapping for the "${domain}" domain`,
      ).toBe(true);
    }
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
