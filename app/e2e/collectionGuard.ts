//! FILENAME: app/e2e/collectionGuard.ts
// PURPOSE: FAIL any Playwright run whose collected test set disagrees with what
//          `playwright test --list` reports for the same filter -- loudly, naming
//          the missing files -- instead of letting the run report a green number
//          for a suite it quietly did not run.
//
// WHY THIS EXISTS (docs/design/open-decisions-2026-08.md §15e, finding 2).
// A `--project=journey` pass on 2026-08-13 printed "Running 134 tests" while
// `--list` said 143 for the same filter, then reported a clean
// `133 passed / 1 skipped`. The nine missing tests included the four the run
// existed to prove. The shortfall was never explained; the check that catches
// it -- comparing the run's own collection against `--list` -- was written down
// as "costs nothing" and this file is that check, implemented rather than
// remembered. A green number for a suite that silently dropped tests is worse
// than a red one: it certifies coverage that did not happen.
//
// HOW IT WORKS
//   1. `onBegin` receives the run's own collected suite -- the exact population
//      behind the "Running N tests" header -- and records one identity per test
//      (project :: file :: title path).
//   2. `onEnd` spawns `playwright test <same filter args> --list
//      --reporter=json` (measured at ~4s; `--list` does NOT run global-setup,
//      so no app is launched) and flattens the listing to the same identities.
//   3. The two multisets must be EQUAL. Any test present in the listing but not
//      collected ("missing"), or collected but not listed ("phantom"), fails
//      the run via onEnd's status override, with every discrepancy named.
//   4. A guard that cannot run is not a guard that passed: if the `--list`
//      spawn fails or its output cannot be parsed, the run fails too.
//
// WHY THE REPORTER ALONE IS NOT ENOUGH -- THE GLOBAL-SETUP HANDSHAKE.
// A CLI `--reporter=...` flag REPLACES the config's reporter list, and
// `--reporter=dot,json` is exactly how the correctness program drives these
// suites (the `list` reporter rewrites its lines in place, so redirected logs
// cannot be audited -- §15e finding 3). A guard that the standard invocation
// silently drops is decorative. So `assertCollectionGuardPresent` is called
// from global-setup with the RESOLVED config: a run whose reporter list lost
// the guard refuses to start and says how to add it back
// (`--reporter=./e2e/collectionGuard.ts,dot,json`). `--list` itself never runs
// global-setup, so listing stays cheap and un-guarded.
//
// ESCAPE HATCHES, ALL LOUD. Invocations that legitimately change the collected
// population relative to a plain `--list` (--shard, --repeat-each,
// --last-failed, --only-changed) skip the comparison with a printed notice.
// COLLECTION_GUARD=off skips everything, also with a printed notice. Nothing
// is ever skipped silently.

// THE MECHANISM, REPRODUCED (2026-08-14). A spec file that is EMPTY at
// collection time is silently collected as a zero-test file: `--list` and the
// run header both report the suite WITHOUT it -- no error, no mention of the
// file, exit 0. Measured live: truncating `zz-collection-probe.spec.ts` (3
// tests) turned `Total: 152 tests in 30 files` into `Total: 149 tests in 29
// files` deterministically, and a writer churning the file with
// truncate-then-write saves made 5 of 15 collection passes drop it silently.
// That is exactly what an editor/agent save or a sync tool produces mid-write,
// and both files missing from the 134-of-143 run had been written by that same
// pass (the new 4-test spec, plus the only 5-test spec touched that day --
// 4 + 5 = 9). The onEnd comparison catches the TRANSIENT form (the file has
// its content back by the time `--list` runs); `matchedSpecFiles` +
// `describeZeroTestFiles` below catch the PERSISTENT form (the file is still
// empty), which the comparison alone would wave through because both sides
// would agree on the truncated population.

import type {
  FullConfig,
  FullProject,
  FullResult,
  Reporter,
  Suite,
} from "@playwright/test/reporter";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Pure functions -- unit-tested in e2e/__tests__/collectionGuard.test.ts
// ============================================================================

