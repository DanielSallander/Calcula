//! FILENAME: app/e2e/__tests__/cspProbePlacement.test.ts
// PURPOSE: Keep a spec that measures the SHIPPED build's CSP out of the suite
//          that launches `cargo tauri dev` -- and keep its run-time gate wired,
//          so the one project that does run it cannot render a verdict about a
//          build that delivers no policy at all.
//
// CONTEXT: `e2e/tests/csp-srcdoc-bridge.spec.ts` shipped inside the `functional`
//          project, which is what `npm run e2e` and .github/workflows/
//          e2e-nightly.yml drive. That project launches `cargo tauri dev`, and
//          on Windows desktop `tauri dev` enforces NO CSP: the webview goes
//          straight to `build.devUrl` because the dev-server proxy is compiled
//          out on desktop, and the only code in tauri 2.9.5 that sets a
//          Content-Security-Policy header is the `tauri://` asset protocol. So
//          the spec's first assertion (`mainInlineRan` must be false) failed on
//          every run, and its second and third (the bridge boots, the gesture
//          arrives) are the very findings M6a documents as FALSE until the
//          custom-URI-scheme route lands. Three mutually unsatisfiable
//          assertions, in the always-run project: a permanent red for a cause
//          nobody can act on, which is exactly how a suite acquires a
//          known-failures list. After that, the day someone adds
//          'unsafe-inline' to script-src and the spec turns GREEN for the wrong
//          reason passes unnoticed -- the regression it exists to catch, lost to
//          the noise it was making.
//
//          This file pins both halves of the repair. The placement half is
//          computed, not asserted as prose: the config's project blocks are
//          parsed and the glob semantics applied, so it is the actual collection
//          decision that is checked. The gate half is a source pin plus real
//          unit tests of the classifier, because a gate that classifies wrongly
//          is worse than no gate -- it silences a measurement while looking
//          like it ran.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyDocumentSource, readConfiguredDevUrl } from "../helpers/buildFlavor";

const APP_ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");

/** The spec under discussion, as a path relative to the app root. */
const PROBE_SPEC = "e2e/tests/csp-srcdoc-bridge.spec.ts";

// ---------------------------------------------------------------------------
// Reading the playwright config the way playwright reads it.
// ---------------------------------------------------------------------------

