//! FILENAME: app/extensions/Controls/__tests__/srcdocBridgeCsp.test.ts
// PURPOSE: Pin the two facts that decide whether the `ui.html` srcdoc bridge
//          can execute in a SHIPPED build: (1) the bridge is an INLINE
//          <script> with no nonce and no hash, and the shipped shape template
//          additionally leans on INLINE `onclick=` attributes; (2) the CSP the
//          app ships grants inline script execution nowhere — no
//          'unsafe-inline', no nonce-, no sha-, no 'unsafe-hashes' in
//          `script-src` or its `default-src` fallback.
//          Both halves are read from the real files at test time, never
//          restated here, so neither can move without this file noticing.
// CONTEXT: WHAT THIS TEST IS NOT. It does NOT prove the bridge is dead — jsdom
//          enforces no CSP and runs no srcdoc document, so nothing under vitest
//          can execute the experiment. It proves the SHAPE of the collision:
//          an inline-only bridge against an inline-forbidding policy. The
//          execution question is settled in the running app by
//          `app/e2e/tests/csp-srcdoc-bridge.spec.ts`, which measures whether a
//          CSP is enforced at all before it believes its own green.
//
//          WHY IT MATTERS THAT THE TWO HALVES ARE PINNED TOGETHER. There are
//          two ways to make the M6 collision disappear, and only one of them is
//          a decision: serve app documents from an origin with their own policy
//          (the design's option), or quietly add 'unsafe-inline' to the app's
//          own `script-src` — which would re-open in-page script injection for
//          the WHOLE renderer to rescue one iframe. The second is what this
//          file exists to make loud. `read` the failure message before
//          "fixing" it.
//
//          THE DUPLICATION IS GONE (M6b). This file used to read the bridge out
//          of BOTH `shapeRenderer.ts` and `CustomControlHost.tsx` and assert the
//          two `<script>` blocks were byte-identical — the only thing keeping
//          two copies of one protocol from forking. They are now one module,
//          `extensions/_shared/scriptFrame/frameDocument.ts`, so the byte
//          comparison is replaced (NOT deleted — that would have removed the
//          only watcher of the protocol) by: the bridge is read from that one
//          module, and NEITHER host is allowed to build a document of its own
//          again.
//
//          ...AND THAT REPLACEMENT WAS SCOPED WRONG. It read two files while
//          FOUR spoke the protocol — the on-grid `shape:sendMessage` forwarder
//          and the hit-region pointer post each hand-rolled the host->frame
//          envelope with their own copy of the tag, and no guard read either
//          one. Both now post through `postToScriptFrame`, the document
//          interpolates the constant instead of spelling it, and the census
//          below asks "who spells this tag AT ALL" over app/extensions, app/src
//          and app/e2e — a question that cannot miss a route nobody thought of,
//          which is the failure mode the mount-consent gate already paid for.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SCRIPT_FRAME_MESSAGE_TAG } from "../../_shared/scriptFrame";

const REPO = path.resolve(__dirname, "../../../..");
const TAURI_CONF = path.join(REPO, "app/src-tauri/tauri.conf.json");
const SHAPE_RENDERER = path.join(REPO, "app/extensions/Controls/Shape/shapeRenderer.ts");
const PANE_HOST = path.join(
  REPO,
  "app/extensions/ControlsPane/components/CustomControlHost.tsx",
);
const TEMPLATE_CATALOG = path.join(
  REPO,
  "app/extensions/Controls/Shape/shapeTemplateCatalog.ts",
);
/** The ONE module both hosts now build their frame document with (M6b). */
const FRAME_DOCUMENT = path.join(
  REPO,
  "app/extensions/_shared/scriptFrame/frameDocument.ts",
);

/** Where to send the reader when a half moves. A guard whose failure does not
 *  name the decision is half a guard. */
const FIX =
  "FIX: do NOT reconcile these by adding 'unsafe-inline' (or a nonce/hash) to the app's " +
  "own script-src — that re-opens in-page script injection for the entire renderer to " +
  "rescue one iframe. The design's option is to serve app documents from a Rust custom " +
  "URI scheme with their own origin and their own CSP. See docs/design/typescript-forms.md " +
  "§14 M6 and docs/design/open-items.md §2.ab.";

// ---------------------------------------------------------------------------
// The shipped policy
// ---------------------------------------------------------------------------

interface TauriConf {
  app: { security: { csp: string; devCsp: string } };
}

const conf = JSON.parse(fs.readFileSync(TAURI_CONF, "utf8")) as TauriConf;

/**
 * Split a CSP string into directive -> source list. Directive names are
 * ASCII-case-insensitive per CSP3, so they are lowercased; source expressions
 * are NOT (a base64 nonce is case-sensitive), so they are kept verbatim.
 */
function parseCsp(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of csp.split(";")) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    out.set(parts[0].toLowerCase(), parts.slice(1));
  }
  return out;
}