/** One test's identity, stable across the run side and the --list side. */
export function testIdentity(
  project: string,
  file: string,
  titles: string[],
): string {
  return `[${project}] ${file.replace(/\\/g, "/")} :: ${titles.join(" > ")}`;
}

/** The identities of every test the RUN collected, from the root suite. */
export function collectedIdentities(rootSuite: Suite): string[] {
  return rootSuite.allTests().map((t) => {
    // titlePath() = ["", projectName, filePath, ...describe titles, test title]
    const tp = t.titlePath();
    return testIdentity(tp[1] ?? "", tp[2] ?? "", tp.slice(3));
  });
}

interface JsonSpec {
  title: string;
  file: string;
  tests?: Array<{ projectName?: string }>;
}
interface JsonSuite {
  title: string;
  file?: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

/**
 * The identities of every test `--list --reporter=json` reports.
 *
 * The JSON reporter nests: file-level suites (whose title IS the file path),
 * then describe-level suites, then specs, each spec carrying one test entry
 * per project. The file-level suite's title is NOT part of the test's title
 * path -- it corresponds to titlePath()[2] -- so it is excluded from `titles`.
 *
 * THE FILE COMPONENT IS THE FILE-SUITE'S TITLE, NOT `spec.file`. They agree
 * for every directly-registered spec, and they DISAGREE for a project that
 * registers its tests through a shared lib: `spec.file` is where `test()` was
 * CALLED (e.g. `scenarios/lib/scenario.ts`) while the file-suite title is the
 * spec file the runner imported (`scenarios/budget-model.scenario.ts`) --
 * which is exactly what the run side's `titlePath()[2]` reports. Using
 * `spec.file` here made the guard fail EVERY scenario run as "24 missing +
 * 24 phantom" on identical test sets (measured 2026-08-14, first live
 * scenario run through the guard). `spec.file` remains the right axis for the
 * zero-test-file coverage check below, which is where the lib-indirection is
 * deliberately detected and declined.
 */
export function listedIdentities(report: unknown): string[] {
  const root = report as { suites?: JsonSuite[] };
  if (!root || !Array.isArray(root.suites)) {
    throw new Error(
      "[collection-guard] --list --reporter=json output has no `suites` array",
    );
  }
  const out: string[] = [];
  const walk = (
    suite: JsonSuite,
    titles: string[],
    isFileSuite: boolean,
    fileSuiteTitle: string,
  ) => {
    const nextTitles = isFileSuite ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const specTitles = [...nextTitles, spec.title];
      const file = fileSuiteTitle || spec.file;
      const tests = spec.tests ?? [];
      if (tests.length === 0) {
        out.push(testIdentity("", file, specTitles));
      }
      for (const t of tests) {
        out.push(testIdentity(t.projectName ?? "", file, specTitles));
      }
    }
    for (const child of suite.suites ?? []) {
      walk(child, nextTitles, false, fileSuiteTitle);
    }
  };
  for (const fileSuite of root.suites) {
    walk(fileSuite, [], true, fileSuite.title ?? "");
  }
  return out;
}

export interface CollectionComparison {
  listedCount: number;
  collectedCount: number;
  /** In the listing, NOT collected by the run -- the silent-drop direction. */
  missing: string[];
  /** Collected by the run, NOT in the listing. */
  phantom: string[];
}

/** Multiset comparison: duplicates (e.g. parameterised titles) must balance. */
export function compareCollections(
  listed: string[],
  collected: string[],
): CollectionComparison {
  const counts = new Map<string, number>();
  for (const id of listed) counts.set(id, (counts.get(id) ?? 0) + 1);
  const phantom: string[] = [];
  for (const id of collected) {
    const n = counts.get(id) ?? 0;
    if (n <= 1) counts.delete(id);
    else counts.set(id, n - 1);
    if (n === 0) phantom.push(id);
  }
  const missing: string[] = [];
  for (const [id, n] of counts) for (let i = 0; i < n; i++) missing.push(id);
  missing.sort();
  phantom.sort();
  return {
    listedCount: listed.length,
    collectedCount: collected.length,
    missing,
    phantom,
  };
}