/**
 * Strip `//` and block comments WITHOUT touching the ones inside string
 * literals. A naive line-comment strip eats `"http://..."`, and this config is
 * full of prose about URLs; brace-matching over the wreckage would then split
 * the project list in the wrong place and the guard would silently be checking
 * something else.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

interface ProjectBlock {
  name: string;
  testDir: string;
  testMatch: string;
  testIgnore: string[];
}

/** The `projects: [...]` entries of playwright.config.ts, one object each. */
function parseProjects(configSrc: string): ProjectBlock[] {
  const src = stripComments(configSrc);
  const start = src.indexOf("projects: [");
  if (start < 0) throw new Error("playwright.config.ts declares no projects array");
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("[", start); i < src.length; i += 1) {
    if (src[i] === "[") depth += 1;
    else if (src[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("playwright.config.ts's projects array is unterminated");
  const body = src.slice(src.indexOf("[", start) + 1, end);

  const blocks: string[] = [];
  let braces = 0;
  let blockStart = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "{") {
      if (braces === 0) blockStart = i;
      braces += 1;
    } else if (body[i] === "}") {
      braces -= 1;
      if (braces === 0 && blockStart >= 0) blocks.push(body.slice(blockStart, i + 1));
    }
  }

  return blocks.map((block) => {
    const field = (key: string): string | null => {
      const m = new RegExp(`${key}:\\s*"([^"]+)"`).exec(block);
      return m ? m[1] : null;
    };
    const name = field("name");
    const testDir = field("testDir");
    const testMatch = field("testMatch");
    if (!name || !testDir || !testMatch) {
      throw new Error(
        `a project block is missing name/testDir/testMatch, so this guard cannot compute what ` +
          `it collects and refuses to guess: ${block.slice(0, 120)}`,
      );
    }
    const ignoreRaw = /testIgnore:\s*(\[[\s\S]*?\]|"[^"]*")/.exec(block);
    const testIgnore = ignoreRaw
      ? Array.from(ignoreRaw[1].matchAll(/"([^"]+)"/g)).map((m) => m[1])
      : [];
    return { name, testDir: testDir.replace(/^\.\//, ""), testMatch, testIgnore };
  });
}

/**
 * The glob forms this config actually uses (`**\/x.spec.ts`, `**\/*.spec.ts`).
 * Anything else THROWS rather than being approximated -- a matcher that quietly
 * mis-reads a pattern would report a collection decision the runner does not
 * make.
 */
function globToRegExp(glob: string): RegExp {
  if (/[?{}[\]!]/.test(glob)) {
    throw new Error(`this guard's matcher does not implement the glob "${glob}"`);
  }
  const parts = glob
    .split("**/")
    .map((part) => part.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
  return new RegExp(`^${parts.join("(?:.*/)?")}$`);
}

/** Does `project` collect `file` (a path relative to the app root)? */
function collects(project: ProjectBlock, file: string): boolean {
  if (!file.startsWith(`${project.testDir}/`)) return false;
  const relative = file.slice(project.testDir.length + 1);
  const matches = (pattern: string): boolean =>
    globToRegExp(pattern).test(relative) || globToRegExp(pattern).test(file);
  if (!matches(project.testMatch)) return false;
  return !project.testIgnore.some(matches);
}

/** The project name `npm run e2e` -- the nightly sweep -- drives. */
function nightlyProjectName(): string {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const m = /--project=([\w-]+)/.exec(pkg.scripts.e2e ?? "");
  if (!m) throw new Error('package.json\'s "e2e" script names no --project');
  return m[1];
}

// ---------------------------------------------------------------------------

describe("the shipped-CSP probe is not collected by the suite that launches tauri dev", () => {
  const projects = parseProjects(read("playwright.config.ts"));
  const nightly = nightlyProjectName();

  it("the nightly workflow really is the project this guard is about", () => {
    // If the nightly run ever stops going through `npm run e2e`, the assertion
    // below is measuring a project nobody runs unattended.
    const workflow = readFileSync(
      join(APP_ROOT, "..", ".github", "workflows", "e2e-nightly.yml"),
      "utf8",
    );
    expect(workflow).toContain("npm run e2e");
    expect(nightly).toBe("functional");
  });

  it("the nightly project does not collect it", () => {
    const project = projects.find((p) => p.name === nightly);
    expect(project, `playwright.config.ts declares no "${nightly}" project`).toBeDefined();
    expect(
      collects(project!, PROBE_SPEC),
      `The "${nightly}" project collects ${PROBE_SPEC}, and that project launches ` +
        "`cargo tauri dev` — a build that delivers no CSP at all on Windows desktop. The spec's " +
        "three assertions cannot all hold there, so every nightly run would report a failure " +
        "nobody can act on until the custom-URI-scheme route lands. Carve it out with a " +
        "testIgnore entry and run it from the `platform` project.",
    ).toBe(false);
  });

  it("exactly one project does collect it, so it is invocable rather than orphaned", () => {
    const owners = projects.filter((p) => collects(p, PROBE_SPEC)).map((p) => p.name);
    expect(
      owners,
      "a measurement no project collects is deleted code with a filename: it can never be run " +
        "again, and nothing says so.",
    ).toEqual(["platform"]);
  });

  it("that project is reachable by name from package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const scripts = Object.values(pkg.scripts).join("\n");
    expect(scripts).toContain("--project=platform");
    // Against a dev build the gate below skips, so the script that answers the
    // M6a question is the MANUAL one, pointed at an already-running bundled app.
    expect(pkg.scripts["e2e:platform:manual"]).toContain("E2E_MANUAL=1");
  });

  it("the functional carve-out still names state-consistency too", () => {
    // The testIgnore went from one string to a list in the same edit. Dropping
    // the older entry while adding the new one would put the 75-action random
    // walk back into a 30s-timeout suite, silently.
    const project = projects.find((p) => p.name === nightly)!;
    expect(project.testIgnore).toContain("**/state-consistency.spec.ts");
  });
});

describe("the probe refuses to render a CSP verdict in a build that enforces none", () => {
  it("classifies the dev server this repo configures as not measurable", () => {
    const devUrl = readConfiguredDevUrl();
    expect(devUrl, "src-tauri/tauri.conf.json declares no build.devUrl").toBeTruthy();
    const verdict = classifyDocumentSource(`${devUrl}/index.html`, devUrl);
    expect(verdict.source).toBe("dev-server");
    expect(verdict.matchesConfiguredDevUrl).toBe(true);
    expect(
      verdict.cspVerdictMeaningful,
      "The document served by `tauri dev` was classified as measurable, so the probe would " +
        "report a CSP verdict about a build that delivers no CSP — the exact vacuous result " +
        "this gate exists to refuse.",
    ).toBe(false);
    expect(verdict.reason).toContain("BUNDLED build");
  });

  it("recognises a dev server that moved port, rather than calling it unknown", () => {
    const verdict = classifyDocumentSource("http://localhost:5199/index.html", "http://localhost:5173");
    expect(verdict.source).toBe("dev-server");
    expect(verdict.matchesConfiguredDevUrl).toBe(false);
    expect(verdict.cspVerdictMeaningful).toBe(false);
  });

  it("classifies the tauri asset protocol as measurable, in both spellings", () => {
    for (const url of ["http://tauri.localhost/index.html", "tauri://localhost/index.html"]) {
      const verdict = classifyDocumentSource(url, "http://localhost:5173");
      expect(verdict.source, url).toBe("asset-protocol");
      expect(verdict.cspVerdictMeaningful, url).toBe(true);
    }
  });

  it("MEASURES anything it does not recognise instead of excusing it", () => {
    // The direction of the default is the whole safety property: a silenced
    // security measurement is indistinguishable from a passing one.
    for (const url of ["https://example.invalid/index.html", "not a url at all", ""]) {
      const verdict = classifyDocumentSource(url, "http://localhost:5173");
      expect(verdict.source, url).toBe("unrecognised");
      expect(verdict.cspVerdictMeaningful, url).toBe(true);
    }
  });
});

describe("the gate is wired into the spec", () => {
  const spec = read(PROBE_SPEC);

  it("reads its build from the shared classifier", () => {
    expect(spec).toContain('from "../helpers/buildFlavor"');
    expect(spec).toContain("classifyDocumentSource(");
    expect(spec).toContain("readConfiguredDevUrl()");
  });

  it("skips on the classifier's verdict", () => {
    expect(
      /test\.skip\(!flavor\.cspVerdictMeaningful, flavor\.reason\)/.test(spec),
      "The spec no longer skips on the build classification, so `npm run e2e:platform` (which " +
        "launches tauri dev like every other project) would report the unprotected build's " +
        "answer as if it were the shipped one.",
    ).toBe(true);
  });

  it("keeps its observations — the gate replaces none of them", () => {
    // The gate is about WHICH BUILD, never about what was observed in it.
    //
    // These names changed on 2026-09-13, when BUG-0113 was fixed and MEASURED.
    // The spec used to probe the SRCDOC bridge and was expected to fail; that
    // half is retired, because a test that can only ever fail is how a suite
    // acquires a known-failures list — and once it has one, the day someone
    // adds 'unsafe-inline' to script-src and it turns green for the wrong
    // reason goes unnoticed. `srcdocBridgeCsp.test.ts` pins the app's policy
    // against exactly that, and it is a unit test rather than a build-gated
    // one, so it runs on every commit.
    //
    // What must still be ASSERTED rather than merely logged, because each one
    // is a different way the loader route can be broken while looking fine:
    //   - `ready`      the custom scheme served the frame AND its inline
    //                  <script> executed under the frame's own CSP. This is the
    //                  one that catches the wry ICoreWebView2_22 iframe floor.
    //   - `received`   an INLINE onclick= reached the host — the shape no nonce
    //                  could ever rescue, and the reason the route exists.
    //   - `identityOk` the message came from this frame's own window, so the
    //                  host router would accept it in the product.
    expect(spec).toContain("beforeClick.ready");
    expect(spec).toContain("result.received");
    expect(spec).toContain("result.identityOk");
  });
});
