//! FILENAME: app/scripts/scriptTypings/generateObjectContexts.ts
// PURPOSE: Generate app/extensions/ScriptableObjects/objectContexts.d.ts — the
//          ONLY extraLib Monaco loads for object scripts — from the two places
//          the surface really lives: the worker context shim (shape) and the
//          broker ALLOWLIST (policy + the `desc` a user is shown at consent).
// CONTEXT: Calcula's authoring pitch is "the object browser is accurate by
//          construction", which a hand-maintained .d.ts cannot deliver: the
//          shim grew biQuery / biSql / cube.* / connector.* / a range + chartMark
//          context while the typings did not, so those were uncallable as far as
//          IntelliSense was concerned. This module makes that class of drift a
//          BUILD FAILURE rather than a silent loss.
//
//          It is not a full type synthesizer, and deliberately so. Prose,
//          parameter names and parameter types live in a hand-authored TEMPLATE
//          (objectContexts.template.d.ts) because no amount of introspection can
//          invent "reading display strings and writing them back replaces every
//          formula with its text". What is DERIVED is everything that can drift
//          mechanically:
//            1. MEMBERSHIP  — every member the shim exposes must be declared,
//                             and every member declared must exist on the shim.
//                             Both directions, both tiers, every objectType.
//            2. POLICY DOCS — each member's broker method, tier, required
//                             capability and limits, with the allowlist `desc`
//                             verbatim, spliced into its JSDoc so hovering a
//                             method in Monaco says what it can touch.
//            3. THE ROSTERS — the objectType -> interface table and the
//                             capability -> methods table, emitted at markers.

import { probeSurface, type ProbedMember, type ProbeResult } from "./probeShim";
import { readTemplate, type DeclaredMember, type TemplateModel } from "./declarations";
import { ALLOWLIST, type MethodPolicy } from "../../src/api/scriptHost/allowlist";

export const OBJECT_TYPE_MARKER = "// @generated:object-type-table";
export const CAPABILITY_MARKER = "// @generated:capability-table";

export interface GenerateResult {
  /** The finished .d.ts text. Empty when `problems` is non-empty. */
  output: string;
  /** Human-readable drift reports; a non-empty list must fail the build. */
  problems: string[];
  /** Interfaces the probe reached but the template never declares. */
  unverified: string[];
  stats: { interfaces: number; members: number; documented: number };
}

// ============================================================================
// Policy rendering
// ============================================================================

function limitText(limits: Record<string, number> | undefined): string {
  if (!limits) return "";
  const parts = Object.entries(limits).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`);
  return parts.length ? ` Limits: ${parts.join(", ")}.` : "";
}

/**
 * The generated tail for one member: what the broker will let this call do,
 * in the allowlist's own words. The `desc` string is the SAME text the consent
 * dialog and the transparency panel render, so an author reading a tooltip and
 * a user reading a permission prompt are reading one sentence.
 */
function policyLines(member: ProbedMember): string[] {
  if (!member.broker) return [];
  const policy: MethodPolicy | undefined = ALLOWLIST[member.broker];
  if (!policy) return [];
  const lines: string[] = [];
  lines.push(`Calcula policy (generated): ${policy.desc}.`);
  const bits = [`broker \`${member.broker}\``];
  if (member.aspect) bits.push(`aspect \`${member.aspect}\``);
  bits.push(`${policy.tier} tier`);
  bits.push(`class ${policy.class}`);
  if (policy.capability) bits.push(`requires the \`${policy.capability}\` capability`);
  lines.push(`Reach: ${bits.join(", ")}.${limitText(policy.limits)}`);
  return lines;
}

// ============================================================================
// Splicing
// ============================================================================

interface Edit {
  start: number;
  end: number;
  text: string;
}

function jsDocInsertion(decl: DeclaredMember, lines: string[]): Edit {
  const indent = decl.indent;
  const body = lines.map((l) => `${indent} * ${l}`).join("\n");
  if (decl.jsDoc) {
    // Append to the existing block: keep every hand-written word, add the
    // derived paragraph after a blank comment line.
    const trimmed = decl.jsDoc.text.replace(/\s*\*\/\s*$/, "");
    return {
      start: decl.jsDoc.start,
      end: decl.jsDoc.end,
      text: `${trimmed}\n${indent} *\n${body}\n${indent} */`,
    };
  }
  return {
    start: decl.start,
    end: decl.start,
    text: `/**\n${body}\n${indent} */\n${indent}`,
  };
}

