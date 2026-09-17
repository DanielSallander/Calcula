//! FILENAME: tests/eval/lib/evalSuite.test.mjs
// PURPOSE: The eval suite pins every knob of every runner, `npm run eval:*`
//          reaches every surface, an override REPLACES a pin rather than
//          following it, and the server the suite starts is the product's.
// CONTEXT: `suite.mjs` exists because every AI number this project recorded
//          before 2026-09-17 came from a hand-typed command whose flags decided
//          the number. That only stays fixed if the pins stay COMPLETE: a knob
//          added to a runner and not pinned here would ride on its default,
//          and a default is exactly the thing that changes quietly. So this
//          test reads each runner's `arg("…")` calls and holds the pins to
//          them in both directions. Textual, like `evalKnobs.test.mjs`, and
//          for the same reason: running a runner needs a model server.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SURFACES, SUPPLIED_FLAGS, OUTPUT_FLAGS, CONTEXT_TOKENS, serverArgs, surfaceById,
  parseCli, buildArgv, coerce, outputBucket, modelSlug, artifactFileName, headline,
} from "../suite.mjs";
import { EVAL_DIR, codeOf, flagsIn } from "./runnerFlags.mjs";

/** Every runner in the directory: `run-*.mjs` that is not the suite or a split module. */
const RUNNER_FILES = readdirSync(EVAL_DIR).filter(
  (f) => /^run-.*\.mjs$/.test(f) && f !== "run-suite.mjs" && f !== "run-intent-eval-split.mjs",
);

describe("the suite covers every runner", () => {
  it("has exactly one entry per runner file, and no entry without a file", () => {
    expect([...SURFACES.map((s) => s.runner)].sort()).toEqual([...RUNNER_FILES].sort());
    expect(new Set(SURFACES.map((s) => s.id)).size).toBe(SURFACES.length);
  });

  it("pins every knob each runner reads, and nothing it does not read", () => {
    for (const s of SURFACES) {
      const flags = flagsIn(codeOf(s.runner)).filter((f) => !SUPPLIED_FLAGS.includes(f) && !OUTPUT_FLAGS.includes(f));
      const pinned = Object.keys(s.pinned);
      expect(
        flags.filter((f) => !pinned.includes(f)),
        `${s.id}: ${s.runner} reads these knobs and the suite does not pin them — they would ride on a default`,
      ).toEqual([]);
      expect(
        pinned.filter((k) => !flags.includes(k)),
        `${s.id}: the suite pins flags ${s.runner} does not read`,
      ).toEqual([]);
    }
  });

  it("supplies --model to exactly the runners that read it", () => {
    for (const s of SURFACES) {
      expect(flagsIn(codeOf(s.runner)).includes("model"), s.id).toBe(s.takesModel);
    }
  });

  it("shapes --base-url the way each runner actually uses it", () => {
    // The chat runners append `/chat/completions` to what they are given;
    // `/infill` lives at the server root; the intents runner talks to nothing.
    for (const s of SURFACES) {
      const src = codeOf(s.runner);
      const expected = src.includes("/chat/completions") ? "v1" : src.includes("/infill") ? "root" : null;
      expect(s.endpoint, s.id).toBe(expected);
      expect(s.needsModel, s.id).toBe(expected !== null);
    }
  });
});

describe("package.json", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

  it("has eval:<surface> for every surface and eval:all, every one through run-suite", () => {
    for (const s of SURFACES) {
      expect(pkg.scripts[`eval:${s.id}`], `eval:${s.id}`).toBe(`node ../tests/eval/run-suite.mjs ${s.id}`);
    }
    expect(pkg.scripts["eval:all"]).toBe("node ../tests/eval/run-suite.mjs all");
    // ...and no eval:* that bypasses the suite.
    const evalScripts = Object.keys(pkg.scripts).filter((k) => k.startsWith("eval:"));
    expect([...evalScripts].sort()).toEqual(["eval:all", ...SURFACES.map((s) => `eval:${s.id}`)].sort());
  });
});

