//! FILENAME: app/src/api/__tests__/mountConsentKeyDrift.test.ts
// PURPOSE: The mount gate resolves "has this workbook approved application X's
//          code ON THIS SURFACE?" over a CLOSED table of surfaces that lives in
//          Rust. This pins that table against every TypeScript writer of the
//          consent store, against the TypeScript surface vocabulary, and against
//          every mount route's claim of which surface it is.
//
// WHY THE DIRECTION IS RUST -> TYPESCRIPT. `.calcula/script-consent.json` has
// many writers and each namespaces its records so approving an application's
// chart marks neither clobbers nor inherits the approval of its object scripts:
//
//      object-script          <application>                      object scripts + shipped macros
//      chart-marks            chart-marks:<application>          sandboxed chart marks
//      chart-transforms       chart-transforms:<application>     sandboxed chart transforms
//      custom-functions       custom-functions:<application>     JS UDFs merged from a .calp
//      lib                    lib:<application>                  shared script libraries
//      writeback-validators   <application>::writeback-validators
//
// A MOUNT names its surface (`consentSurface` on the definition) and the Rust
// gate (`CONSENT_SURFACES`, app/src-tauri/src/scripting/commands.rs) narrows to
// that ONE key. It used to expand the name into every spelling and admit the
// mount when ANY held a record, so a report application's approval satisfied
// the floor for a library of the same name. The surface is a renderer claim —
// a hostile renderer can name whichever surface holds a record, which is no
// worse than the old floor — but under an honest renderer the separation is
// real, and this file is what keeps the honest renderer honest:
//
//   * a surface that exists in TypeScript and is missing from Rust fails
//     CLOSED (that surface's consented mounts are refused — visible breakage,
//     never a hole, but breakage);
//   * a mount route that names NO surface is refused by Rust outright, so the
//     census below is what turns "every route names one" from a habit into a
//     gate;
//   * a route naming the WRONG surface for its key-former would be refused for
//     every consented publisher, so each route is pinned to its former.
//
// A TRAP THIS FILE WALKS AROUND. `app/src/api/writebackValidators.ts` contains
// deliberate NUL separators inside template literals, so ripgrep classifies it
// as binary and SKIPS it. A census of the consent store built on `rg` reports
// five writers and misses the sixth. Everything here reads with `fs`.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_ROOT = join(__dirname, "..", "..", "..");
const RUST_GATE = join(APP_ROOT, "src-tauri", "src", "scripting", "commands.rs");
const TS_SURFACES = join(APP_ROOT, "src", "api", "scriptHost", "mountConsentSurface.ts");

interface RustSurface {
  wire: string;
  prefix: string;
  suffix: string;
}

/** The rows of `const CONSENT_SURFACES: &[ConsentSurface] = &[ ... ];`. */
function rustSurfaces(code: string): RustSurface[] {
  const at = code.indexOf("const CONSENT_SURFACES: &[ConsentSurface] = &[");
  expect(at, "CONSENT_SURFACES is not declared in commands.rs").toBeGreaterThan(-1);
  const end = code.indexOf("];", at);
  const rows = [
    ...code
      .slice(at, end)
      .matchAll(/ConsentSurface\s*\{\s*wire:\s*"([^"]*)",\s*prefix:\s*"([^"]*)",\s*suffix:\s*"([^"]*)"/g),
  ].map((m) => ({ wire: m[1], prefix: m[2], suffix: m[3] }));
  expect(rows.length, "the CONSENT_SURFACES row parser matched nothing").toBeGreaterThan(0);
  return rows;
}

