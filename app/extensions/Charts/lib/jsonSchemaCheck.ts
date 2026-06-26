//! FILENAME: app/extensions/Charts/lib/jsonSchemaCheck.ts
// PURPOSE: A small JSON-Schema (draft-07 subset) checker — the runtime gate for
//          script/AI-authored ChartSpecs (B8) and the test-time drift/example
//          guards. Implements only the keywords chartSpecSchema uses: $ref, type,
//          const, enum, properties + required + additionalProperties:false,
//          items, oneOf/anyOf, allOf, if/then/else. Pure, no deps.
// CONTEXT: Promoted out of __tests__/schemaValidate.ts so production code (the
//          broker chart-write path) can reuse the SAME checker the tests trust.

/* eslint-disable @typescript-eslint/no-explicit-any */

function typeMatches(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case "string": return typeof value === "string";
      case "number": return typeof value === "number";
      case "integer": return typeof value === "number" && Number.isInteger(value);
      case "boolean": return typeof value === "boolean";
      case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
      case "array": return Array.isArray(value);
      case "null": return value === null;
      default: return true;
    }
  });
}

/**
 * Return the unknown-property / missing-required / type / const / enum
 * violations of `value` against `schema` (which must carry its own
 * `definitions` for $ref resolution). Empty array = valid.
 */
export function schemaViolations(value: unknown, schema: any): string[] {
  const defs: Record<string, any> = schema.definitions ?? {};

  function resolveRef(node: any): any {
    let n = node;
    while (n && n.$ref) n = defs[String(n.$ref).replace("#/definitions/", "")];
    return n;
  }

  function viol(value: any, node: any, path: string): string[] {
    const s = resolveRef(node);
    if (!s) return [];
    const out: string[] = [];

    if (s.const !== undefined && value !== s.const) {
      out.push(`${path}: expected const ${JSON.stringify(s.const)}`);
    }
    if (Array.isArray(s.enum) && !s.enum.includes(value)) {
      out.push(`${path}: ${JSON.stringify(value)} not in enum`);
    }
    if (s.type !== undefined && value !== undefined && !typeMatches(value, s.type)) {
      out.push(`${path}: expected type ${JSON.stringify(s.type)}`);
    }

    // oneOf / anyOf: valid if at least one branch is clean.
    const branches: any[] | undefined = s.oneOf ?? s.anyOf;
    if (Array.isArray(branches)) {
      let best: string[] | null = null;
      for (const b of branches) {
        const e = viol(value, b, path);
        if (e.length === 0) { best = []; break; }
        if (best === null || e.length < best.length) best = e;
      }
      out.push(...(best ?? []));
    }

    // allOf: must satisfy every subschema.
    if (Array.isArray(s.allOf)) {
      for (const sub of s.allOf) out.push(...viol(value, sub, path));
    }

    // if / then / else.
    if (s.if) {
      const condOk = viol(value, s.if, path).length === 0;
      if (condOk && s.then) out.push(...viol(value, s.then, path));
      if (!condOk && s.else) out.push(...viol(value, s.else, path));
    }

    // object
    if ((s.type === "object" || s.properties !== undefined) && value && typeof value === "object" && !Array.isArray(value)) {
      const props = s.properties ?? {};
      if (Array.isArray(s.required)) {
        for (const r of s.required) {
          if (value[r] === undefined) out.push(`${path}: missing required '${r}'`);
        }
      }
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        if (props[key] !== undefined) out.push(...viol(value[key], props[key], `${path}.${key}`));
        else if (s.additionalProperties === false) out.push(`${path}: unknown property '${key}'`);
      }
    }

    // array
    if ((s.type === "array" || s.items !== undefined) && Array.isArray(value)) {
      value.forEach((it, i) => out.push(...viol(it, s.items, `${path}[${i}]`)));
    }

    return out;
  }

  return viol(value, schema, "spec");
}

/** Collect every `$ref` string anywhere in a schema (for dangling-ref checks). */
export function collectRefs(node: any, acc: string[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectRefs(n, acc));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string") acc.push(v);
    else collectRefs(v, acc);
  }
}
