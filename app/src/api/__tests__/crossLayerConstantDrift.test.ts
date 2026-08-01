//! FILENAME: app/src/api/__tests__/crossLayerConstantDrift.test.ts
// PURPOSE: Guard the hand-maintained cross-language / cross-layer lists that
//          nothing else pins. Each `describe` below is one list that could
//          silently fall behind the code it claims to describe.
// CONTEXT: This program shipped the SAME class of silent drift three times —
//          `ui.dialog`, `distribution.writeback` and `schedule` were each
//          stripped by a Rust pragma parser whose list had fallen behind
//          capabilityIds.ts, so a script that correctly declared a capability
//          was denied it with no diagnostic pointing anywhere. Two guards came
//          out of that (the `include_str!` capability mirror in
//          core/persistence/src/lib.rs, and scriptHost/__tests__/
//          allowlistCoverage.test.ts). This file is the sweep for what was
//          still unguarded afterwards.
//
//          RULE FOR EVERY GUARD HERE: derive one side from the SOURCE, and make
//          the failure message name the file to edit. A drift guard that fails
//          with "expected [a] to equal [a, b]" and nothing else just moves the
//          confusion downstream.
//
//          WHY TESTS AND NOT TYPES: where a list is mirrored across the
//          Rust/TypeScript boundary the compiler cannot help at all, so a test
//          that reads the other language's source is the strongest instrument
//          available. Where the drift is TS-to-TS, prefer retyping — see the
//          compile-time SURFACE_ORDER guard in ../codeInventory.ts for the
//          shape that needs no test at all.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import { CoreCommands, CommandRegistry } from "../commands";

const REPO = path.resolve(__dirname, "../../../..");
const readRepo = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

// ===========================================================================
// Shared Rust parsing helpers
// ===========================================================================

/** Strip line comments and `#[...]` attributes so a variant scan sees code. */
function stripRustNoise(src: string): string {
  return src
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*#\[[^\]]*\][ \t]*$/gm, "");
}