/**
 * The source list that governs script execution: `script-src` when present,
 * otherwise the `default-src` fallback. `script-src-elem` is checked by the
 * caller separately — it would override `script-src` for <script> ELEMENTS,
 * so a policy that grew one and left `script-src` locked would be a false
 * negative here.
 */
function scriptSources(csp: string): string[] {
  const map = parseCsp(csp);
  return map.get("script-src") ?? map.get("default-src") ?? [];
}

/** Every source expression that would let an inline <script> run. */
function inlineGrants(sources: string[]): string[] {
  return sources.filter(
    (s) =>
      s === "'unsafe-inline'" ||
      s === "'unsafe-hashes'" ||
      s.startsWith("'nonce-") ||
      s.startsWith("'sha256-") ||
      s.startsWith("'sha384-") ||
      s.startsWith("'sha512-"),
  );
}

describe("the shipped CSP grants inline script execution nowhere", () => {
  // Both policies are asserted, and the DEV one matters for a reason that is
  // not obvious: `tauri dev` on desktop loads the document straight from the
  // Vite devUrl (tauri 2.9.5, `PROXY_DEV_SERVER = cfg!(all(dev, mobile))`), so
  // `devCsp` is never actually applied there. Pinning it anyway keeps the two
  // policies honest with each other, so that the day dev DOES enforce a policy
  // it is not a weaker one that would hide this collision.
  for (const [name, csp] of [
    ["csp", conf.app.security.csp],
    ["devCsp", conf.app.security.devCsp],
  ] as const) {
    it(`${name}: script-src carries no inline grant`, () => {
      const map = parseCsp(csp);
      const sources = scriptSources(csp);
      expect(
        sources.length,
        `${name} governs script execution through neither script-src nor default-src. ${FIX}`,
      ).toBeGreaterThan(0);
      expect(
        inlineGrants(sources),
        `${name} now permits inline script execution. ${FIX}`,
      ).toEqual([]);
      // A `script-src-elem` would override `script-src` for <script> elements
      // specifically — exactly the narrow escape hatch someone reaching for a
      // quick fix would add.
      expect(
        inlineGrants(map.get("script-src-elem") ?? []),
        `${name} now permits inline <script> ELEMENTS through script-src-elem. ${FIX}`,
      ).toEqual([]);
      // `script-src-attr` governs inline event-handler attributes (the shape
      // template's `onclick=`). Absent, it falls back to script-src, which is
      // already asserted above.
      expect(
        inlineGrants(map.get("script-src-attr") ?? []),
        `${name} now permits inline event handlers through script-src-attr. ${FIX}`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// The bridge, read from the two files that build it
// ---------------------------------------------------------------------------

/** The `<script>…</script>` block the shared builder injects into its document. */
function injectedScriptBlock(file: string): string {
  const src = fs.readFileSync(file, "utf8");
  const marker = "export function buildScriptFrameDocument(";
  const start = src.indexOf(marker);
  expect(
    start,
    `${path.basename(file)} no longer declares buildScriptFrameDocument`,
  ).toBeGreaterThan(-1);
  const block = /<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/.exec(src.slice(start));
  expect(
    block,
    `${path.basename(file)}'s buildScriptFrameDocument injects no <script> block`,
  ).not.toBeNull();
  return block![0];
}

const bridge = injectedScriptBlock(FRAME_DOCUMENT);

describe("the ui.html bridge is inline script, and only inline script", () => {
  it("the shared builder injects a bare <script> — no nonce, no src, no type=module", () => {
    const openTag = /<script([^>]*)>/.exec(bridge)![1];
    expect(
      openTag.trim(),
      `frameDocument.ts's bridge <script> grew attributes. If that is a nonce, note that a ` +
        `srcdoc child inherits the PARENT's policy container, so the parent's nonce would have ` +
        `to be threaded through — and the template's inline onclick= handlers are not covered ` +
        `by a nonce at all. ${FIX}`,
    ).toBe("");
  });

  it("the bridge body is the postMessage protocol the hosts listen for", () => {
    expect(bridge, "the bridge no longer defines window.calcula").toContain("window.calcula");
    expect(bridge, "the bridge no longer exposes sendMessage").toContain("sendMessage");
    expect(bridge, "the bridge no longer posts to the parent").toContain("parent.postMessage");
    // BOTH tags are INTERPOLATED from SCRIPT_FRAME_MESSAGE_TAG, never typed out.
    // They were typed out for a milestone, a hundred and forty lines below the
    // constant whose own docstring called itself their only spelling, so a
    // rename of the constant would have moved the router and left the document
    // behind — every message from every frame dropped, in silence, green.
    expect(bridge, "the bridge stopped interpolating its outbound tag").toContain(
      "source: ${tagLiteral}",
    );
    expect(bridge, "the bridge stopped interpolating its inbound tag").toContain(
      "e.data.target === ${tagLiteral}",
    );
    expect(
      bridge.includes(`'${SCRIPT_FRAME_MESSAGE_TAG}'`) ||
        bridge.includes(`"${SCRIPT_FRAME_MESSAGE_TAG}"`),
      "the bridge spells the protocol tag as a raw literal again. It is a value with " +
        "FOUR readers (the document's poster, the document's listener, the host router and " +
        "the host poster); the one that is a copy is the one that goes stale in silence.",
    ).toBe(false);
  });

  it("neither host builds a document of its own any more", () => {
    // The replacement for the byte-identity assertion this file used to make.
    // Both hosts import the one builder; a host that grows its own document
    // string again has re-created the fork, and a script's HTML would stop
    // being guaranteed to work unchanged in both.
    for (const [name, file] of [
      ["shapeRenderer.ts", SHAPE_RENDERER],
      ["CustomControlHost.tsx", PANE_HOST],
    ] as const) {
      const src = fs.readFileSync(file, "utf8");
      // `buildScriptFrameContent` since BUG-0113: the bridge moved out of the
      // hosts' documents entirely and is served from Rust with its own CSP, so
      // what a host builds now is the CONTENT it pushes. The property under
      // test is unchanged — one shared builder, not a per-host one.
      expect(
        src,
        `${name} no longer imports the shared script-frame builder — it has forked the protocol.`,
      ).toContain("buildScriptFrameContent");
      expect(
        /<script[^>]*>/.test(src),
        `${name} builds a <script> block of its own again. The bridge is ONE module ` +
          `(extensions/_shared/scriptFrame/frameDocument.ts); a second copy forks the protocol ` +
          `silently, which is exactly what M6b removed.`,
      ).toBe(false);
    }
  });

  it("the protocol tag is spelled in ONE directory, and nowhere else in the app", () => {
    // WHY THIS IS A CENSUS AND NOT TWO MORE `toContain`s. The test above is
    // titled "neither host builds a document of its own", and for a milestone it
    // read exactly two files while FOUR spoke the protocol: the on-grid
    // `shape:sendMessage` forwarder (Controls/index.ts) and the hit-region
    // pointer post (Controls/Shape/shapeHitRegions.ts) each hand-rolled the
    // host->frame envelope with their own copy of the tag, and no guard read
    // either file. That is the mount-consent defect's shape — a gate that
    // answers for a fraction of the routes — so the question asked here is
    // "who spells this at all", which cannot miss a route it did not think of.
    //
    // Both posters now go through `postToScriptFrame`; the frame document
    // interpolates the constant; and this refuses the value's text outside the
    // module that owns it.
    const roots = ["app/extensions", "app/src", "app/e2e"];
    const skipDirs = new Set(["node_modules", "dist", "target", "__snapshots__"]);
    /** The one directory allowed to spell it: the constant, its docstrings and
     *  the header notes that quote the wire envelope. */
    const owner = path.join(REPO, "app/extensions/_shared/scriptFrame");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name) || full === owner) continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (fs.readFileSync(full, "utf8").includes(SCRIPT_FRAME_MESSAGE_TAG)) {
          offenders.push(path.relative(REPO, full).replace(/\\/g, "/"));
        }
      }
    };
    for (const root of roots) walk(path.join(REPO, root));

    expect(
      offenders,
      "these files spell the script-frame protocol tag themselves. A poster and a listener " +
        "that stop agreeing fail SILENTLY — the message is simply never delivered, with no " +
        "error at either end. Import SCRIPT_FRAME_MESSAGE_TAG, or post through " +
        "postToScriptFrame, from extensions/_shared/scriptFrame instead.",
    ).toEqual([]);
  });

  it("the shipped counter template drives the bridge from an inline onclick attribute", () => {
    // This is the half a nonce could not rescue even in principle: an inline
    // event-handler attribute needs 'unsafe-inline' (or 'unsafe-hashes' plus a
    // hash) in script-src-attr / script-src. It is not a hypothetical — it is
    // in the template a user gets from the shape template catalog, and in the
    // default scaffold every new custom pane control is created with.
    const catalog = fs.readFileSync(TEMPLATE_CATALOG, "utf8");
    expect(
      catalog,
      "shapeTemplateCatalog.ts no longer ships an inline onclick= that calls the bridge. If " +
        "the templates were migrated to addEventListener, say so in the M6 ledger row — the " +
        "inline-handler half of the CSP collision would be gone and only the <script> half " +
        "would remain.",
    ).toContain('onclick="calcula.sendMessage(');
    const scaffold = fs.readFileSync(PANE_HOST, "utf8");
    expect(
      scaffold,
      "CustomControlHost.tsx's new-control scaffold no longer uses an inline onclick=.",
    ).toContain('onclick="calcula.sendMessage(');
  });
});
