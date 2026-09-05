//! FILENAME: app/src/api/scriptHost/__tests__/htmlInputConsentHonesty.test.ts
// PURPOSE: `ui.htmlInput` exists so that a surface which TAKES the user's clicks
//          never rides on `ui.html`'s promise to DRAW — and every sentence
//          written for it must say what is being taken.
// CONTEXT: `ui.html` reads "render sandboxed HTML inside the object's shape"
//          (capabilityIds.ts) and "render custom HTML UI" (capabilities.ts and
//          the two distribution prompts). Not one of those sentences says the
//          frame can also intercept pointer input — yet `render.setHitRegions`
//          rode on that id until M6b, and a rectangle it claims is pointer input
//          REMOVED FROM THE GRID: inside it, the user's click no longer selects
//          a cell, it reaches a distributed author's page. Consent text is a
//          promise, so the input half gets its own id and its own sentence,
//          exactly as `ui.pane` was split out of `ui.dialog`.
//
//          Mirror of paneConsentHonesty.test.ts, with the negative assertions
//          that matter here: no `ui.htmlInput` sentence may be a paraphrase of
//          `ui.html`'s (a sentence that only says "HTML" has not disclosed
//          anything new), and every prose sentence must name the CLICK.
//
//          THE LOCKSTEP IS THE POINT, not the prose. The nine exhaustive
//          `Record<CapabilityId, …>` maps are type-checked, so a missing entry
//          is a compile error — that half needs no test. What a compiler cannot
//          check is whether the entry SAYS anything, whether the Rust mirror
//          still agrees, and whether a gate reads the id at all (an id nothing
//          gates is consent theatre; scriptSurfaces.test.ts owns that one).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ALL_CAPABILITY_IDS } from "../capabilityIds";
import { RUST_MIRRORED_CAPABILITIES, describeCapability } from "../capabilities";
import { ALLOWLIST } from "../allowlist";
import { BROKER_AUTO_LOCAL_CAPABILITIES } from "../../scriptSurfaces";

const APP = path.resolve(__dirname, "../../../..");
const REPO = path.resolve(APP, "..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8");

/** The `"ui.htmlInput": "…"` sentence in one map, or null if the map lacks it. */
function inputSentence(src: string): string | null {
  const m = /"ui\.htmlInput":\s*\n?\s*"([^"]+)"/.exec(src);
  return m ? m[1] : null;
}

/** The `"ui.html": "…"` sentence in the same map — what must NOT be reused. */
function htmlSentence(src: string): string | null {
  const m = /"ui\.html":\s*\n?\s*"([^"]+)"/.exec(src);
  return m ? m[1] : null;
}

const PROSE_MAPS = [
  "extensions/Distribution/components/inspector/ScriptsSection.tsx",
  "extensions/Distribution/components/SubscribeDialog.tsx",
  "extensions/ScriptableObjects/index.ts",
];
const ICON_MAPS = [
  "extensions/Charts/components/ChartLibraryConsentDialog.tsx",
  "extensions/CustomFunctions/components/DistributedFunctionsConsentDialog.tsx",
  "extensions/ScriptableObjects/components/ScriptConsentDialog.tsx",
];
const LABEL_MAPS = [
  "extensions/ScriptableObjects/components/CodeInThisFilePanel.tsx",
  "extensions/Settings/components/ScriptSecurityPage.tsx",
];

