//! FILENAME: app/scripts/scriptTypings/declarations.ts
// PURPOSE: Read the objectContexts TEMPLATE with the TypeScript compiler API —
//          the member paths each interface declares (following `extends`,
//          nested type literals and locally-declared references, exactly as the
//          runtime probe follows real objects), plus the source position of
//          every member so generated policy JSDoc can be spliced in.
// CONTEXT: Half of the generator. The other half (probeShim.ts) says what the
//          shim ACTUALLY exposes; this says what the typings CLAIM. The
//          generator fails the build when the two disagree, which is the whole
//          reason the file is generated: a hand-maintained .d.ts drifts
//          silently, and IntelliSense is the feature that dies when it does.
//
//          Deliberately AST-based, not regex-based: an interface's real member
//          set depends on heritage clauses and nested literals, and a regex
//          that "mostly works" would reintroduce exactly the silent drift this
//          file exists to eliminate.

import ts from "typescript";

export interface DeclaredMember {
  /** Dotted path within its owning interface ("style.setProperty"). */
  path: string;
  /** True when the member arrived through an `extends` clause. */
  inherited: boolean;
  /** Start of the member's leading trivia (where a JSDoc block belongs). */
  fullStart: number;
  /** Start of the member's own text (after leading trivia). */
  start: number;
  /** Existing JSDoc block for this member, if it has one. */
  jsDoc?: { start: number; end: number; text: string };
  /** Indentation of the member's line, for emitting a matching comment. */
  indent: string;
}

export interface DeclaredInterface {
  name: string;
  members: Map<string, DeclaredMember>;
}

export interface TemplateModel {
  sourceFile: ts.SourceFile;
  interfaces: Map<string, DeclaredInterface>;
  /** Names declared as `interface`/`type` in the template, for reference checks. */
  declaredNames: Set<string>;
}

type MemberNode = ts.PropertySignature | ts.MethodSignature;

function memberName(node: ts.TypeElement): string | undefined {
  const n = node.name;
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return undefined;
}

/** Peel `Promise<T>` / `readonly`-style wrappers we deliberately do NOT walk. */
function isPromiseType(type: ts.TypeNode | undefined): boolean {
  if (!type || !ts.isTypeReferenceNode(type)) return false;
  const name = type.typeName;
  return ts.isIdentifier(name) && name.text === "Promise";
}

/** The type a member's members live in: its own type, or a method's return. */
function walkableType(node: MemberNode): ts.TypeNode | undefined {
  if (ts.isPropertySignature(node)) return node.type;
  return node.type;
}

function indentOf(source: string, start: number): string {
  let i = start;
  while (i > 0 && source[i - 1] !== "\n") i--;
  let indent = "";
  for (let j = i; j < source.length && (source[j] === " " || source[j] === "\t"); j++) {
    indent += source[j];
  }
  return indent;
}

function jsDocOf(source: string, node: ts.Node): DeclaredMember["jsDoc"] {
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    const text = source.slice(r.pos, r.end);
    if (text.startsWith("/**")) return { start: r.pos, end: r.end, text };
  }
  return undefined;
}

/**
 * Collect member paths for one interface, following:
 *  - `extends` heritage (members are marked `inherited`),
 *  - nested type literals (`properties: { title: string }` -> "properties.title"),
 *  - references to interfaces declared IN THE TEMPLATE, entered as "name()" for
 *    a method return and "name" for a property — mirroring how the runtime
 *    probe descends into a returned handle or a nested namespace object.
 *
 * `Promise<T>` is never entered: an awaited answer is data the script receives,
 * not a surface it calls, and the probe cannot see inside one either.
 */
function collectMembers(
  model: {
    source: string;
    interfaces: Map<string, ts.InterfaceDeclaration>;
    typeLiteralAliases: Map<string, ts.TypeLiteralNode>;
  },
  decl: ts.InterfaceDeclaration,
  out: Map<string, DeclaredMember>,
  prefix: string,
  inherited: boolean,
  chain: Set<string>,
): void {
  for (const clause of decl.heritageClauses ?? []) {
    for (const expr of clause.types) {
      const name = ts.isIdentifier(expr.expression) ? expr.expression.text : undefined;
      if (!name || chain.has(name)) continue;
      const base = model.interfaces.get(name);
      if (!base) continue;
      const nextChain = new Set(chain);
      nextChain.add(name);
      collectMembers(model, base, out, prefix, true, nextChain);
    }
  }
  collectTypeElements(model, decl.members, out, prefix, inherited, chain);
}

function collectTypeElements(
  model: {
    source: string;
    interfaces: Map<string, ts.InterfaceDeclaration>;
    typeLiteralAliases: Map<string, ts.TypeLiteralNode>;
  },
  members: ts.NodeArray<ts.TypeElement>,
  out: Map<string, DeclaredMember>,
  prefix: string,
  inherited: boolean,
  chain: Set<string>,
): void {
  for (const node of members) {
    if (!ts.isPropertySignature(node) && !ts.isMethodSignature(node)) continue;
    const name = memberName(node);
    if (!name) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    const start = node.getStart(node.getSourceFile(), false);
    out.set(path, {
      path,
      inherited,
      fullStart: node.getFullStart(),
      start,
      jsDoc: jsDocOf(model.source, node),
      indent: indentOf(model.source, start),
    });

    const type = walkableType(node);
    if (!type || isPromiseType(type)) continue;
    const childPrefix = ts.isMethodSignature(node) ? `${path}()` : path;

    if (ts.isTypeLiteralNode(type)) {
      collectTypeElements(model, type.members, out, childPrefix, inherited, chain);
      continue;
    }
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      const refName = type.typeName.text;
      if (chain.has(refName)) continue;
      const refDecl = model.interfaces.get(refName);
      const refLiteral = model.typeLiteralAliases.get(refName);
      const nextChain = new Set(chain);
      nextChain.add(refName);
      if (refDecl) {
        // A reference to a NAMED interface is that interface's business — its
        // members are verified under its own name, not duplicated here.
        continue;
      }
      if (refLiteral) {
        collectTypeElements(model, refLiteral.members, out, childPrefix, inherited, nextChain);
      }
    }
  }
}

/** Parse the template and index every interface it declares. */
export function readTemplate(fileName: string, source: string): TemplateModel {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  const typeLiteralAliases = new Map<string, ts.TypeLiteralNode>();
  const declaredNames = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      interfaces.set(node.name.text, node);
      declaredNames.add(node.name.text);
    } else if (ts.isTypeAliasDeclaration(node)) {
      declaredNames.add(node.name.text);
      if (ts.isTypeLiteralNode(node.type)) typeLiteralAliases.set(node.name.text, node.type);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const model = { source, interfaces, typeLiteralAliases };
  const result = new Map<string, DeclaredInterface>();
  for (const [name, decl] of interfaces) {
    const members = new Map<string, DeclaredMember>();
    collectMembers(model, decl, members, "", false, new Set([name]));
    result.set(name, { name, members });
  }

  return { sourceFile, interfaces: result, declaredNames };
}
