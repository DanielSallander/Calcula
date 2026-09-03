//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/previewSafety.test.ts
// PURPOSE: Pin the property that makes a dry run safe to run on a real user's
//          open workbook — and that would regress SILENTLY.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          WHY A SOURCE-READING GUARD. `hostPreviewScript` is safe because of
//          calls it does NOT make: no mount gate, so no consent modal and no
//          persistent workbook-trust record; no `buildHandleFromDefinition`, so
//          no live grant set and no inherited "Always" grant; no
//          `restoreAndSyncGrants`, so nothing reaches the authoritative Rust
//          capability store; no `registerMountedHandle`, so it never appears as
//          a mounted script; and no `executeImpl`, so no call can fall through
//          to a Tauri command and edit the document.
//
//          None of that is observable from the outside — the function's RESULT
//          is identical whether or not it also granted a capability on the way.
//          The realm itself cannot be driven here at all (jsdom has no
//          `Worker`), so the only tier that can hold this property is one that
//          reads the source. That is a real limitation, stated rather than
//          papered over: this guard proves the calls are absent, and the E2E
//          spec proves the function works. Neither alone is enough.

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brokerCall, buildPreviewHandle, BrokerError, sameTrustOrigin } from "../../broker";
import { clearAudit, getAuditTail, getAuditTotal } from "../../auditRing";

const HOST = resolve(__dirname, "../../host.ts");
const BROKER = resolve(__dirname, "../../broker.ts");

/**
 * The body of one top-level function, by brace matching.
 *
 * The parameter list is skipped by PAREN depth first, because a destructured or
 * inline-typed parameter (`opts: { ... }`) carries braces of its own — taking
 * the first `{` after the name returns the parameter type instead of the body,
 * and every "this function does not call X" assertion then passes vacuously
 * against the wrong text.
 */
function functionBody(source: string, signature: string): string {
  const at = source.indexOf(signature);
  if (at < 0) throw new Error(`${signature} not found — the guard is reading the wrong thing`);
  let i = source.indexOf("(", at);
  let parens = 0;
  for (; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")" && --parens === 0) break;
  }
  const open = source.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, j + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

/**
 * The same body with comments removed.
 *
 * An absence check must run against CODE. The first version of this guard read
 * the raw text and failed on `hostPreviewScript`'s own comment explaining that
 * `executeImpl` is unreachable from it — a comment that documents a protection
 * cannot be allowed to look like a breach of it. The reverse matters more: a
 * guard tuned to pass with that comment present would be one substring away
 * from passing with a real call present too.
 */