/**
 * The sentence a run that dropped tests should carry. Returns null when the
 * collections agree. Groups by FILE, because a whole missing file is the
 * observed failure shape and the reader's first question is "which files".
 */
export function describeCollectionShortfall(
  cmp: CollectionComparison,
): string | null {
  if (cmp.missing.length === 0 && cmp.phantom.length === 0) return null;

  const groupByFile = (ids: string[]): string => {
    const byFile = new Map<string, string[]>();
    for (const id of ids) {
      const m = /^\[[^\]]*\] ([^:]*?) :: /.exec(id);
      const file = m ? m[1].trim() : "(unparsed identity)";
      const list = byFile.get(file) ?? [];
      list.push(id);
      byFile.set(file, list);
    }
    return [...byFile.entries()]
      .map(
        ([file, tests]) =>
          `      ${file}  (${tests.length} test${tests.length === 1 ? "" : "s"})\n` +
          tests.map((t) => `        ${t}`).join("\n"),
      )
      .join("\n");
  };

  const parts: string[] = [
    `[collection-guard] THE RUN'S COLLECTED TESTS DISAGREE WITH \`--list\` FOR THE SAME FILTER.`,
    `  --list reports ${cmp.listedCount} test(s); the run collected ${cmp.collectedCount}.`,
  ];
  if (cmp.missing.length > 0) {
    parts.push(
      `  ${cmp.missing.length} test(s) are in the listing but were NOT collected by this run` +
        ` -- the run's result says NOTHING about them:`,
      groupByFile(cmp.missing),
    );
  }
  if (cmp.phantom.length > 0) {
    parts.push(
      `  ${cmp.phantom.length} test(s) were collected by this run but are NOT in the listing:`,
      groupByFile(cmp.phantom),
    );
  }
  parts.push(
    `  A run that silently drops tests reports a green number for coverage it does not have` +
      ` (a 2026-08-13 journey pass collected 134 of 143 and reported a clean pass; the nine` +
      ` missing included the four tests the run existed to prove). This run is FAILED until` +
      ` the discrepancy is explained. If the invocation legitimately narrows collection,` +
      ` use the documented flags (--shard/--repeat-each/--last-failed/--only-changed skip` +
      ` this check loudly) -- do not suppress the guard.`,
  );
  return parts.join("\n");
}

/**
 * Flags whose PRESENCE makes "the same filter under --list" undefined, so the
 * comparison is skipped -- loudly -- rather than reporting a verdict it cannot
 * support.
 */
const SKIP_FLAGS = [
  "--shard",
  "--repeat-each",
  "--last-failed",
  "--only-changed",
  "--ui",
  "--debug",
];

/** Flags stripped from the child `--list` invocation (with their values). */
const STRIP_WITH_VALUE = new Set([
  "--reporter",
  "--output",
  "--max-failures",
  "--trace",
]);
const STRIP_BARE = new Set(["-u", "--update-snapshots", "-x", "--quiet", "--headed", "--fail-on-flaky-tests"]);

