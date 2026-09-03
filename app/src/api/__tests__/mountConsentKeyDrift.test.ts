//! FILENAME: app/src/api/__tests__/mountConsentKeyDrift.test.ts
// PURPOSE: The mount gate resolves "has this workbook approved application X?"
//          over a CLOSED set of consent-store key namespaces that lives in Rust.
//          This pins that set against every TypeScript writer of the store.
//
// WHY THE DIRECTION IS RUST -> TYPESCRIPT. `.calcula/script-consent.json` has
// many writers and each namespaces its records so approving an application's
// chart marks neither clobbers nor inherits the approval of its object scripts:
//
//      <application>                     object scripts
//      chart-marks:<application>         sandboxed chart marks
//      chart-transforms:<application>    sandboxed chart transforms
//      custom-functions:<application>    JS UDFs merged from a .calp
//      lib:<application>                 shared script libraries
//      <application>::writeback-validators   writeback validators
//
// A MOUNT presents only the application name — it cannot prove which surface it
// is — so `consent_keys_for_application` (app/src-tauri/src/scripting/commands.rs)
// expands the name into every spelling and asks whether ANY of them is approved.
// A namespace that exists in TypeScript and is missing from Rust fails CLOSED:
// that surface's consented mounts are refused. Visible breakage, never a hole —
// but breakage, so it is worth a test rather than a habit.
//
// A TRAP THIS FILE WALKS AROUND. `app/src/api/writebackValidators.ts` contains
// deliberate NUL separators inside template literals, so ripgrep classifies it
// as binary and SKIPS it. A census of the consent store built on `rg` reports
// five writers and misses the sixth. Everything here reads with `fs`.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_ROOT = join(__dirname, "..", "..", "..");
const RUST_GATE = join(
  APP_ROOT,
  "src-tauri",
  "src",
  "scripting",
  "commands.rs",
);

/** The string literals inside a `const NAME: &[&str] = &[ ... ];` item. */
function rustStrList(code: string, name: string): string[] {
  const at = code.indexOf(`const ${name}: &[&str] = &[`);
  expect(at, `${name} is not declared in commands.rs`).toBeGreaterThan(-1);
  const end = code.indexOf("];", at);
  return [...code.slice(at, end).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
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

describe("the mount gate's consent-key vocabulary is the one TypeScript writes", () => {
  const rust = readFileSync(RUST_GATE, "utf8");
  const prefixes = rustStrList(rust, "CONSENT_KEY_PREFIXES");
  const suffixes = rustStrList(rust, "CONSENT_KEY_SUFFIXES");

  /**
   * Each TypeScript key-former: the file that owns the spelling, and the exact
   * text that must still be in it. A rename on either side reds this.
   */
  const formers: Array<{ file: string; literal: string; namespace: string; kind: "prefix" | "suffix" | "bare" }> = [
    {
      file: join(APP_ROOT, "extensions", "Charts", "index.ts"),
      literal: "`chart-marks:${sourcePackage}`",
      namespace: "chart-marks:",
      kind: "prefix",
    },
    {
      file: join(APP_ROOT, "extensions", "Charts", "index.ts"),
      literal: "`chart-transforms:${sourcePackage}`",
      namespace: "chart-transforms:",
      kind: "prefix",
    },
    {
      file: join(APP_ROOT, "src", "api", "customFunctions.ts"),
      literal: "return `custom-functions:${packageName}`;",
      namespace: "custom-functions:",
      kind: "prefix",
    },
    {
      file: join(APP_ROOT, "src", "api", "scriptLibraries", "consentKey.ts"),
      literal: "return `lib:${packageName}`;",
      namespace: "lib:",
      kind: "prefix",
    },
    {
      file: join(APP_ROOT, "src", "api", "writebackValidators.ts"),
      literal: 'WRITEBACK_VALIDATOR_CONSENT_SUFFIX = "::writeback-validators"',
      namespace: "::writeback-validators",
      kind: "suffix",
    },
    {
      // Object scripts key on the BARE application name — the case
      // `consent_keys_for_application` covers without a namespace at all.
      //
      // The probe is the call itself rather than its old line-wrapped form: the
      // grant now records the artifact set the PROMPT held (`pending`), so the
      // arguments moved onto one line and an indentation-sensitive probe went
      // stale on a change that never touched the key. The key is still the bare
      // `packageName`, which is what this row exists to pin.
      file: join(APP_ROOT, "extensions", "ScriptableObjects", "index.ts"),
      literal: "await recordConsent(packageName, pending.artifacts, pending.granted);",
      namespace: "",
      kind: "bare",
    },
  ];

  it.each(formers)("Rust knows the $namespace namespace ($kind)", ({ file, literal, namespace, kind }) => {
    expect(
      readFileSync(file, "utf8"),
      `${file} no longer spells its consent key as ${literal} — update this guard AND the Rust list`,
    ).toContain(literal);
    if (kind === "prefix") expect(prefixes).toContain(namespace);
    if (kind === "suffix") expect(suffixes).toContain(namespace);
    // The bare case needs no list entry: consent_keys_for_application always
    // includes the application name itself, which its own Rust test pins.
  });

  it("no namespace is listed in Rust that nothing writes", () => {
    // A stale entry is not a hole, but it is a false claim about the app's
    // surfaces — and this list is what a reader trusts to enumerate them.
    const owned = new Set(formers.map((f) => f.namespace));
    for (const ns of [...prefixes, ...suffixes]) {
      expect(owned, `Rust lists the consent namespace "${ns}" but no TypeScript writer forms it`).toContain(ns);
    }
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