describe("buildArgv", () => {
  const formulas = surfaceById("formulas");

  it("passes every pin once, and an override REPLACES its pin rather than following it", () => {
    // The runners read the FIRST occurrence of a flag; an appended override
    // would be a silent no-op that still labelled the run as overridden.
    const { argv, applied } = buildArgv(formulas, {
      runnerPath: "r.mjs",
      model: "m",
      baseUrl: "http://127.0.0.1:5",
      json: "x.json",
      overrides: { retrieval: "0" },
    });
    const flags = argv.filter((a) => a.startsWith("--"));
    expect(new Set(flags).size, "a flag appears exactly once").toBe(flags.length);
    expect(argv[argv.indexOf("--retrieval") + 1]).toBe("0");
    expect(applied).toEqual(["retrieval"]);
    expect(argv[argv.indexOf("--grammar") + 1]).toBe("on");
    expect(argv[argv.indexOf("--max-tokens") + 1]).toBe("600");
    expect(argv, "an empty-string pin is the runner's default and cannot be passed").not.toContain("--tag");
    expect(argv[argv.indexOf("--model") + 1]).toBe("m");
    expect(argv[argv.indexOf("--base-url") + 1]).toBe("http://127.0.0.1:5/v1");
    expect(argv.slice(-2)).toEqual(["--json", "x.json"]);
  });

  it("omits a false boolean pin and passes a true one bare", () => {
    const scripts = surfaceById("scripts");
    expect(buildArgv(scripts, { runnerPath: "r" }).argv).not.toContain("--canary");
    const { argv } = buildArgv(scripts, { runnerPath: "r", overrides: { canary: true } });
    const at = argv.indexOf("--canary");
    expect(at).toBeGreaterThan(0);
    expect(argv[at + 1] === undefined || argv[at + 1].startsWith("--"), "bare, no value").toBe(true);
  });

  it("types an override like its pin and refuses a nonsense one", () => {
    expect(() => buildArgv(formulas, { runnerPath: "r", overrides: { retrieval: "three" } })).toThrow(/number/);
    expect(coerce(false, "on", "x")).toBe(true);
    expect(coerce(false, "off", "x")).toBe(false);
    expect(() => coerce(false, "maybe", "x")).toThrow(/on\|off/);
    expect(coerce(3, "5", "x")).toBe(5);
    expect(() => coerce("on", true, "x")).toThrow(/needs a value/);
  });

  it("reports an override for a knob the runner does not read instead of passing it", () => {
    const { argv, ignored } = buildArgv(surfaceById("intents"), { runnerPath: "r", overrides: { retrieval: "0" } });
    expect(ignored).toEqual(["retrieval"]);
    expect(argv).not.toContain("--retrieval");
  });

  it("refuses a supplied flag as an override", () => {
    expect(() => buildArgv(formulas, { runnerPath: "r", overrides: { json: "y.json" } })).toThrow(/set by the suite/);
  });

  it("gives the FIM runner the server ROOT and no --model", () => {
    const { argv } = buildArgv(surfaceById("macro-fim"), { runnerPath: "r", model: "m", baseUrl: "http://127.0.0.1:5/" });
    expect(argv).not.toContain("--model");
    expect(argv[argv.indexOf("--base-url") + 1]).toBe("http://127.0.0.1:5");
  });
});

describe("parseCli", () => {
  it("separates the suite's own options from knob overrides", () => {
    const r = parseCli(["all", "--model", "g.gguf", "--only", "formulas,scripts", "--dry-run", "--limit", "5", "--canary"]);
    expect(r.target).toBe("all");
    expect(r.options.model).toBe("g.gguf");
    expect(r.options.only).toEqual(["formulas", "scripts"]);
    expect(r.options.dryRun).toBe(true);
    expect(r.overrides).toEqual({ limit: "5", canary: true });
  });

  it("refuses two surfaces and a valueless option", () => {
    expect(() => parseCli(["formulas", "scripts"])).toThrow(/one surface/);
    expect(() => parseCli(["all", "--model"])).toThrow(/needs a value/);
  });
});

