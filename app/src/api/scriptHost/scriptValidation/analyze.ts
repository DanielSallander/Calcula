//! FILENAME: app/src/api/scriptHost/scriptValidation/analyze.ts
// PURPOSE: Parse an object script and report every context member-chain it
//          calls, plus every `// @capability` pragma it declares.
// CONTEXT: This is the SYNTACTIC half of the draft validator. It is deliberately
//          sound-but-incomplete, and §11.2 of
//          docs/design/local-model-script-authoring.md is built on exactly that
//          asymmetry: what this file FINDS is really there, what it does not
//          find may still be there.
//
//          The one case that matters is computed access —
//              const m = useBackup ? "fetch" : "log";
//              await context.caps[m](url);
//          — where no `caps.fetch` appears anywhere in the source. That is why
//          `dynamicAccesses` is reported rather than swallowed: it is the
//          evidence that lets a reviewer tell "declared something it does not
//          use" apart from "uses something this scanner cannot see".
//
//          AST-based, not regex-based, for the reason declarations.ts gives:
//          a regex that mostly works reintroduces the silent drift the whole
//          derive-never-restate discipline exists to remove. Here it would be
//          worse than drift — a false positive REJECTS the user's script.

import { parse } from "acorn";

/** A context member chain the script calls, e.g. "caps.storage.get". */
export interface CalledChain {
  chain: string;
  line: number;
}

/** A computed member access the scanner could not resolve. */
export interface DynamicAccess {
  /** The resolved prefix it was taken on, e.g. "caps" in `caps[m]`. */
  onChain: string;
  line: number;
}

export interface AnalyzedScript {
  /** L0: the source parsed. When false, everything else is empty. */
  parsed: boolean;
  /** The parse failure, when `parsed` is false. */
  parseError?: { message: string; line?: number };
  /** Capability ids declared by `// @capability <id>` pragmas. */
  declaredCapabilities: string[];
  calls: CalledChain[];
  dynamicAccesses: DynamicAccess[];
  /** Identifiers the walk treated as the context (for diagnostics). */
  contextBindings: string[];
}

// ---------------------------------------------------------------------------
// Pragmas
// ---------------------------------------------------------------------------

/**
 * Read `// @capability <id>` declarations.
 *
 * Mirrors `persistence::parse_declared_capabilities` (Rust), which is the
 * AUTHORITATIVE parser — it is what actually sets the mounted script's R19
 * ceiling. This copy exists only to tell the model what it wrote before the
 * script is ever saved; where the two could disagree, Rust wins and the
 * mismatch is a defect in this function.
 */
export function parseDeclaredCapabilities(source: string): string[] {
  const out: string[] = [];
  const re = /^[ \t]*\/\/[ \t]*@capability[ \t]+([A-Za-z0-9_.]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// AST walk
// ---------------------------------------------------------------------------

type Node = Record<string, any>;

/** Walk every node, children first is not required — order does not matter. */
function walk(node: Node | null | undefined, visit: (n: Node) => void): void {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "loc" || key === "range") continue;
    const value = (node as Node)[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === "string") walk(child, visit);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      walk(value, visit);
    }
  }
}