/** The `{ ... }` body of an item, brace-matched from its declaration. */
function rustItemBody(src: string, declaration: string): string {
  const at = src.indexOf(declaration);
  expect(at, `"${declaration}" not found`).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  expect(open, `no body for "${declaration}"`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated body for "${declaration}"`);
}

const toCamel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const lowerFirst = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/**
 * Variants of a `#[serde(rename_all = "camelCase", tag = "action")]` enum, as
 * they appear ON THE WIRE: `{ tag, fields }` with every name camelCased.
 */
function rustTaggedEnumVariants(
  src: string,
  declaration: string,
): { tag: string; fields: string[] }[] {
  const body = stripRustNoise(rustItemBody(src, declaration));
  const out: { tag: string; fields: string[] }[] = [];
  let i = 0;
  while (i < body.length) {
    const m = /([A-Z]\w*)\s*(\{|,)/g;
    m.lastIndex = i;
    const found = m.exec(body);
    if (!found) break;
    const name = found[1];
    if (found[2] === ",") {
      out.push({ tag: lowerFirst(name), fields: [] });
      i = m.lastIndex;
      continue;
    }
    // Brace-matched variant body.
    let depth = 0;
    let end = found.index + found[0].length - 1;
    for (let k = end; k < body.length; k++) {
      if (body[k] === "{") depth++;
      else if (body[k] === "}") {
        depth--;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    const inner = body.slice(found.index + found[0].length, end);
    const fields = [...inner.matchAll(/(\w+)\s*:/g)].map((f) => toCamel(f[1]));
    out.push({ tag: lowerFirst(name), fields });
    i = end + 1;
  }
  return out;
}

/**
 * Members of a TypeScript discriminated-union type alias, parsed with the
 * compiler API (a regex cannot see a multi-line object member reliably).
 */
function tsUnionVariants(
  filePath: string,
  aliasName: string,
  discriminant: string,
): { tag: string; fields: string[] }[] {
  const src = readRepo(filePath);
  const sf = ts.createSourceFile(path.basename(filePath), src, ts.ScriptTarget.ESNext, true);
  let alias: ts.TypeAliasDeclaration | undefined;
  const findAlias = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === aliasName) alias = node;
    ts.forEachChild(node, findAlias);
  };
  findAlias(sf);
  expect(alias, `type ${aliasName} not found in ${filePath}`).toBeDefined();
  const type = (alias as ts.TypeAliasDeclaration).type;
  const members = ts.isUnionTypeNode(type) ? [...type.types] : [type];
  return members.map((member) => {
    expect(ts.isTypeLiteralNode(member), `${aliasName} member is not an object type`).toBe(true);
    const lit = member as ts.TypeLiteralNode;
    const fields: string[] = [];
    let tag = "";
    for (const prop of lit.members) {
      if (!ts.isPropertySignature(prop) || !prop.name) continue;
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : "";
      if (!name) continue;
      if (name === discriminant) {
        const t = prop.type;
        tag = t && ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : "";
        continue;
      }
      fields.push(name);
    }
    return { tag, fields };
  });
}

const byTag = (v: { tag: string; fields: string[] }[]): Map<string, string[]> =>
  new Map(v.map((x) => [x.tag, [...x.fields].sort()]));

// ===========================================================================
// (1) Script side-effect enums: Rust producer vs TypeScript consumer
// ===========================================================================

describe("script side effects — Rust enums vs the TypeScript unions", () => {
  const typesRs = readRepo("core/script-engine/src/types.rs");

  const cases: { rust: string; alias: string; what: string }[] = [
    {
      rust: "pub enum DeferredAction",
      alias: "DeferredAction",
      what: "a UI action a script queued (goto, setZoom, fillDown, ...)",
    },
    {
      rust: "pub enum BookmarkMutation",
      alias: "BookmarkMutation",
      what: "a bookmark a script created or removed",
    },
  ];

  it.each(cases)("$alias variants + fields match core/script-engine/src/types.rs", ({ rust, alias, what }) => {
    const fromRust = byTag(rustTaggedEnumVariants(typesRs, rust));
    const fromTs = byTag(tsUnionVariants("app/src/api/workbookScripts.ts", alias, "action"));

    const missing = [...fromRust.keys()].filter((k) => !fromTs.has(k));
    const stale = [...fromTs.keys()].filter((k) => !fromRust.has(k));
    expect(
      missing,
      `The Rust script engine can emit ${alias} variant(s) the TypeScript union does not ` +
        `know: ${missing.join(", ")}. ${what} would be DROPPED by normalize${alias}s() and the ` +
        `host would silently never apply it — the script appears to run fine and does nothing.\n` +
        `FIX: add the variant to the ${alias} union in app/src/api/workbookScripts.ts (and ` +
        `handle it wherever that union is switched on, e.g. ` +
        `app/extensions/ScriptNotebook/lib/deferredActions.ts).`,
    ).toEqual([]);
    expect(
      stale,
      `The ${alias} union in app/src/api/workbookScripts.ts declares variant(s) Rust no ` +
        `longer emits: ${stale.join(", ")}. Delete them — dead wire shapes make the next ` +
        `reader trust the union less than they should.`,
    ).toEqual([]);

    for (const [tag, rustFields] of fromRust) {
      expect(
        fromTs.get(tag),
        `${alias} "${tag}": the field list in app/src/api/workbookScripts.ts does not match ` +
          `core/script-engine/src/types.rs. Serde camelCases every field (the container ` +
          `rename_all does variant NAMES only — each struct variant carries its own ` +
          `rename_all), so the wire names are the Rust names camelCased. A mismatch means the ` +
          `host reads \`undefined\` for a field the script actually set.`,
      ).toEqual(rustFields);
    }
  });

  it("the parsers are not vacuous", () => {
    expect(rustTaggedEnumVariants(typesRs, "pub enum DeferredAction").length).toBeGreaterThan(10);
    expect(
      tsUnionVariants("app/src/api/workbookScripts.ts", "BookmarkMutation", "action").length,
    ).toBe(5);
  });
});

// ===========================================================================
// (1b) The capability-grant mirror: RUST_MIRRORED_CAPABILITIES vs the backend
//      allowlist that has to ACCEPT every one of them
// ===========================================================================
//
// This is the guard for the fourth occurrence of this file's founding bug, and
// the one that actually shipped: `grant_script_capability` validated against a
// PRIVATE list in writeback_gateway.rs that omitted "schedule", while the
// frontend mirrored `schedule` on every grant. Result — `grant_script_capability`
// returned InvalidCapability, `script_scheduler` kept answering "schedule not
// granted" at registration AND at every firing, and the entire scheduler was
// unreachable for object scripts while looking implemented end to end.
//
// The vocabulary now lives once, in the store that holds the grants
// (capability_store.rs). This reads that file and pins the containment the
// mirror depends on, in the direction that matters: everything the frontend
// mirrors must be grantable in Rust. The converse is deliberately NOT asserted —
// Rust may accept an id the frontend does not yet mirror.

describe("capability grant mirror — frontend mirror vs the Rust grant allowlist", () => {
  const storeRs = readRepo("app/src-tauri/src/scripting/capability_store.rs");

  /** The string literals of `pub const GRANTABLE_CAPABILITIES: &[&str] = &[...]`. */
  function rustGrantable(): string[] {
    const at = storeRs.indexOf("pub const GRANTABLE_CAPABILITIES");
    expect(at, "GRANTABLE_CAPABILITIES not found in capability_store.rs").toBeGreaterThan(-1);
    const open = storeRs.indexOf("&[", at);
    const close = storeRs.indexOf("];", open);
    expect(close).toBeGreaterThan(open);
    return [...storeRs.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  it("every capability the frontend mirrors to Rust is accepted by the Rust allowlist", async () => {
    const { RUST_MIRRORED_CAPABILITIES } = await import("../scriptHost/capabilities");
    const grantable = new Set(rustGrantable());
    const rejected = [...RUST_MIRRORED_CAPABILITIES].filter((c) => !grantable.has(c));
    expect(
      rejected,
      `app/src/api/scriptHost/capabilities.ts mirrors ${rejected.join(", ")} to the backend, but ` +
        `GRANTABLE_CAPABILITIES in app/src-tauri/src/scripting/capability_store.rs does not accept ` +
        `it. grant_script_capability will return InvalidCapability, the Rust gate for that ` +
        `capability will answer "not granted" forever, and the feature will look implemented ` +
        `while being unusable (this is exactly how the scheduler shipped dead).\n` +
        `FIX: add the id to GRANTABLE_CAPABILITIES in capability_store.rs.`,
    ).toEqual([]);
  });

  it("grant_script_capability validates through the shared list, not a private copy", () => {
    const gatewayRs = readRepo("app/src-tauri/src/scripting/writeback_gateway.rs");
    expect(
      gatewayRs.includes("capability_store::is_grantable"),
      `grant_script_capability (writeback_gateway.rs) must validate through ` +
        `capability_store::is_grantable. A second, private allowlist is how "schedule" ` +
        `went missing.`,
    ).toBe(true);
    expect(
      /const\s+GRANTABLE_CAPABILITIES/.test(gatewayRs),
      `writeback_gateway.rs declares its own GRANTABLE_CAPABILITIES again — the vocabulary ` +
        `belongs to capability_store.rs, and a duplicate is a drift waiting to happen.`,
    ).toBe(false);
  });

  it("every id in the Rust allowlist is a real capability id", async () => {
    const { CAPABILITY_ID_SET } = await import("../scriptHost/capabilityIds");
    const unknown = rustGrantable().filter((c) => !CAPABILITY_ID_SET.has(c as never));
    expect(
      unknown,
      `capability_store.rs will accept grants for ${unknown.join(", ")}, which the frontend ` +
        `vocabulary (app/src/api/scriptHost/capabilityIds.ts) does not define. A backend that ` +
        `accepts ids nothing can consent to is a hole, not a feature.`,
    ).toEqual([]);
  });
});

// ===========================================================================
// (2) Grid-bridge commands reachable by object scripts
// ===========================================================================

describe("grid command bridge — every bridged command is classified for scripts", () => {
  const commandsTs = readRepo("app/src/api/commands.ts");

  /** `[CoreCommands.X]: "gridCommand",` keys of GRID_COMMAND_MAP. */
  function bridgedCommandKeys(): string[] {
    const body = rustItemBody(commandsTs, "const GRID_COMMAND_MAP");
    return [...body.matchAll(/\[CoreCommands\.(\w+)\]/g)].map((m) => m[1]);
  }

  /**
   * Bridged commands object scripts must NOT be able to run, each with the
   * reason. A NEW bridged command lands in neither list and fails the test —
   * which is the point: the decision is a security decision and must be made,
   * not defaulted into.
   */
  const DENIED_TO_SCRIPTS: Record<string, string> = {
    CUT: "clipboard contents are ambient-world data a sandboxed script must not read or replace",
    COPY: "same: reading the clipboard is reach outside the workbook",
    PASTE: "same: pasting injects ambient-world data the script never had",
  };

  it("every bridged grid command is either script-safe or explicitly denied", () => {
    const keys = bridgedCommandKeys();
    expect(keys.length, "GRID_COMMAND_MAP parsed as empty").toBeGreaterThan(10);
    const unclassified = keys.filter((k) => {
      const id = (CoreCommands as Record<string, string>)[k];
      return !CommandRegistry.isScriptSafe(id) && !(k in DENIED_TO_SCRIPTS);
    });
    expect(
      unclassified,
      `Grid command(s) bridged in GRID_COMMAND_MAP are neither script-safe nor explicitly ` +
        `denied: ${unclassified.join(", ")}.\n\n` +
        `Object scripts reach the grid bridge through CommandRegistry.isScriptSafe, whose ` +
        `SCRIPT_SAFE_GRID_COMMANDS list is maintained separately from GRID_COMMAND_MAP in ` +
        `app/src/api/commands.ts. FIX: decide, then either add the command to ` +
        `SCRIPT_SAFE_GRID_COMMANDS (if its reach is equivalent to the unlocked cell APIs) or ` +
        `to DENIED_TO_SCRIPTS in this test with the reason it is ambient.`,
    ).toEqual([]);
  });

  it("the denial list is enforced, not decorative", () => {
    for (const [key, reason] of Object.entries(DENIED_TO_SCRIPTS)) {
      const id = (CoreCommands as Record<string, string>)[key];
      expect(id, `CoreCommands.${key} no longer exists — update DENIED_TO_SCRIPTS`).toBeDefined();
      expect(
        CommandRegistry.isScriptSafe(id),
        `CoreCommands.${key} is now script-safe, but this test still records it as denied ` +
          `because ${reason}. Either that reasoning changed (update the list) or a clipboard ` +
          `command was made reachable from the sandbox by accident.`,
      ).toBe(false);
    }
  });

  it("the classification guard fires for a newly bridged command", () => {
    const fake = "core.grid.somethingNew";
    expect(CommandRegistry.isScriptSafe(fake)).toBe(false);
    expect(Object.keys(DENIED_TO_SCRIPTS)).not.toContain("SOMETHING_NEW");
  });
});

// ===========================================================================
// (3) MCP tool surface vs the AI access-tier policy
// ===========================================================================

describe("MCP tools — every tool is tier-classified and every gate is real", () => {
  const serverRs = readRepo("app/src-tauri/src/mcp/server.rs");
  const mcpSources = ["tools", "objects", "drafts"].map((f) =>
    readRepo(`app/src-tauri/src/mcp/${f}.rs`),
  );
  const objectsRs = readRepo("app/src-tauri/src/mcp/objects.rs");

  /** `#[tool(...)] async fn NAME` — the tools the MCP server advertises. */
  function advertisedTools(): { name: string; body: string }[] {
    const out: { name: string; body: string }[] = [];
    const re = /#\[tool\(description[\s\S]*?\n\s*async fn (\w+)/g;
    const hits = [...serverRs.matchAll(re)];
    for (let i = 0; i < hits.length; i++) {
      const start = hits[i].index as number;
      const end = i + 1 < hits.length ? (hits[i + 1].index as number) : serverRs.length;
      out.push({ name: hits[i][1], body: serverRs.slice(start, end) });
    }
    return out;
  }

  /**
   * The tier each advertised tool needs. `read` = no ceiling check (the MCP
   * transport auth + the main-window guard still apply, and "read" is the
   * lowest AI access level, so a read tool needs no further gate).
   *
   * A tool missing from this table fails the test. That is deliberate: the AI
   * access ceiling ("read" < "mutate" < "script", set in the MCP Server panel)
   * is the user's only control over what an agent may do to their workbook, and
   * a tool that nobody classified is a tool that silently sits outside it.
   */
  const TOOL_TIERS: Record<string, "read" | "mutate" | "script"> = {
    // --- reads ---
    get_cell_range: "read",
    get_sheet_summary: "read",
    list_charts: "read",
    list_named_ranges: "read",
    list_tables: "read",
    list_pivots: "read",
    get_chart: "read",
    list_sheets: "read",
    list_script_drafts: "read",
    get_script_draft: "read",
    list_bi_connections: "read",
    describe_bi_model: "read",
    run_bi_query: "read",
    cube_value: "read",
    cube_kpi: "read",
    cube_members: "read",
    // --- workbook mutations ---
    set_cell_value: "mutate",
    set_cell_range: "mutate",
    apply_formatting: "mutate",
    create_chart_from_spec: "mutate",
    create_named_range: "mutate",
    create_table: "mutate",
    create_pivot: "mutate",
    update_chart: "mutate",
    delete_chart: "mutate",
    update_named_range: "mutate",
    delete_named_range: "mutate",
    update_table: "mutate",
    delete_table: "mutate",
    update_pivot: "mutate",
    delete_pivot: "mutate",
    add_sheet: "mutate",
    rename_sheet: "mutate",
    delete_sheet: "mutate",
    move_sheet: "mutate",
    // Writes an INERT review artifact: never mounted, never executed. Gated at
    // "mutate" on purpose — gating a DRAFT at "script" would force the user to
    // hand the agent arbitrary-JS rights just to have a macro proposed.
    draft_object_script: "mutate",
    // --- arbitrary agent-authored JS ---
    run_script: "script",
  };

  const tools = advertisedTools();

  it("every advertised MCP tool has a tier classification", () => {
    const unclassified = tools.map((t) => t.name).filter((n) => !(n in TOOL_TIERS));
    expect(
      unclassified,
      `MCP tool(s) advertised by app/src-tauri/src/mcp/server.rs with no entry in TOOL_TIERS: ` +
        `${unclassified.join(", ")}.\n\n` +
        `Classify each one HERE, and make sure the implementation matches: a "mutate" or ` +
        `"script" tool must call check_mcp_access (app/src-tauri/src/scripting/commands.rs) or ` +
        `go through objects::require_tier / objects::gate. The AI access ceiling is the only ` +
        `thing standing between an agent and the user's workbook.`,
    ).toEqual([]);
  });

  it("the tier table has no stale entries", () => {
    const live = new Set(tools.map((t) => t.name));
    const stale = Object.keys(TOOL_TIERS).filter((n) => !live.has(n));
    expect(
      stale,
      `TOOL_TIERS classifies tool(s) the MCP server no longer advertises: ${stale.join(", ")}. ` +
        `Remove them so this table keeps describing the real surface.`,
    ).toEqual([]);
  });

  it("every mutate/script tool reaches an access gate", () => {
    /** Functions in mcp/*.rs this tool's server body delegates to. */
    function delegates(body: string): string[] {
      return [...new Set([...body.matchAll(/\b(?:tools|objects|drafts|tools_\w+)::(\w+)/g)].map((m) => m[1]))];
    }
    /** True when `name`'s implementation body contains an access gate. */
    function implGated(name: string): boolean {
      for (const src of mcpSources) {
        const at = src.search(new RegExp(`\\bfn\\s+${name}\\s*[(<]`));
        if (at < 0) continue;
        const rest = src.slice(at + 4);
        const nxt = rest.search(/\n(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s/);
        const body = src.slice(at, at + 4 + (nxt < 0 ? 6000 : nxt));
        if (/check_mcp_access|require_tier|\bgate\(/.test(body)) return true;
      }
      return false;
    }

    const ungated: string[] = [];
    for (const tool of tools) {
      const tier = TOOL_TIERS[tool.name];
      if (tier === "read" || tier === undefined) continue;
      // A gate can be named at the server call site, keyed by the tool name in
      // objects::required_tier, or sit inside the delegated implementation.
      const namedGate = mcpSources.some((s) =>
        new RegExp(`(?:require_tier|gate)\\([^)]*"${tool.name}"`).test(s),
      );
      const serverGate = /check_mcp_access|require_tier|\bgate\(/.test(tool.body);
      const delegated = delegates(tool.body).some(implGated);
      if (!namedGate && !serverGate && !delegated) ungated.push(tool.name);
    }
    expect(
      ungated,
      `MCP tool(s) classified as workbook-mutating or script-executing whose implementation ` +
        `reaches NO access gate: ${ungated.join(", ")}.\n\n` +
        `FIX: call check_mcp_access(&script_state, McpAccessTier::Mutate | ::Script) at the top ` +
        `of the implementation (app/src-tauri/src/mcp/tools.rs does this), or route the tool ` +
        `through objects::require_tier("<tool name>") so objects::required_tier decides. ` +
        `Without a gate, an agent held at the "read" access level can still perform this ` +
        `action — the setting would be a lie.`,
    ).toEqual([]);
  });

  it("required_tier names only real tools and still fails closed", () => {
    const map = rustItemBody(objectsRs, "pub(crate) fn required_tier");
    // Comments are stripped first: the rationale prose in this function quotes
    // tier names ("script"), which are not tool names.
    const named = [
      ...new Set([...stripRustNoise(map).matchAll(/"([a-z_][a-z0-9_]*)"/g)].map((m) => m[1])),
    ];
    const live = new Set(tools.map((t) => t.name));
    const bogus = named.filter((n) => !live.has(n));
    expect(
      bogus,
      `objects::required_tier in app/src-tauri/src/mcp/objects.rs names tool(s) that no ` +
        `#[tool] in server.rs advertises: ${bogus.join(", ")}. A stale name silently falls ` +
        `through to the strictest tier — safe, but it means the policy row for a RENAMED tool ` +
        `stopped applying and nothing said so.`,
    ).toEqual([]);
    expect(
      /_\s*=>\s*Some\(McpAccessTier::Script\)/.test(map),
      `objects::required_tier lost its fail-closed fallthrough. An unknown tool name MUST map ` +
        `to the strictest tier (Some(McpAccessTier::Script)); mapping it to None would make ` +
        `every future tool ungated by default.`,
    ).toBe(true);
  });

  it("the classification guard fires for a new unclassified tool", () => {
    const withNew = [...tools.map((t) => t.name), "exfiltrate_workbook"];
    expect(withNew.filter((n) => !(n in TOOL_TIERS))).toEqual(["exfiltrate_workbook"]);
    expect(tools.length).toBeGreaterThan(30); // the parser really read server.rs
  });
});
