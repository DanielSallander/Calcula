//! FILENAME: app/src/api/scriptHost/__tests__/auditCodeCensus.test.ts
// PURPOSE: Every code an audit row can carry is classified -- a REFUSAL (the
//          sandbox said no) or a FAILURE (the script's mistake or the host's) --
//          and the classification is applied where the row is written.
// CONTEXT: The status bar's code-and-scripts indicator counts refusals
//          (isAuditRefusal), and two kinds of refusal used to slip past it:
//          - Rust's capability gates refuse with a STRING ("PermissionDenied:
//            net.fetch not granted for https://evil.example"), and the broker
//            audited every non-BrokerError as "HostError" -- so the most
//            security-relevant refusal, network egress to an origin nobody
//            approved, was counted as a host hiccup;
//          - the pane registry writes "NoGesture" / "RateLimited", which the
//            first list of refusal codes did not know.
//          This file reads the SOURCES for every code written and fails on one
//          that is in neither set, so a new code cannot fall through silently.

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  AUDIT_FAILURE_CODES,
  AUDIT_REFUSAL_CODES,
  appendAudit,
  clearAudit,
  countAuditRefusals,
  isAuditRefusal,
} from "../auditRing";
import { BrokerError, auditCodeForError } from "../broker";

const API_DIR = path.resolve(__dirname, "../..");
const TAURI_DIR = path.resolve(__dirname, "../../../../src-tauri/src");

/** Every non-test .ts file under `dir`, recursively. */
function sources(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sources(full, ext));
    } else if (entry.name.endsWith(ext) && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

/** The text outside `//` line comments (a code named in prose is not written). */
const code = (file: string): string =>
  fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");

/** Every audit code the TypeScript side writes. */
function writtenCodes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const note = (codeName: string, where: string): void => {
    found.set(codeName, [...(found.get(codeName) ?? []), where]);
  };
  for (const file of sources(API_DIR, ".ts")) {
    const text = code(file);
    const rel = path.relative(API_DIR, file);
    for (const m of text.matchAll(/new BrokerError\(\s*"([A-Za-z]+)"/g)) note(m[1], rel);
    // `error: "Code"` in an audit row literal, and the union a refusal helper
    // takes (`error: "NoGesture" | "RateLimited"`).
    for (const m of text.matchAll(/\berror\s*:\s*("[A-Za-z]+"(?:\s*\|\s*"[A-Za-z]+")*)/g)) {
      for (const lit of m[1].matchAll(/"([A-Za-z]+)"/g)) note(lit[1], rel);
    }
  }
  // The broker's own union of codes it can throw.
  const broker = code(path.join(API_DIR, "scriptHost/broker.ts"));
  const union = /export type RpcErrorCode\s*=([^;]+);/.exec(broker);
  for (const lit of (union?.[1] ?? "").matchAll(/"([A-Za-z]+)"/g)) note(lit[1], "broker.ts RpcErrorCode");
  return found;
}

/** The "<Code>: ..." prefixes Rust's gates refuse with. */
function rustRefusalPrefixes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sources(TAURI_DIR, ".rs")) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/"((?:[A-Z][a-z]+)+(?:Denied|Required|Limited)): /g)) {
      found.set(m[1], [...(found.get(m[1]) ?? []), path.relative(TAURI_DIR, file)]);
    }
  }
  return found;
}

describe("every audit code is classified", () => {
  it("the two sets do not overlap", () => {
    expect([...AUDIT_REFUSAL_CODES].filter((c) => AUDIT_FAILURE_CODES.has(c))).toEqual([]);
  });

  it("the census found the codes (the guard is checking something)", () => {
    const codes = writtenCodes();
    for (const expected of ["PermissionDenied", "CapabilityRequired", "ValidationError", "HostError", "NoGesture", "RateLimited", "Revoked"]) {
      expect(codes.has(expected), `${expected} was not found in the sources`).toBe(true);
    }
  });

  it("every code the TypeScript side writes is a refusal or a failure", () => {
    const unclassified = [...writtenCodes()].filter(
      ([c]) => !AUDIT_REFUSAL_CODES.has(c) && !AUDIT_FAILURE_CODES.has(c),
    );
    expect(
      unclassified,
      "classify each in AUDIT_REFUSAL_CODES or AUDIT_FAILURE_CODES (scriptHost/auditRing.ts)",
    ).toEqual([]);
  });

  it("every '<Code>: ...' refusal Rust's gates write is audited under a REFUSAL code", () => {
    const prefixes = rustRefusalPrefixes();
    expect(prefixes.has("PermissionDenied"), "found no Rust refusal strings at all").toBe(true);
    for (const [prefix, files] of prefixes) {
      const audited = auditCodeForError(`${prefix}: something`);
      expect(
        AUDIT_REFUSAL_CODES.has(audited),
        `Rust refuses with "${prefix}: ..." (${files[0]}) but broker.ts audits it as "${audited}"`,
      ).toBe(true);
    }
  });
});

describe("auditCodeForError: the code a failed call is recorded under", () => {
  it("a BrokerError says its own code", () => {
    expect(auditCodeForError(new BrokerError("CapabilityRequired", "x"))).toBe("CapabilityRequired");
    expect(auditCodeForError(new BrokerError("ValidationError", "x"))).toBe("ValidationError");
  });

  it("Rust's string refusals keep their code (a string or an Error carrying it)", () => {
    expect(auditCodeForError("PermissionDenied: net.fetch not granted for https://evil.example")).toBe(
      "PermissionDenied",
    );
    expect(auditCodeForError(new Error("RateLimited: more than 60 fetches per minute for this script"))).toBe(
      "RateLimited",
    );
  });

  it("anything else is a host failure -- including a refusal word that is not the prefix", () => {
    expect(auditCodeForError("network unreachable")).toBe("HostError");
    expect(auditCodeForError(new Error("upstream said PermissionDenied: no"))).toBe("HostError");
    expect(auditCodeForError(undefined)).toBe("HostError");
  });
});

describe("isAuditRefusal / countAuditRefusals", () => {
  beforeEach(() => clearAudit());

  const row = (ok: boolean, error?: string) => ({
    ts: 0,
    scriptId: "s",
    scriptName: "s",
    method: "m",
    class: "read" as const,
    ok,
    error,
  });

  it("only an ok:false row with a refusal code is a refusal", () => {
    for (const c of AUDIT_REFUSAL_CODES) expect(isAuditRefusal(row(false, c)), c).toBe(true);
    for (const c of AUDIT_FAILURE_CODES) expect(isAuditRefusal(row(false, c)), c).toBe(false);
    expect(isAuditRefusal(row(true, "PermissionDenied"))).toBe(false);
    expect(isAuditRefusal(row(false))).toBe(false);
  });

  it("counts the refusals in the ring", () => {
    appendAudit(row(false, "PermissionDenied"));
    appendAudit(row(false, "ValidationError"));
    appendAudit(row(true));
    appendAudit(row(false, "NoGesture"));
    expect(countAuditRefusals()).toBe(2);
  });
});