/** The members of `export type MountConsentSurface = | "a" | "b" ...;`. */
function tsSurfaces(code: string): string[] {
  const at = code.indexOf("export type MountConsentSurface =");
  expect(at, "MountConsentSurface is not declared").toBeGreaterThan(-1);
  const end = code.indexOf(";", at);
  return [...code.slice(at, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every .ts/.tsx file under `dir`, read with fs (NUL bytes and all). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "__tests__" || entry === "dist") continue;
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Strip `//` line comments and block comments so a probe cannot match prose. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * The object literal handed to `hostMountScript({ … })`, from the `{` to its
 * matching `}` — the same brace-counting scan `scriptOriginForgery.test.ts` uses.
 */
function mountDefinitionLiterals(code: string): string[] {
  const out: string[] = [];
  const CALL = "hostMountScript({";
  for (let at = code.indexOf(CALL); at !== -1; at = code.indexOf(CALL, at + 1)) {
    let depth = 0;
    let i = at + CALL.length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(code.slice(at, i + 1));
  }
  return out;
}

const rust = readFileSync(RUST_GATE, "utf8");
const surfaces = rustSurfaces(rust);
const byWire = new Map(surfaces.map((s) => [s.wire, s]));

/**
 * Each TypeScript key-former: the file that owns the spelling, the exact text
 * that must still be in it, and the Rust row it must agree with. A rename on
 * either side reds this.
 */
const formers: Array<{ file: string; literal: string; wire: string; prefix: string; suffix: string }> = [
  {
    file: join(APP_ROOT, "extensions", "Charts", "index.ts"),
    literal: "`chart-marks:${sourcePackage}`",
    wire: "chart-marks",
    prefix: "chart-marks:",
    suffix: "",
  },
  {
    file: join(APP_ROOT, "extensions", "Charts", "index.ts"),
    literal: "`chart-transforms:${sourcePackage}`",
    wire: "chart-transforms",
    prefix: "chart-transforms:",
    suffix: "",
  },
  {
    file: join(APP_ROOT, "src", "api", "customFunctions.ts"),
    literal: "return `custom-functions:${packageName}`;",
    wire: "custom-functions",
    prefix: "custom-functions:",
    suffix: "",
  },
  {
    file: join(APP_ROOT, "src", "api", "scriptLibraries", "consentKey.ts"),
    literal: "return `lib:${packageName}`;",
    wire: "lib",
    prefix: "lib:",
    suffix: "",
  },
  {
    file: join(APP_ROOT, "src", "api", "writebackValidators.ts"),
    literal: 'WRITEBACK_VALIDATOR_CONSENT_SUFFIX = "::writeback-validators"',
    wire: "writeback-validators",
    prefix: "",
    suffix: "::writeback-validators",
  },
  {
    // Object scripts key on the BARE application name — the one surface with
    // neither prefix nor suffix. Shipped module macros share this grant.
    //
    // The probe is the call itself rather than its old line-wrapped form: the
    // grant records the artifact set the PROMPT held (`pending`), so the
    // arguments sit on one line and an indentation-sensitive probe went stale
    // on a change that never touched the key.
    file: join(APP_ROOT, "extensions", "ScriptableObjects", "index.ts"),
    literal: "await recordConsent(packageName, pending.artifacts, pending.granted);",
    wire: "object-script",
    prefix: "",
    suffix: "",
  },
];

/**
 * Every mount route, the surface it must claim, and the artifact former it
 * must pass through — pinned by source text, because the surface is a claim
 * and the only thing that makes it an honest one is that each route says what
 * its own key-former recorded.
 */
const routes: Array<{ file: string; wire: string; artifactProbe: string }> = [
  { file: join(APP_ROOT, "src", "api", "scriptableObjects.ts"), wire: "object-script", artifactProbe: "consentArtifacts: [{ id: definition.id, source: definition.source }]" },
  { file: join(APP_ROOT, "src", "api", "objectScriptRunner.ts"), wire: "object-script", artifactProbe: "consentArtifacts: artifact ? [artifact] : undefined" },
  { file: join(APP_ROOT, "src", "api", "chartMarkScripts.ts"), wire: "chart-marks", artifactProbe: "consentArtifacts: [{ id: CHART_MARKS_SCRIPT_ID, source: markLibraryConsentSource(lib) }]" },
  { file: join(APP_ROOT, "src", "api", "chartTransformScripts.ts"), wire: "chart-transforms", artifactProbe: "{ id: CHART_TRANSFORMS_SCRIPT_ID, source: transformLibraryConsentSource(lib) }" },
  { file: join(APP_ROOT, "src", "api", "customFunctions.ts"), wire: "custom-functions", artifactProbe: "consentArtifacts: [{ id: CUSTOM_FUNCTIONS_SCRIPT_ID, source: plan.consentSource }]" },
  { file: join(APP_ROOT, "src", "api", "scriptLibraries", "linker.ts"), wire: "lib", artifactProbe: "consentArtifacts: modules.map((m) => ({ id: m.id, source: m.source }))" },
  { file: join(APP_ROOT, "src", "api", "writebackValidators.ts"), wire: "writeback-validators", artifactProbe: "consentArtifacts: [{ id: writebackValidatorScriptId(descriptor.name), source: descriptor.source }]" },
];

describe("the mount gate's consent-surface vocabulary is the one TypeScript writes", () => {
  it.each(formers)("Rust judges the $wire surface under the key its former spells", ({ file, literal, wire, prefix, suffix }) => {
    expect(
      readFileSync(file, "utf8"),
      `${file} no longer spells its consent key as ${literal} — update this guard AND the Rust table`,
    ).toContain(literal);
    const row = byWire.get(wire);
    expect(row, `Rust's CONSENT_SURFACES has no row for the "${wire}" surface`).toBeDefined();
    expect(row).toEqual({ wire, prefix, suffix });
  });

  it("no surface is listed in Rust that nothing writes", () => {
    // A stale entry is not a hole, but it is a false claim about the app's
    // surfaces — and this table is what a reader trusts to enumerate them.
    const owned = new Set(formers.map((f) => f.wire));
    for (const s of surfaces) {
      expect(owned, `Rust lists the consent surface "${s.wire}" but no TypeScript writer forms its key`).toContain(s.wire);
    }
    expect(surfaces.length).toBe(formers.length);
  });

  it("the TypeScript MountConsentSurface union is the Rust table, member for member", () => {
    const ts = tsSurfaces(readFileSync(TS_SURFACES, "utf8"));
    expect(new Set(ts)).toEqual(new Set(surfaces.map((s) => s.wire)));
  });

  it("exactly one surface owns the bare key, and it is object-script", () => {
    // The bare application name is the object-script grant's key. A second
    // surface with an empty prefix AND suffix would share that record.
    const bare = surfaces.filter((s) => s.prefix === "" && s.suffix === "");
    expect(bare.map((s) => s.wire)).toEqual(["object-script"]);
  });

  it("every writer of the consent store is accounted for", () => {
    // The census: a NEW surface that records consent has to be classified here,
    // because its key namespace decides whether its consented mounts are admitted.
    const writers = [
      ...sourceFiles(join(APP_ROOT, "src", "api")),
      ...sourceFiles(join(APP_ROOT, "extensions")),
    ]
      .filter((f) => readFileSync(f, "utf8").includes("recordConsent("))
      .map((f) => f.replace(APP_ROOT, "").replace(/\\/g, "/"));

    expect(new Set(writers)).toEqual(
      new Set([
        // The store itself.
        "/src/api/distributedConsent.ts",
        // Key-formers, one per namespace.
        "/src/api/customFunctions.ts",
        "/src/api/scriptLibraries/install.ts",
        "/src/api/writebackValidators.ts",
        "/extensions/Charts/lib/distributedLibraryGate.ts",
        // Object scripts: the bare application name. (Its sibling
        // lib/consentStore.ts only RE-EXPORTS the store and forms no key.)
        "/extensions/ScriptableObjects/index.ts",
      ]),
    );
  });
});

describe("every mount route names its surface, and the artifact its own surface recorded", () => {
  it.each(routes)("$file claims $wire and passes its recorded artifact through", ({ file, wire, artifactProbe }) => {
    const code = stripComments(readFileSync(file, "utf8"));
    const literals = mountDefinitionLiterals(code);
    expect(literals.length, `${file} has no hostMountScript({ … }) literal to inspect`).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(literal, `${file}: a mount literal names no consentSurface — Rust refuses that outright`).toMatch(
        /consentSurface:\s*"[^"]+"/,
      );
      const claimed = /consentSurface:\s*"([^"]+)"/.exec(literal)?.[1];
      expect(
        claimed,
        `${file} claims the surface "${claimed}" but its key-former writes the "${wire}" key — ` +
          "a consented publisher would be refused under the wrong namespace",
      ).toBe(wire);
      expect(byWire.has(claimed ?? ""), `${file} claims a surface Rust does not know`).toBe(true);
    }
    expect(code, `${file} no longer passes its surface's own artifact former through: ${artifactProbe}`).toContain(artifactProbe);
  });

  it("the module debug session (the one non-literal mount) names object-script and the stored module", () => {
    const host = stripComments(readFileSync(join(APP_ROOT, "src", "api", "scriptHost", "host.ts"), "utf8"));
    const start = host.indexOf("export async function hostStartModuleScriptDebugSession");
    expect(start).toBeGreaterThan(-1);
    const body = host.slice(start, host.indexOf("\n}\n", start));
    expect(body).toContain('consentSurface: "object-script"');
    expect(body).toContain("consentArtifacts: [{ id: scriptId, source: record.source }]");
  });

  it("no mount route outside @api is unclassified", () => {
    // A route this file does not know about would name no surface and be
    // refused for every consented publisher — the census keeps the list here
    // the list that exists.
    const known = new Set(routes.map((r) => r.file.replace(APP_ROOT, "").replace(/\\/g, "/")));
    known.add("/src/api/scriptHost/host.ts");
    const found = [...sourceFiles(join(APP_ROOT, "src", "api")), ...sourceFiles(join(APP_ROOT, "extensions"))]
      .filter((f) => stripComments(readFileSync(f, "utf8")).includes("hostMountScript("))
      .map((f) => f.replace(APP_ROOT, "").replace(/\\/g, "/"));
    expect(new Set(found)).toEqual(known);
  });

  it("the Rust gate refuses a mount that names no surface instead of flooring it", () => {
    // Pinned at the source: the surface is matched BEFORE the consent file is
    // read, and both the missing and the unknown case return a refusal.
    const fn = rust.slice(rust.indexOf("fn distributed_mount_refusal("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body.indexOf("consent_surface(wire)")).toBeGreaterThan(-1);
    expect(body.indexOf("consent_surface(wire)")).toBeLessThan(body.indexOf("let Some(file) = consent_file else"));
    expect(body).toContain("did not say");
    expect(body).toContain("does not know");
    // ...and the old any-namespace expansion is gone.
    expect(rust).not.toContain("fn consent_keys_for_application(");
  });
});