function applyEdits(source: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

// ============================================================================
// Generated roster blocks
// ============================================================================

function objectTypeTable(probe: ProbeResult): string {
  const rows = probe.objectTypes.map(([objectType, iface]) => `//   ${objectType.padEnd(12)} -> ${iface}`);
  return [
    "// Object types the script host can mount, and the context interface each",
    "// one receives (generated from contextShims.ts buildTyped).",
    ...rows,
  ].join("\n");
}

function capabilityTable(): string {
  const byCapability = new Map<string, string[]>();
  for (const [method, policy] of Object.entries(ALLOWLIST)) {
    if (!policy.capability) continue;
    const list = byCapability.get(policy.capability) ?? [];
    list.push(method);
    byCapability.set(policy.capability, list);
  }
  const rows: string[] = [];
  for (const capability of [...byCapability.keys()].sort()) {
    rows.push(`//   ${capability}`);
    for (const method of byCapability.get(capability)!.sort()) {
      rows.push(`//     - ${method}: ${ALLOWLIST[method].desc}`);
    }
  }
  return [
    "// Capabilities an object script can declare with `// @capability <id>`, and",
    "// the broker methods each one unlocks (generated from allowlist.ts). A call",
    "// without its grant rejects with CapabilityRequired; the user is asked with",
    "// the exact sentence shown here.",
    ...rows,
  ].join("\n");
}

// ============================================================================
// Entry point
// ============================================================================

const BANNER = `// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// =============================================================================
// Produced by:  npm run gen:script-typings
// Generator:    app/scripts/scriptTypings/generateObjectContexts.ts
// Prose source: app/scripts/scriptTypings/objectContexts.template.d.ts
// Shape source: app/src/api/scriptHost/worker/contextShims.ts   (probed at build)
// Policy source app/src/api/scriptHost/allowlist.ts             (desc/tier/caps)
//
// This is the ONLY extraLib Monaco loads for object scripts, so it is the whole
// of what IntelliSense knows. Editing it by hand is pointless: the next
// generation overwrites you, and objectContextsTypings.test.ts fails the build
// the moment this file stops matching the shim.
//
// Adding a method to contextShims.ts? Declare it in the TEMPLATE, then run
// \`npm run gen:script-typings\`. The generator refuses to emit while the shim
// and the typings disagree in either direction.
// =============================================================================
`;

/**
 * Generate the .d.ts from `template`, verifying it against the live shim.
 *
 * Returns problems rather than throwing so both callers can present them well:
 * the CLI prints them and exits non-zero; the lockstep test asserts they are
 * empty and shows the list as the failure message.
 */
export function generateObjectContexts(templateSource: string, templateName = "objectContexts.template.d.ts"): GenerateResult {
  const probe = probeSurface();
  const model: TemplateModel = readTemplate(templateName, templateSource);

  const problems: string[] = [];
  const unverified: string[] = [];
  const edits: Edit[] = [];
  let memberCount = 0;
  let documented = 0;

  for (const [ifaceName, probed] of [...probe.interfaces].sort((a, b) => a[0].localeCompare(b[0]))) {
    const declared = model.interfaces.get(ifaceName);
    if (!declared) {
      problems.push(
        `interface ${ifaceName} is exposed by the shim but is NOT declared in the template ` +
          `(members: ${[...probed.members.keys()].sort().join(", ")})`,
      );
      continue;
    }
    for (const [path, member] of [...probed.members].sort((a, b) => a[0].localeCompare(b[0]))) {
      memberCount++;
      const decl = declared.members.get(path);
      if (!decl) {
        problems.push(
          `${ifaceName}.${path} exists on the shim but is MISSING from the typings ` +
            `(authors cannot discover it)${member.broker ? ` [broker ${member.broker}]` : ""}`,
        );
        continue;
      }
      // Policy JSDoc is attached where the member is DECLARED. An inherited
      // member is documented once, on the interface that owns it, so the same
      // paragraph is not spliced fifteen times over.
      if (decl.inherited) continue;
      const lines = policyLines(member);
      if (lines.length) {
        documented++;
        edits.push(jsDocInsertion(decl, lines));
      }
    }
    for (const path of declared.members.keys()) {
      if (!probed.members.has(path)) {
        problems.push(
          `${ifaceName}.${path} is declared in the typings but does NOT exist on the shim ` +
            `(IntelliSense would offer a method that always fails)`,
        );
      }
    }
  }

  for (const name of model.interfaces.keys()) {
    if (!probe.interfaces.has(name)) unverified.push(name);
  }

  if (problems.length) {
    return { output: "", problems, unverified, stats: { interfaces: probe.interfaces.size, members: memberCount, documented } };
  }

  let body = applyEdits(templateSource, edits);
  if (!body.includes(OBJECT_TYPE_MARKER)) {
    problems.push(`template is missing the ${OBJECT_TYPE_MARKER} marker`);
  }
  if (!body.includes(CAPABILITY_MARKER)) {
    problems.push(`template is missing the ${CAPABILITY_MARKER} marker`);
  }
  if (problems.length) {
    return { output: "", problems, unverified, stats: { interfaces: probe.interfaces.size, members: memberCount, documented } };
  }
  body = body.replace(OBJECT_TYPE_MARKER, objectTypeTable(probe));
  body = body.replace(CAPABILITY_MARKER, capabilityTable());

  const output = `${BANNER}\n${body.replace(/\s*$/, "")}\n`;
  return {
    output,
    problems,
    unverified,
    stats: { interfaces: probe.interfaces.size, members: memberCount, documented },
  };
}