/** Rebuild the CLI filter args for the child `--list` run. Exported for tests. */
export function listArgsFrom(argv: string[]): string[] {
  const args = [...argv];
  if (args[0] === "test") args.shift();
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const flag = eq >= 0 ? a.slice(0, eq) : a;
    if (STRIP_BARE.has(flag) || (eq >= 0 && flag === "--update-snapshots")) continue;
    if (STRIP_WITH_VALUE.has(flag)) {
      if (eq < 0) i++; // separate-value form: skip the value token too
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Which skip flag, if any, this invocation carries. Exported for tests. */
export function skipFlagIn(argv: string[]): string | undefined {
  return SKIP_FLAGS.find((f) =>
    argv.some((a) => a === f || a.startsWith(`${f}=`)),
  );
}

// ============================================================================
// Spec-file coverage: no matched file may contribute zero tests
// ============================================================================

/**
 * Translate a Playwright testMatch/testIgnore string glob to a RegExp over a
 * FORWARD-SLASHED path relative to the project's testDir. Handles the shapes
 * this config uses (`**\/*.spec.ts`, `**\/name.spec.ts`); `**\/` matches any
 * directory prefix including none, `*` stays within one path segment.
 * Exported for tests.
 */
export function globToRegex(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(
  rel: string,
  patterns: string | RegExp | Array<string | RegExp> | undefined,
): boolean {
  if (patterns === undefined) return false;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  return list.some((p) =>
    typeof p === "string" ? globToRegex(p).test(rel) : p.test(rel.replace(/\//g, path.sep)) || p.test(rel),
  );
}

/** One canonical spelling for a path: absolute, forward-slashed, case-folded
 *  (Windows filesystems are case-insensitive). Exported for tests. */
export function canonPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

/** Every file under `testDir` that the project's testMatch claims, canonical. */
export function matchedSpecFiles(project: Pick<FullProject, "testDir" | "testMatch" | "testIgnore">): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(full);
      } else {
        const rel = path.relative(project.testDir, full).replace(/\\/g, "/");
        if (
          matchesAny(rel, project.testMatch) &&
          !matchesAny(rel, project.testIgnore)
        ) {
          out.push(canonPath(full));
        }
      }
    }
  };
  walk(project.testDir);
  return out.sort();
}

/**
 * The verdict for one project's spec-file coverage, or null when it is clean.
 *
 * Two tiers, because attribution is not always decidable:
 *   - ZERO-BYTE files fail unconditionally: an empty matched file is the
 *     reproduced silent-drop mechanism itself, whatever the project's
 *     registration style.
 *   - The listing check (every matched file contributes >=1 listed test) runs
 *     only when the project registers tests DIRECTLY -- i.e. every listed file
 *     is itself a matched file. The `scenario` project registers through
 *     `lib/scenario.ts`, so all 24 of its tests are attributed to the lib and
 *     per-file coverage is undecidable there; claiming otherwise would be a
 *     permanent false alarm on all three .scenario.ts files.
 *
 * `onDisk` and `listedFiles` are canonical paths (see canonPath) for the same
 * project; `zeroByte` the subset of `onDisk` that is empty. Exported for tests.
 */
export function describeZeroTestFiles(
  projectName: string,
  onDisk: string[],
  zeroByte: string[],
  listedFiles: Set<string>,
): { message: string | null; note: string | null } {
  if (zeroByte.length > 0) {
    return {
      message:
        `[collection-guard] ${zeroByte.length} spec file(s) matched by project "${projectName}"` +
        ` are EMPTY (0 bytes) on disk:\n` +
        zeroByte.map((f) => `      ${f}`).join("\n") +
        `\n  An empty spec file is collected SILENTLY -- no error, no mention, a clean` +
        ` total (measured: truncating a 3-test file turned "152 tests in 30 files" into` +
        ` "149 tests in 29 files" with exit 0). That is what a truncate-then-write save` +
        ` or an interrupted sync leaves mid-write, and it is the demonstrated mechanism` +
        ` behind the 134-of-143 journey collection of 2026-08-13.`,
      note: null,
    };
  }

  const onDiskSet = new Set(onDisk);
  const indirect = [...listedFiles].some((f) => !onDiskSet.has(f));
  if (indirect) {
    return {
      message: null,
      note:
        `[collection-guard] project "${projectName}" registers tests through files` +
        ` outside its testMatch, so per-file coverage is undecidable there; only the` +
        ` zero-byte floor was applied to its ${onDisk.length} matched file(s).`,
    };
  }

  const empty = onDisk.filter((f) => !listedFiles.has(f));
  if (empty.length === 0) return { message: null, note: null };
  return {
    message:
      `[collection-guard] ${empty.length} spec file(s) matched by project "${projectName}"` +
      ` contribute ZERO tests to the collection:\n` +
      empty.map((f) => `      ${f}`).join("\n") +
      `\n  A truncated or tests-stripped spec file is collected SILENTLY -- no error,` +
      ` no mention, a clean total. If the file is genuinely meant to hold no tests, it` +
      ` must not match testMatch -- helpers belong in *.ts, unit tests in *.test.ts.`,
    note: null,
  };
}

// ============================================================================
// The global-setup handshake
// ============================================================================

/**
 * Refuse to start a run whose RESOLVED reporter list does not include this
 * guard. Called from global-setup with the FullConfig, which reflects any CLI
 * `--reporter` override -- the exact mechanism that would otherwise drop the
 * guard from the program's standard `--reporter=dot,json` invocation.
 */
export function assertCollectionGuardPresent(config: FullConfig): void {
  if (process.env.COLLECTION_GUARD === "off") {
    console.error(
      "[collection-guard] DISABLED via COLLECTION_GUARD=off -- this run's collected" +
        " test count will NOT be verified against --list. Do not read a green" +
        " number from it as proof the full suite ran.",
    );
    return;
  }
  const reporters = Array.isArray(config.reporter) ? config.reporter : [];
  const present = reporters.some(
    (entry) =>
      typeof entry?.[0] === "string" &&
      entry[0].replace(/\\/g, "/").includes("collectionGuard"),
  );
  if (!present) {
    throw new Error(
      "[collection-guard] this run's reporter list does not include the collection" +
        " guard (a CLI --reporter flag replaces the config's reporters, which is how" +
        " a 134-of-143 collection produced a clean pass on 2026-08-13). Add it:\n" +
        "    --reporter=./e2e/collectionGuard.ts,dot,json\n" +
        "  or drop --reporter to use the config's list. COLLECTION_GUARD=off skips" +
        " this check, loudly, if you genuinely need an unguarded run.",
    );
  }
}

// ============================================================================
// The reporter
// ============================================================================

export default class CollectionGuard implements Reporter {
  private collected: string[] | null = null;
  private configDir: string = path.resolve(HERE, "..");
  private ranProjects: FullProject[] = [];

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    if (config.configFile) this.configDir = path.dirname(config.configFile);
    this.collected = collectedIdentities(suite);
    // The project suites actually in this run (post --project filtering).
    const ranNames = new Set(suite.suites.map((s) => s.title));
    this.ranProjects = config.projects.filter((p) => ranNames.has(p.name));
  }

  async onEnd(
    _result: FullResult,
  ): Promise<{ status?: FullResult["status"] } | undefined> {
    if (process.env.COLLECTION_GUARD_CHILD === "1") return undefined;
    if (process.env.COLLECTION_GUARD === "off") return undefined;
    const argv = process.argv.slice(2);
    if (argv.includes("--list")) return undefined;

    const skip = skipFlagIn(argv);
    if (skip) {
      console.error(
        `[collection-guard] SKIPPED: ${skip} changes the collected population, so` +
          ` the --list comparison is undefined for this invocation. The collected` +
          ` count was NOT verified.`,
      );
      return undefined;
    }

    if (this.collected === null) {
      // onBegin never fired -- the run aborted before collection (e.g. a
      // global-setup failure). There is no green number to protect.
      return undefined;
    }

    const cliJs = path.join(
      this.configDir,
      "node_modules",
      "@playwright",
      "test",
      "cli.js",
    );
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      COLLECTION_GUARD_CHILD: "1",
    };
    delete childEnv.PLAYWRIGHT_JSON_OUTPUT_NAME;
    delete childEnv.PLAYWRIGHT_JSON_OUTPUT_DIR;
    delete childEnv.PLAYWRIGHT_JSON_OUTPUT_FILE;

    const child = spawnSync(
      process.execPath,
      [cliJs, "test", ...listArgsFrom(argv), "--list", "--reporter=json"],
      {
        cwd: this.configDir,
        env: childEnv,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: 180_000,
      },
    );

    // A guard that cannot run is not a guard that passed.
    if (child.error || child.status !== 0) {
      console.error(
        `[collection-guard] could not obtain \`--list\` for this filter` +
          ` (exit ${child.status ?? "spawn-error"}): ${child.error?.message ?? ""}\n` +
          `${(child.stderr ?? "").slice(-2000)}\n` +
          `  The run's collected count is UNVERIFIED, so the run is failed rather` +
          ` than reported green on evidence that was never obtained.`,
      );
      return { status: "failed" };
    }

    let listed: string[];
    try {
      listed = listedIdentities(JSON.parse(child.stdout));
    } catch (e) {
      console.error(
        `[collection-guard] --list --reporter=json output was unparseable: ${String(
          e,
        )}\n  The run's collected count is UNVERIFIED; failing the run.`,
      );
      return { status: "failed" };
    }

    const cmp = compareCollections(listed, this.collected);
    const verdictText = describeCollectionShortfall(cmp);
    if (verdictText) {
      console.error("\n" + verdictText + "\n");
      return { status: "failed" };
    }

    // SECOND CHECK, filter-independent: no file matched by a ran project's
    // testMatch may contribute zero tests. This is what catches a spec file
    // that is STILL empty/truncated at the end of the run -- the comparison
    // above would agree with `--list` on the truncated population and wave it
    // through. Uses an UNFILTERED per-project listing, so a --grep run still
    // verifies whole-file presence.
    if (this.ranProjects.length > 0) {
      const projectArgs = this.ranProjects.flatMap((p) => ["--project", p.name]);
      const listAll = spawnSync(
        process.execPath,
        [cliJs, "test", ...projectArgs, "--list", "--reporter=json"],
        {
          cwd: this.configDir,
          env: childEnv,
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
          timeout: 180_000,
        },
      );
      if (listAll.error || listAll.status !== 0) {
        console.error(
          `[collection-guard] could not obtain the unfiltered per-project listing` +
            ` for the spec-file coverage check (exit ${listAll.status ?? "spawn-error"}).` +
            ` A guard that cannot run is not a guard that passed; failing the run.\n` +
            `${(listAll.stderr ?? "").slice(-2000)}`,
        );
        return { status: "failed" };
      }
      let parsed: { config?: { rootDir?: string }; suites?: unknown };
      try {
        parsed = JSON.parse(listAll.stdout);
      } catch (e) {
        console.error(
          `[collection-guard] unfiltered listing was unparseable: ${String(e)};` +
            ` failing the run.`,
        );
        return { status: "failed" };
      }
      const rootDir = parsed.config?.rootDir ?? this.configDir;
      // projectName -> set of canonical file paths that contributed >=1 test.
      const filesByProject = new Map<string, Set<string>>();
      const walk = (suite: JsonSuite) => {
        for (const spec of suite.specs ?? []) {
          for (const t of spec.tests ?? []) {
            const name = t.projectName ?? "";
            const set = filesByProject.get(name) ?? new Set<string>();
            set.add(canonPath(path.resolve(rootDir, spec.file)));
            filesByProject.set(name, set);
          }
        }
        for (const child of suite.suites ?? []) walk(child);
      };
      for (const s of (parsed as { suites?: JsonSuite[] }).suites ?? []) walk(s);

      const failures: string[] = [];
      for (const project of this.ranProjects) {
        const onDisk = matchedSpecFiles(project);
        const zeroByte = onDisk.filter((f) => {
          try {
            return fs.statSync(f).size === 0;
          } catch {
            return false;
          }
        });
        const { message, note } = describeZeroTestFiles(
          project.name,
          onDisk,
          zeroByte,
          filesByProject.get(project.name) ?? new Set(),
        );
        if (message) failures.push(message);
        if (note) console.log(note);
      }
      if (failures.length > 0) {
        console.error("\n" + failures.join("\n") + "\n");
        return { status: "failed" };
      }
    }

    console.log(
      `[collection-guard] collection verified: the run collected all` +
        ` ${cmp.listedCount} test(s) that --list reports for this filter, and every` +
        ` matched spec file contributes at least one test.`,
    );
    return undefined;
  }
}