describe("the id itself", () => {
  it("is LAST in ALL_CAPABILITY_IDS — the Rust mirror pins order", () => {
    expect(ALL_CAPABILITY_IDS[ALL_CAPABILITY_IDS.length - 1]).toBe("ui.htmlInput");
  });

  it("is NOT Rust-mirrored: the shims are host DOM, Rust never sees a click", () => {
    expect(RUST_MIRRORED_CAPABILITIES.has("ui.htmlInput" as never)).toBe(false);
  });

  it("is last in the core Rust array too, with the annotation bumped to match", () => {
    const rs = fs.readFileSync(path.join(REPO, "core/persistence/src/lib.rs"), "utf8");
    const m = /pub const KNOWN_CAPABILITY_IDS: \[&str; (\d+)\] = \[([\s\S]*?)\];/.exec(rs);
    expect(m, "KNOWN_CAPABILITY_IDS moved or was renamed").not.toBeNull();
    const ids = [...m![2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(Number(m![1]), "the [&str; N] annotation no longer matches the array").toBe(ids.length);
    expect(ids).toEqual([...ALL_CAPABILITY_IDS]);
    expect(ids[ids.length - 1]).toBe("ui.htmlInput");
  });

  it("is asserted NON-grantable in Rust, beside ui.pane and ui.html", () => {
    const rs = fs.readFileSync(
      path.join(REPO, "app/src-tauri/src/scripting/capability_store.rs"),
      "utf8",
    );
    expect(rs).toContain('assert!(!is_grantable("ui.htmlInput"));');
  });
});

describe("a gate actually reads it", () => {
  it("render.setHitRegions demands it — and render.setHtml still does not", () => {
    // The split is only real if the two doors ask different questions. If
    // setHitRegions drifted back onto ui.html the new id would be consent
    // theatre: shown in the prompt, granted, and gating nothing.
    expect(ALLOWLIST["render.setHitRegions"].capability).toBe("ui.htmlInput");
    expect(ALLOWLIST["render.setHtml"].capability).toBe("ui.html");
  });

  it("is auto-granted to LOCAL scripts, exactly like ui.html", () => {
    // The split exists to make the DISTRIBUTED consent honest, not to re-ask
    // the user about code they wrote themselves. A local script that had a
    // clickable frame before the split still has one; forgetting this half
    // would silently break every existing local shape app.
    expect(BROKER_AUTO_LOCAL_CAPABILITIES).toContain("ui.htmlInput");
    expect(BROKER_AUTO_LOCAL_CAPABILITIES).toContain("ui.html");
    const broker = read("src/api/scriptHost/broker.ts");
    expect(broker).toContain('grants.add("ui.htmlInput")');
    expect(broker).toContain('declaredCapabilities.add("ui.htmlInput")');
  });
});

// ===========================================================================
// The split is only real if EVERY host implements it
//
// `ui.htmlInput` was split out of `ui.html` on the premise that a frame granted
// only `ui.html` paints and cannot be clicked into. That was written for the
// on-grid host — frame permanently `pointer-events: none`, every pixel of input
// arriving through the shims `render.setHitRegions` creates — and it was FALSE
// on the Controls-pane card, whose iframe hardcoded `pointerEvents: "auto"`:
// the same script's same document took clicks, focus and keystrokes with the
// paint-only grant. Nothing watched that, because everything above this line
// watches the ID (its prose, its Rust mirror, its allowlist row) and an id is
// only worth what its hosts do.
//
// The rule below is deliberately mechanical, because the failure was a THIRD
// file nobody remembered was a host: every place that loads a script's HTML
// into an iframe must DECIDE about pointer input in the file, and only a file
// that consults the gated claim may decide anything but "none".
// ===========================================================================

/** Every non-test extension file that loads a document into an iframe. */
function scriptHtmlHosts(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // `_shared/scriptFrame` BUILDS the document; it hosts nothing and owns
        // no element, so it has no pointer-events decision to make.
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        if (entry.name === "_shared") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      // A JSX attribute (`srcDoc={…}`) or a DOM assignment (`el.srcdoc = …`).
      // Prose mentioning `srcdoc` in backticks does not match.
      if (/\bsrcDoc=\{|\bsrcdoc\s*=[^=]/.test(src)) {
        out.push(path.relative(APP, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(path.join(APP, "extensions"));
  return out;
}

/** The `{ … }` starting at `openIndex`, without its outer braces. */
function braceBody(src: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  return "";
}

/** The object literal a style binding names — `const previewFrameStyle = {…}`
 *  or the `iframe: {…}` row of a styles record — or "" when there is none. */
function styleObjectBody(src: string, name: string): string {
  const decl = new RegExp(`(?:const\\s+${name}\\b[^=;]*=|\\b${name}\\s*:)\\s*\\{`).exec(src);
  return decl ? braceBody(src, decl.index + decl[0].length - 1) : "";
}

/**
 * The pointer-events values THIS HOST'S FRAME gets — never one an unrelated
 * element elsewhere in the file gets, which is the whole reason this walks the
 * iframe's own style instead of grepping the file. Two shapes, one per host
 * idiom: a DOM host assigns `el.style.pointerEvents`, a React host passes a
 * `style={…}` expression, whose inline pairs are read directly and whose named
 * bindings (`styles.iframe`, `previewFrameStyle`) are resolved to their object
 * literals.
 */
function framePointerEventsValues(src: string): string[] {
  const values = [...src.matchAll(/\.style\.pointerEvents\s*=\s*"([a-z-]+)"/g)].map((m) => m[1]);
  for (const tag of src.matchAll(/<iframe\b[\s\S]*?\/>/g)) {
    const attr = /style=\{/.exec(tag[0]);
    if (!attr) continue;
    const expr = braceBody(tag[0], attr.index + attr[0].length - 1);
    for (const m of expr.matchAll(/pointerEvents\s*:\s*"([a-z-]+)"/g)) values.push(m[1]);
    // `styles.iframe` resolves through its last segment; a token that names no
    // object literal simply contributes nothing.
    for (const m of expr.matchAll(/\b[A-Za-z_$][\w$]*(?:\.([A-Za-z_$][\w$]*))?\b/g)) {
      const name = m[1] ?? m[0];
      const body = styleObjectBody(src, name);
      for (const p of body.matchAll(/pointerEvents\s*:\s*"([a-z-]+)"/g)) values.push(p[1]);
    }
  }
  return values;
}

describe("every host of a script's HTML honours the split", () => {
  it("finds all three of them — a scan that finds nothing guards nothing", () => {
    const hosts = scriptHtmlHosts();
    for (const known of [
      // On-grid overlay: hit-transparent forever, input via shims.
      "extensions/Controls/Shape/shapeRenderer.ts",
      // The Properties pane's Preview tab: a picture, with no bridge at all.
      "extensions/Controls/PropertiesPane/PropertiesPane.tsx",
      // The Controls-pane card: the one that took input on the paint grant.
      "extensions/ControlsPane/components/CustomControlHost.tsx",
    ]) {
      expect(hosts, `${known} is no longer discovered as an html host`).toContain(known);
    }
  });

  it("each one decides pointer-events, and only a gated claim buys 'auto'", () => {
    for (const rel of scriptHtmlHosts()) {
      const src = read(rel);
      const values = framePointerEventsValues(src);
      expect(
        values.length,
        `${rel} loads a script's HTML into an iframe and its FRAME says nothing about ` +
          `pointer events (an unrelated element elsewhere in the file does not count). ` +
          `The browser default is "auto", so the frame takes the user's clicks, focus and ` +
          `keystrokes on the strength of ui.html alone.`,
      ).toBeGreaterThan(0);
      if (values.every((v) => v === "none")) continue;
      // Anything else has to be earned. `render.setHitRegions` is the only door
      // in the object surface that costs ui.htmlInput, so consulting its
      // declaration is what "the user granted this" looks like from a host.
      expect(
        /SHAPE_HIT_REGIONS_EVENT|ShapeHitRegions|shapeHitDom/.test(src),
        `${rel} makes a script's frame interactive (${[...new Set(values)].join(", ")}) ` +
          `without ever consulting the hit-region claim that ui.htmlInput gates. ` +
          `ui.html promises drawing; a host that also takes input must read the grant.`,
      ).toBe(true);
    }
  });
});

/**
 * The `inert` argument of every `setScriptFrameInert(frame, …)` call in a host.
 * `"true"` is a frame that is never keyboard-reachable; anything else is a
 * decision the host computes, and a computed decision has to be the grant.
 */
function frameInertArguments(src: string): string[] {
  return [...src.matchAll(/setScriptFrameInert\([^;()]*?,\s*([^)]*)\)/g)].map((m) =>
    m[1].trim(),
  );
}

describe("every host also keeps the frame out of the tab order", () => {
  it("each one makes the decision, and only a gated claim puts the frame back in", () => {
    for (const rel of scriptHtmlHosts()) {
      const src = read(rel);
      const args = frameInertArguments(src);
      // `pointer-events` is a HIT-TESTING property: it stops the mouse and
      // leaves the frame exactly where it was in the sequential focus order, so
      // Tab still walks into the script's document and the next keystroke is
      // the script's. A host that decided only about pointers shipped half a
      // gate — which is how the finding's `<input type=password>` stayed
      // typeable on a card that had just been made hit-transparent.
      expect(
        args.length,
        `${rel} loads a script's HTML into an iframe and never makes it inert. ` +
          `Hit-transparency is the mouse only: the frame keeps its place in the tab ` +
          `order, so the user can Tab into the document and type into it on the ` +
          `strength of ui.html alone.`,
      ).toBeGreaterThan(0);
      if (args.every((a) => a === "true")) continue;
      expect(
        /SHAPE_HIT_REGIONS_EVENT|ShapeHitRegions|shapeHitDom/.test(src),
        `${rel} can make a script's frame keyboard-reachable (${[...new Set(args)].join(", ")}) ` +
          `without ever consulting the hit-region claim that ui.htmlInput gates. ` +
          `The keystrokes cost the same grant the clicks do.`,
      ).toBe(true);
    }
  });
});

describe("what the prompts say about it", () => {
  it("CAP_DESCRIPTION names the click, not the markup", () => {
    const s = describeCapability("ui.htmlInput" as never);
    expect(s).toMatch(/click/i);
    // The disclosure that makes it a separate decision: the grid stops getting
    // the click. A sentence that omits this describes a feature, not a cost.
    expect(s).toMatch(/instead of|rather than/i);
  });

  it("every prose map says CLICK, and none of them reuses the ui.html sentence", () => {
    for (const rel of PROSE_MAPS) {
      const src = read(rel);
      const sentence = inputSentence(src);
      expect(sentence, `${rel} has no ui.htmlInput sentence`).not.toBeNull();
      expect(sentence!, `${rel}: the ui.htmlInput sentence never mentions a click`).toMatch(
        /click/i,
      );
      expect(
        sentence!,
        `${rel}: the ui.htmlInput sentence is the ui.html sentence. Two ids that read the ` +
          `same are one id with extra steps — the user cannot decide differently about them.`,
      ).not.toBe(htmlSentence(src));
    }
  });

  it("has its own icon and its own label in every map that carries one", () => {
    for (const rel of [...ICON_MAPS, ...LABEL_MAPS]) {
      const src = read(rel);
      const mine = inputSentence(src);
      expect(mine, `${rel} has no ui.htmlInput entry`).not.toBeNull();
      expect(
        mine!,
        `${rel}: ui.htmlInput shares ui.html's glyph/label, so the consent list shows two ` +
          `identical-looking rows and the user cannot tell which one takes their clicks.`,
      ).not.toBe(htmlSentence(src));
    }
  });
});