function codeOnly(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("hostPreviewScript is safe by ABSENCE", () => {
  const host = readFileSync(HOST, "utf8");
  const body = functionBody(host, "export async function hostPreviewScript(");
  const code = codeOnly(body);

  it("reads a real function body, so the absences below cannot pass vacuously", () => {
    // If this function is ever renamed, gutted or inlined — or if comment
    // stripping ever eats the code — every assertion under it would trivially
    // hold. The positive facts come first, and they are checked on the STRIPPED
    // text, which is the text the absences are checked against.
    expect(code.length).toBeGreaterThan(1200);
    expect(code, "it must spawn a REAL worker realm — that is the whole point").toContain("spawnWorker()");
    expect(code, "it must go through the real broker, not a private policy copy").toContain("brokerCall(handle,");
    expect(code, "it must build the preview identity, never a definition's").toContain("buildPreviewHandle({");
    expect(code, "the realm must not outlive the preview").toContain("worker.terminate()");
  });

  /**
   * Each of these is a DIFFERENT irreversible thing a mount does. They are
   * asserted one by one, rather than as a set, so a failure names which
   * protection was lost.
   */
  it.each([
    ["assertMountAllowed", "would raise the Script-Security modal and can write a persistent workbook-trust record"],
    ["buildHandleFromDefinition", "would fetch the LIVE grant set and inherit any persisted 'Always' grant"],
    ["restoreAndSyncGrants", "would push capability grants to the authoritative Rust store"],
    ["registerMountedHandle", "would publish the preview into the transparency panel as a mounted script"],
    ["maybeRequestCapabilityGrant", "would raise a JIT consent dialog for a script the user never mounted"],
    ["executeImpl", "would let a call fall through to a real Tauri command and edit the document"],
    ["mounted.set", "would enter the mount registry, where unmount REVOKES Rust capabilities by script id"],
    ["hostUnmountScript", "would revoke a real script's capabilities if an id ever collided"],
  ])("never calls %s — it %s", (symbol) => {
    expect(code).not.toContain(symbol);
  });

  it("declares no capabilities to the realm, matching the handle's empty ceiling", () => {
    // The realm shapes `context.caps` from this list. A non-empty list here
    // would show the script a surface the broker then refuses — the confusing
    // half of a safe outcome.
    expect(code).toMatch(/capabilities:\s*\[\]/);
  });

  it("refuses to become a verdict where there is no realm to run in", () => {
    // jsdom has no Worker. Answering "it did not run" would report a fact about
    // the environment as a fact about the script.
    expect(code).toContain("realmUnavailable");
    expect(code).toContain("workerRealmAvailable()");
  });
});

describe("the preview identity", () => {
  it("declares and holds NOTHING, so no capability can ever be admitted", () => {
    const handle = buildPreviewHandle({
      scriptId: "preview:test:1",
      scriptName: "(preview)",
      objectType: "button",
      instanceId: null,
      tier: "unlocked",
    });
    expect(handle.grants.size).toBe(0);
    expect(handle.declaredCapabilities.size).toBe(0);
    expect(handle.preview).toBe(true);
    // Its own KIND: origin drives cross-script trust, and a preview must not be
    // same-origin with anything the workbook actually mounted — nor with another
    // preview, which the old `"(preview)"` string quietly allowed.
    expect(handle.origin).toEqual({ kind: "preview" });
    expect(handle.origin.kind).not.toBe("local");
    const other = buildPreviewHandle({
      scriptId: "preview:test:1b",
      scriptName: "(preview)",
      objectType: "button",
      instanceId: null,
      tier: "unlocked",
    });
    expect(sameTrustOrigin(handle, other)).toBe(false);
  });

  it("is refused every capability-bearing method, by the CEILING and not by a grant", () => {
    const handle = buildPreviewHandle({
      scriptId: "preview:test:2",
      scriptName: "(preview)",
      objectType: "button",
      instanceId: null,
      tier: "unlocked",
    });
    // `cap.fetch` is the sharpest case: it reaches the network through a Rust
    // gate that a renderer-side backend swap could never intercept.
    return expect(
      brokerCall(handle, "cap.fetch", ["https://example.test", {}], async () => "should never run"),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof BrokerError &&
        e.code === "PermissionDenied" &&
        // "did not declare" is the CEILING's message; "requires the ... capability"
        // alone would mean it merely lacked a grant, which a JIT prompt can fix.
        e.message.includes("did not declare"),
    );
  });
});

describe("a preview leaves no trace in the audit trail", () => {
  beforeEach(() => clearAudit());

  const handle = buildPreviewHandle({
    scriptId: "preview:test:3",
    scriptName: "(preview)",
    objectType: "button",
    instanceId: null,
    tier: "unlocked",
  });

  it("records neither a successful call nor a refused one", async () => {
    await brokerCall(handle, "base.log", ["hello"], async () => undefined);
    await brokerCall(handle, "cap.fetch", ["https://example.test", {}], async () => undefined).catch(
      () => undefined,
    );
    expect(getAuditTail()).toEqual([]);
    expect(getAuditTotal()).toBe(0);
  });

  it("still records a NON-preview handle, so the suppression is not global", () => {
    // The teeth of the test above: without this, deleting the audit call
    // entirely would pass it.
    const real = { ...handle, preview: undefined } as typeof handle;
    return brokerCall(real, "base.log", ["hello"], async () => undefined).then(() => {
      expect(getAuditTotal()).toBe(1);
      expect(getAuditTail()[0]).toMatchObject({ method: "base.log", ok: true });
    });
  });

  it("suppresses the PERSISTED capability log too, denials included", () => {
    // The subtle half. `persistCapabilityAudit` writes broker-policy denials
    // into the workbook's own audit log — so without this, the empty ceiling
    // that keeps a preview harmless would itself write permanent rows about a
    // script the user never agreed to run.
    const broker = readFileSync(BROKER, "utf8");
    const auditBody = functionBody(broker, "function audit(");
    const guardAt = auditBody.indexOf("if (handle.preview) return;");
    expect(guardAt, "the preview guard must exist in audit()").toBeGreaterThan(-1);
    expect(
      auditBody.indexOf("appendAudit("),
      "the guard must precede the in-memory ring append",
    ).toBeGreaterThan(guardAt);
    expect(
      auditBody.indexOf("persistCapabilityAudit("),
      "the guard must precede the PERSISTED write",
    ).toBeGreaterThan(guardAt);
  });
});

describe("only buildPreviewHandle can mint the preview flag", () => {
  it("is the sole place `preview: true` is written", () => {
    // The flag's whole safety argument is "possession proves the ceiling is
    // empty". A second construction site would break that, silently.
    const broker = readFileSync(BROKER, "utf8");
    const sites = [...broker.matchAll(/preview:\s*true/g)];
    expect(sites.length).toBe(1);
    const fn = functionBody(broker, "export function buildPreviewHandle(");
    expect(fn).toContain("preview: true");
    expect(fn, "the ceiling must be constructed empty, never passed in").toContain(
      "declaredCapabilities: new Set<CapabilityId>()",
    );
    expect(fn).toContain("grants: new Set<CapabilityId>()");
  });
});