/** Unwrap the wrappers that sit between a chain and its spine. */
function unwrap(node: Node): Node {
  let cur = node;
  for (;;) {
    if (cur.type === "AwaitExpression" || cur.type === "TSNonNullExpression") {
      cur = cur.argument ?? cur.expression;
      continue;
    }
    if (cur.type === "ChainExpression" || cur.type === "ParenthesizedExpression") {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
}

interface Flattened {
  root: string;
  parts: string[];
  /** A computed access was hit while flattening; the chain is truncated. */
  dynamic: boolean;
}

/**
 * Flatten a member/call spine into its root identifier and property names,
 * erasing calls: `context.api.chart("c1").setSpec(s)` -> root `context`,
 * parts `[api, chart, setSpec]`.
 *
 * Erasing calls is what lets a purely syntactic walk follow a handle without any
 * type inference, and the generated surface erases them the same way so the two
 * forms meet.
 */
function flatten(node: Node): Flattened | null {
  const parts: string[] = [];
  let dynamic = false;
  let cur = unwrap(node);
  for (;;) {
    if (cur.type === "CallExpression" || cur.type === "NewExpression") {
      cur = unwrap(cur.callee);
      continue;
    }
    if (cur.type === "MemberExpression") {
      if (cur.computed) {
        // `caps[m]` — the name is assembled at run time. Record it and keep
        // walking down so the PREFIX (`caps`) is still resolved.
        dynamic = true;
        parts.length = 0;
        cur = unwrap(cur.object);
        continue;
      }
      const name = cur.property?.name;
      if (typeof name !== "string") return null;
      parts.unshift(name);
      cur = unwrap(cur.object);
      continue;
    }
    if (cur.type === "Identifier") return { root: cur.name, parts, dynamic };
    return null;
  }
}

/**
 * Identifiers bound to the context.
 *
 * The host calls `setup(context)` (worker/bootstrap.ts), so the context is a
 * PARAMETER and its name is whatever the author chose. Anything rooted at an
 * identifier not found here is left alone — that is what makes the reach check
 * free of false positives on a script's own variables and imports.
 */
function collectContextBindings(program: Node): Set<string> {
  const bindings = new Set<string>();
  const noteFirstParam = (fn: Node | null | undefined) => {
    const p = fn?.params?.[0];
    if (p?.type === "Identifier") bindings.add(p.name);
  };
  walk(program, (n) => {
    if (n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") {
      const decl = n.declaration;
      if (!decl) return;
      if (decl.type === "FunctionDeclaration") noteFirstParam(decl);
      if (decl.type === "VariableDeclaration") {
        for (const d of decl.declarations ?? []) {
          const init = d.init;
          if (init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
            noteFirstParam(init);
          }
        }
      }
    }
  });
  // A script with no export at all still gets validated: `setup` may be a plain
  // declaration the host picks up, and a draft under repair is often mid-edit.
  if (bindings.size === 0) {
    walk(program, (n) => {
      if (n.type === "FunctionDeclaration" && n.id?.name === "setup") noteFirstParam(n);
    });
  }
  return bindings;
}

/**
 * Extend the binding set through simple aliases: `const ctx = context;` and
 * `const chart = context.api.chart("c1");`.
 *
 * Only direct assignment from an already-resolved context chain counts. Aliases
 * are resolved to a PREFIX so a later `chart.setSpec(s)` reports the full
 * `api.chart.setSpec` rather than a bare `setSpec` that matches nothing.
 */
function collectAliases(program: Node, bindings: Set<string>): Map<string, string> {
  const aliases = new Map<string, string>();
  // Two passes: an alias can be declared after another alias it depends on only
  // in pathological code, but a second pass is cheap and covers the ordinary
  // `const api = context.api; const wb = api.workbook;` shape.
  for (let pass = 0; pass < 2; pass++) {
    walk(program, (n) => {
      if (n.type !== "VariableDeclarator" || n.id?.type !== "Identifier" || !n.init) return;
      const flat = flatten(n.init);
      if (!flat) return;
      const prefix = resolvePrefix(flat, bindings, aliases);
      if (prefix === null) return;
      const chain = [prefix, ...flat.parts].filter(Boolean).join(".");
      aliases.set(n.id.name, chain);
    });
  }
  return aliases;
}

/**
 * The chain prefix a flattened spine hangs off, or null when its root is
 * neither the context nor a known alias (a plain local, an import, a global).
 */
function resolvePrefix(
  flat: Flattened,
  bindings: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
): string | null {
  if (bindings.has(flat.root)) return "";
  const aliased = aliases.get(flat.root);
  return aliased === undefined ? null : aliased;
}

export function analyzeScript(source: string): AnalyzedScript {
  const declaredCapabilities = parseDeclaredCapabilities(source);

  let program: Node;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    }) as unknown as Node;
  } catch (e) {
    const err = e as { message?: string; loc?: { line?: number } };
    return {
      parsed: false,
      parseError: { message: err.message ?? String(e), line: err.loc?.line },
      declaredCapabilities,
      calls: [],
      dynamicAccesses: [],
      contextBindings: [],
    };
  }

  const bindings = collectContextBindings(program);
  const aliases = collectAliases(program, bindings);

  const calls: CalledChain[] = [];
  const dynamicAccesses: DynamicAccess[] = [];
  const seenCalls = new Set<string>();

  walk(program, (n) => {
    if (n.type !== "CallExpression") return;
    const flat = flatten(n.callee);
    if (!flat) return;
    const prefix = resolvePrefix(flat, bindings, aliases);
    if (prefix === null) return;
    const line = n.loc?.start?.line ?? 0;
    if (flat.dynamic) {
      dynamicAccesses.push({ onChain: prefix, line });
      return;
    }
    const chain = [prefix, ...flat.parts].filter(Boolean).join(".");
    if (!chain) return;
    const key = `${chain}@${line}`;
    if (seenCalls.has(key)) return;
    seenCalls.add(key);
    calls.push({ chain, line });
  });

  // A computed access that is never CALLED still hides a member name, so it is
  // recorded too — `const f = context.caps[m]` then `await f(url)`.
  walk(program, (n) => {
    if (n.type !== "MemberExpression" || !n.computed) return;
    const flat = flatten(n.object);
    if (!flat) return;
    const prefix = resolvePrefix(flat, bindings, aliases);
    if (prefix === null) return;
    const onChain = [prefix, ...flat.parts].filter(Boolean).join(".");
    const line = n.loc?.start?.line ?? 0;
    if (dynamicAccesses.some((d) => d.line === line && d.onChain === onChain)) return;
    dynamicAccesses.push({ onChain, line });
  });

  return {
    parsed: true,
    declaredCapabilities,
    calls,
    dynamicAccesses,
    contextBindings: [...bindings],
  };
}
