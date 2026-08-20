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
  /**
   * The source defines a function named `setup`. When false the script MOUNTS
   * AND DOES NOTHING -- the wrapper tail calls setup only if it exists.
   */
  hasSetup: boolean;
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
  /** The function nodes recognised as `setup` — their first param IS the context. */
  const setupFns = new Set<Node>();
  const noteFirstParam = (fn: Node | null | undefined) => {
    const p = fn?.params?.[0];
    if (p?.type === "Identifier") bindings.add(p.name);
    if (fn) setupFns.add(fn);
  };
  // ONLY `setup`'s first parameter is the context.
  //
  // The host's mount tail is `typeof setup === "function" ? setup(context)`, so
  // `setup` is the only function the context is ever passed to. Binding the
  // first parameter of EVERY exported function made any exported helper's
  // parameter a context binding, and `resolvePrefix` then resolved ordinary JS
  // on that local to a bare context chain — so
  //
  //     export function total(values) { return values.reduce(...); }
  //
  // reported `reduce` as an invented API member and the draft was REJECTED.
  // A validator whose failure mode is a false rejection of valid code is the
  // same defect class as the dry run judging a realm it cannot host.
  const isSetupName = (name: string | undefined): boolean => name === "setup";
  walk(program, (n) => {
    if (n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") {
      const decl = n.declaration;
      if (!decl) return;
      if (decl.type === "FunctionDeclaration" && isSetupName(decl.id?.name)) noteFirstParam(decl);
      if (decl.type === "VariableDeclaration") {
        for (const d of decl.declarations ?? []) {
          if (!isSetupName(d.id?.name)) continue;
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
  // Both declaration forms, mirroring hasSetupEntryPoint — the fallback used to
  // accept only `function setup`, so `const setup = (c) => …` with a parameter
  // not named context/ctx was validated with nothing bound and every check
  // passed vacuously.
  if (bindings.size === 0) {
    walk(program, (n) => {
      if (n.type === "FunctionDeclaration" && n.id?.name === "setup") noteFirstParam(n);
      if (
        n.type === "VariableDeclarator" &&
        n.id?.type === "Identifier" &&
        n.id.name === "setup" &&
        n.init &&
        (n.init.type === "ArrowFunctionExpression" || n.init.type === "FunctionExpression")
      ) {
        noteFirstParam(n.init);
      }
    });
  }

  // THE WRAPPER'S OWN PARAMETER, always. The mount splices the body inside
  // `function(context) { … }` (worker/debugWrapper.ts), so a bare `context.…`
  // use resolves to the real context by CLOSURE from anywhere in the script —
  // including a stray top-level `context.caps.fetch(…)` that WORKS at runtime
  // and used to go unexamined whenever `setup` named its parameter something
  // else, because the walk below only ran when nothing else had bound (found by
  // adversarial review). A name-keyed binding set cannot express per-scope
  // shadowing, so this is conservatively skipped the moment ANYTHING else in
  // the script declares its own `context` — under-detecting a shadowing script
  // beats falsely flagging its local object's methods.
  {
    let shadowed = false;
    walk(program, (n) => {
      if (shadowed) return;
      if (
        n.type === "FunctionDeclaration" ||
        n.type === "FunctionExpression" ||
        n.type === "ArrowFunctionExpression"
      ) {
        if (setupFns.has(n)) return; // setup's own `context` param IS the context
        for (const p of n.params ?? []) {
          if (p?.type === "Identifier" && p.name === "context") shadowed = true;
        }
      }
      if (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.id.name === "context") {
        shadowed = true;
      }
      if (n.type === "CatchClause" && n.param?.type === "Identifier" && n.param.name === "context") {
        shadowed = true;
      }
    });
    if (!shadowed) bindings.add("context");
  }

  // HELPERS THE CONTEXT IS PASSED TO. `setup(context) { helper(context); }`
  // with `helper(c) { c.api.… }` makes `c` the context at runtime, and the
  // setup-only narrowing left it invisible to the reach and capability checks —
  // the false-PASS half of the trade that fixed the false rejections (found by
  // adversarial review). Name-keyed bindings force conservatism, and every
  // guard errs toward NOT binding:
  //   * every call site of the function must pass a context-bound identifier
  //     at that position (a polymorphic helper is skipped);
  //   * the parameter's name must be declared exactly ONCE in the whole script
  //     (a reused name would bind unrelated code);
  //   * fixpoint, so a helper handing its context on to another helper is
  //     followed, bounded by the number of parameters in the script.
  {
    const fns = new Map<string, Node>();
    walk(program, (n) => {
      if (n.type === "FunctionDeclaration" && n.id?.type === "Identifier") {
        fns.set(n.id.name, n);
      }
      if (
        n.type === "VariableDeclarator" &&
        n.id?.type === "Identifier" &&
        n.init &&
        (n.init.type === "ArrowFunctionExpression" || n.init.type === "FunctionExpression")
      ) {
        fns.set(n.id.name, n.init);
      }
    });
    const calls = new Map<string, Node[][]>();
    walk(program, (n) => {
      if (n.type !== "CallExpression" || !n.callee) return;
      const callee = unwrap(n.callee);
      if (callee.type === "Identifier" && fns.has(callee.name)) {
        const list = calls.get(callee.name) ?? [];
        list.push(n.arguments ?? []);
        calls.set(callee.name, list);
      }
    });
    const declarationCount = new Map<string, number>();
    const bump = (name: string | undefined) => {
      if (name) declarationCount.set(name, (declarationCount.get(name) ?? 0) + 1);
    };
    walk(program, (n) => {
      if (n.type === "VariableDeclarator" && n.id?.type === "Identifier") bump(n.id.name);
      if (
        n.type === "FunctionDeclaration" ||
        n.type === "FunctionExpression" ||
        n.type === "ArrowFunctionExpression"
      ) {
        if (n.type === "FunctionDeclaration") bump(n.id?.name);
        for (const p of n.params ?? []) if (p?.type === "Identifier") bump(p.name);
      }
      if (n.type === "CatchClause" && n.param?.type === "Identifier") bump(n.param.name);
    });

    for (;;) {
      let grew = false;
      for (const [name, fn] of fns) {
        const sites = calls.get(name);
        if (!sites || sites.length === 0) continue;
        (fn.params ?? []).forEach((p: Node, k: number) => {
          if (p?.type !== "Identifier" || bindings.has(p.name)) return;
          if ((declarationCount.get(p.name) ?? 0) !== 1) return;
          const fed = sites.every((args) => {
            const arg = args[k] ? unwrap(args[k]) : undefined;
            return arg?.type === "Identifier" && bindings.has(arg.name);
          });
          if (fed) {
            bindings.add(p.name);
            grew = true;
          }
        });
      }
      if (!grew) break;
    }
  }

  // LAST RESORT: a bare `ctx.` root, when nothing else bound anything.
  //
  // Without this the reach and capability checks PASS VACUOUSLY on a script that
  // has no recognisable entry point — nothing is rooted, so nothing is examined.
  // Found by the eval corpus (M5) on a real 3B model's answer. `context` no
  // longer needs this (it is bound unconditionally above, absent shadowing);
  // `ctx` stays gated on emptiness because it is NOT the wrapper's parameter —
  // a legitimate local (`const ctx = canvas.getContext(…)`) is a real thing,
  // and only a script where nothing else bound suggests the bare-idiom draft
  // this exists to catch.
  if (bindings.size === 0) {
    walk(program, (n) => {
      if (n.type !== "MemberExpression") return;
      const root = unwrap(n.object);
      if (root.type === "Identifier" && root.name === "ctx") {
        bindings.add(root.name);
      }
    });
  }
  return bindings;
}

/**
 * Does the source have an ENTRY POINT the mount will actually run?
 *
 * Two forms qualify, because two forms genuinely work:
 *   1. A function named `setup` — the wrapper's tail is
 *      `typeof setup === "function" ? setup(context) : undefined`.
 *   2. A TOP-LEVEL `context.expose(...)` call — the module body runs at mount
 *      with the wrapper's parameter (literally named `context`) in scope, so
 *      the handler registers without any `setup`. Rejecting this form called a
 *      WORKING script broken (found by adversarial review). `ctx.expose(...)`
 *      does NOT qualify: `ctx` is not defined in the wrapper, so that script
 *      throws a ReferenceError at mount — and top-level only, because an
 *      expose inside a function nothing calls never runs.
 *
 * A script with neither MOUNTS AND DOES NOTHING. The module body still runs,
 * which is why this is not caught by anything else: no error, no output, no
 * effect. It is the quietest possible failure and a model that answers with a
 * bare handler call produces it every time.
 */
export function hasSetupEntryPoint(program: Node): boolean {
  let found = false;
  const isSetupFn = (node: Node | null | undefined): boolean =>
    Boolean(node) &&
    (node!.type === "FunctionDeclaration" || node!.type === "FunctionExpression" ||
      node!.type === "ArrowFunctionExpression");
  walk(program, (n) => {
    if (found) return;
    if (n.type === "FunctionDeclaration" && n.id?.name === "setup") found = true;
    if (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.id.name === "setup" && isSetupFn(n.init)) {
      found = true;
    }
  });
  if (found) return true;

  // Form 2: a top-level `context.expose(...)` statement (possibly wrapped in
  // an export, though that form is unusual). Deliberately NOT a walk — depth
  // matters here.
  for (const stmt of (program.body ?? []) as Node[]) {
    const expr = stmt.type === "ExpressionStatement" ? stmt.expression : undefined;
    const call = expr?.type === "CallExpression" ? expr : undefined;
    const callee = call?.callee;
    if (
      callee?.type === "MemberExpression" &&
      callee.object?.type === "Identifier" &&
      callee.object.name === "context" &&
      callee.property?.type === "Identifier" &&
      callee.property.name === "expose"
    ) {
      return true;
    }
  }
  return false;
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
      hasSetup: false,
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
    hasSetup: hasSetupEntryPoint(program),
    calls,
    dynamicAccesses,
    contextBindings: [...bindings],
  };
}