describe("the server the suite starts", () => {
  it("is started on exactly the product's flags — engine_args in ai/runtime.rs", () => {
    const rs = readFileSync(join(process.cwd(), "src-tauri", "src", "ai", "runtime.rs"), "utf8");
    const ctx = /pub const CONTEXT_TOKENS: u32 = (\d+);/.exec(rs);
    expect(ctx, "CONTEXT_TOKENS in runtime.rs").not.toBeNull();
    expect(CONTEXT_TOKENS).toBe(Number(ctx[1]));
    const body = /pub fn engine_args\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(rs);
    expect(body, "engine_args in runtime.rs").not.toBeNull();
    const literals = Array.from(body[1].matchAll(/"([^"]+)"\.into\(\)/g), (m) => m[1]);
    expect(literals.length).toBeGreaterThan(5);
    const js = serverArgs("MODEL", 4242).filter((a) => a !== "MODEL" && a !== "4242" && a !== String(CONTEXT_TOKENS));
    expect(js).toEqual(literals);
  });
});

describe("where the evidence goes, and what it is called", () => {
  it("keeps a pinned run, demotes an overridden one, and --keep restores it", () => {
    expect(outputBucket({ overrides: {} })).toBe("runs");
    expect(outputBucket({ overrides: { limit: "5" } })).toBe("out");
    expect(outputBucket({ overrides: { limit: "5" }, keep: true })).toBe("runs");
  });

  it("names artifacts the way the retained bake-off files are named", () => {
    expect(artifactFileName({ date: "2026-09-17", surfaceId: "formulas", slug: "qwen" })).toBe("2026-09-17--formulas--qwen.json");
    expect(artifactFileName({ date: "2026-09-17", surfaceId: "formulas", slug: "qwen", label: "granite-1b" })).toBe(
      "2026-09-17--formulas--qwen--granite-1b.json",
    );
    expect(artifactFileName({ date: "2026-09-17", surfaceId: "all", slug: "qwen", time: "1432" })).toBe("2026-09-17--all--qwen--1432.json");
  });

  it("slugs a model by its file stem", () => {
    expect(modelSlug("C:\\x\\Granite 4.0-1b-Q4_K_M.gguf")).toBe("granite-4.0-1b-q4_k_m");
    expect(modelSlug("qwen2.5-coder-1.5b-instruct-q4_k_m")).toBe("qwen2.5-coder-1.5b-instruct-q4_k_m");
  });
});

describe("headline", () => {
  it("reads every surface's own summary shape", () => {
    expect(headline("intents", { summary: { all: { macro: 0.989, correct: 213, n: 214, decisivePrecision: 1 } } })).toContain("213/214");
    expect(headline("formulas", { summary: { passed: 61, ran: 181, passRate: 0.337, medianMs: 6943, truncatedReplies: 9 } })).toContain("61/181");
    expect(headline("design-queries", { summary: { passed: 24, ran: 122, passRate: 0.2, compiled: 120, medianMs: 4249, truncated: 0 } })).toContain("24/122");
    expect(headline("scripts", { summary: { passed: 3, total: 37, meanScore: 0.5, truncatedReplies: 1 } })).toContain("3/37");
    expect(headline("narration", { summary: { passed: 1, ran: 5, inventedNumbers: 5, medianMs: 31691, gatePassed: false } })).toContain("gate FAIL");
    expect(headline("next-edit", { summary: { exact: 0, prefixTasks: 80, rulesOnly: 19, medianMs: 676, gatePassed: false } })).toContain("exact 0/80");
    expect(headline("macro-fim", { summary: { exact: 25, ran: 141, exactRate: 0.177, medianMs: 1033, gatePassed: false } })).toContain("25/141");
    expect(headline("formulas", null)).toBe("no artifact");
  });
});
