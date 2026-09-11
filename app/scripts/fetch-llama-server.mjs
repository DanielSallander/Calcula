//! FILENAME: app/scripts/fetch-llama-server.mjs
// PURPOSE: Put the bundled inference runtime (llama.cpp's `llama-server`, CPU
//          build) where the app and the installer look for it, from a PINNED
//          release: one build number, one asset per architecture, one sha256
//          each.
// CONTEXT: Owner decisions D6/D7 (2026-09-10, docs/design/open-items.md
//          2.AI.10): the engine ships in the installer, CPU-only; the model is
//          downloaded on first use behind a consent sentence (that half is
//          `fetch-builtin-model.mjs` for a developer, and Rust
//          `ai/builtin_model.rs` for the product).
//
//          WHY A RESOURCE FOLDER AND NOT TAURI'S `externalBin`. A sidecar
//          declared in `tauri.conf.json` must EXIST at every `cargo build` of
//          the app crate — tauri-build copies it in `build.rs` and fails when
//          it is missing — and it carries only the executable. `llama-server`
//          needs its DLLs (`llama.dll`, `ggml*.dll`) beside it, which would be
//          resources anyway. So the whole folder is a resource, mapped by the
//          per-architecture overlay `tauri.runtime-<arch>.conf.json` at
//          release time, and in development the app looks in THIS folder
//          directly. A tree without the folder still builds and runs; the
//          model picker then says the runtime is not installed in this build.
//
//          The destination is `app/src-tauri/binaries/llama-server-<triple>/`,
//          ignored by git. Run it as `npm run fetch:llama-server`; `npm run
//          tauri …` runs it first with `--soft`, so a developer who is offline
//          is warned, not blocked.
//
// USAGE
//   node scripts/fetch-llama-server.mjs                  # this machine's architecture
//   node scripts/fetch-llama-server.mjs --target x86_64-pc-windows-msvc
//   node scripts/fetch-llama-server.mjs --all            # both architectures
//   node scripts/fetch-llama-server.mjs --check          # report, exit 1 if missing
//   node scripts/fetch-llama-server.mjs --soft           # never fail the caller
//
// Set CALCULA_SKIP_LLAMA_FETCH=1 to skip entirely (CI passes it to the build
// step after fetching the matrix target explicitly).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadPinned, extractZipMembers, formatBytes, sha256File } from "./lib/artifact.mjs";
import { markIgnored } from "./dropbox-ignore.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES_DIR = path.join(APP_DIR, "src-tauri", "binaries");
const CACHE_DIR = path.join(BINARIES_DIR, ".cache");

/**
 * The repository lives under Dropbox. A folder of freshly written binaries is
 * exactly what Dropbox opens handles on and uploads, so the folder is marked
 * ignored the moment it exists — before a single byte lands in it.
 */
function keepOutOfDropbox(dir) {
  fs.mkdirSync(dir, { recursive: true });
  markIgnored(dir);
}

/**
 * THE PIN. A newer llama.cpp build is a deliberate change to these lines, with
 * the sha256 read from the GitHub release's asset digest, never from the file
 * after downloading it.
 *
 * b10897 (2026-09-10): the newest tagged build at the time Step 3 shipped. The
 * CPU builds are the only ones bundled (D7); a user with a GPU keeps their own
 * runtime, which the model picker already lists.
 */
export const LLAMA_SERVER_PIN = {
  build: "b10897",
  releaseUrl: "https://github.com/ggml-org/llama.cpp/releases/tag/b10897",
  licence: "MIT",
  targets: {
    "x86_64-pc-windows-msvc": {
      asset: "llama-b10897-bin-win-cpu-x64.zip",
      size: 18_423_822,
      sha256: "1755dc055007b691fb8ac2552e6908cb3bb8dedc75df2aa6bd4a44d6a68662b2",
    },
    "aarch64-pc-windows-msvc": {
      asset: "llama-b10897-bin-win-cpu-arm64.zip",
      size: 11_990_443,
      sha256: "1ffff67b10469cc560b3dbafd5ff7d45e21ade7e689e9e4488c9bcc3e5997b8b",
    },
  },
};

/** The rustc target triple for the machine this script runs on. */
export function hostTriple() {
  return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
}

/** Where the runtime for one target lives. Mirrored by `ai/runtime.rs`. */
export function runtimeDir(triple) {
  return path.join(BINARIES_DIR, `llama-server-${triple}`);
}

/**
 * The archive members that are the runtime: the server and every DLL it
 * loads, and nothing that belongs to a sibling tool.
 *
 * Since b108xx `llama-server.exe` is a 9 KB launcher and the program lives in
 * `llama-server-impl.dll`; the archive also carries `llama-cli-impl.dll`,
 * `llama-bench-impl.dll` and the rest of the tools' implementations, which the
 * server never loads. Those are dropped by name. Everything else that ends in
 * `.dll` is kept — `llama.dll`, `llama-common.dll`, `ggml*.dll` (the CPU
 * variants are picked at load time by feature level), `libomp.dll`, `mtmd.dll`.
 */
export function isRuntimeMember(baseName) {
  const lower = baseName.toLowerCase();
  if (lower === "llama-server.exe") return true;
  if (lower === "license" || lower === "license.txt") return true;
  if (!lower.endsWith(".dll")) return false;
  if (lower.startsWith("llama-") && lower.endsWith("-impl.dll")) return lower === "llama-server-impl.dll";
  return true;
}

/** What is on disk for one target, without touching the network. */
export function inspectRuntime(triple) {
  const dir = runtimeDir(triple);
  const exe = path.join(dir, "llama-server.exe");
  const stamp = path.join(dir, "BUILD.txt");
  const pin = LLAMA_SERVER_PIN.targets[triple];
  if (!pin) return { triple, dir, state: "unknown-target" };
  if (!fs.existsSync(exe)) return { triple, dir, state: "missing" };
  let recorded = "";
  try {
    recorded = fs.readFileSync(stamp, "utf8").split(/\r?\n/)[0].trim();
  } catch {
    recorded = "";
  }
  return { triple, dir, state: recorded === LLAMA_SERVER_PIN.build ? "current" : "stale", recorded };
}

/**
 * Fetch, verify and unpack one target's runtime. Idempotent: a folder stamped
 * with the pinned build is left alone.
 */
export async function fetchRuntime(triple, { force = false, log = console.log } = {}) {
  const pin = LLAMA_SERVER_PIN.targets[triple];
  if (!pin) throw new Error(`no pinned llama-server build for target ${triple}`);
  const dir = runtimeDir(triple);
  const found = inspectRuntime(triple);
  if (found.state === "current" && !force) {
    log(`[llama-server] ${triple}: ${LLAMA_SERVER_PIN.build} already in place (${dir}).`);
    return { triple, dir, changed: false };
  }

  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_SERVER_PIN.build}/${pin.asset}`;
  keepOutOfDropbox(BINARIES_DIR);
  const zip = path.join(CACHE_DIR, pin.asset);
  await downloadPinned(url, zip, { size: pin.size, sha256: pin.sha256, log, label: pin.asset });

  // Unpack into a fresh folder, then swap it in, so a half-written runtime is
  // never what the app finds.
  const staging = `${dir}.staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  const written = extractZipMembers(zip, isRuntimeMember, staging);
  if (!written.some((f) => f.toLowerCase() === "llama-server.exe")) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`${pin.asset} holds no llama-server.exe; the archive layout changed. Members kept: ${written.join(", ") || "none"}`);
  }
  const zipSha = await sha256File(zip);
  fs.writeFileSync(
    path.join(staging, "BUILD.txt"),
    [LLAMA_SERVER_PIN.build, pin.asset, zipSha, `fetched ${new Date().toISOString()}`, ""].join("\n"),
  );
  fs.writeFileSync(
    path.join(staging, "NOTICE.txt"),
    [
      "llama.cpp llama-server, bundled with Calcula as its on-board inference runtime.",
      `Build:   ${LLAMA_SERVER_PIN.build}`,
      `Asset:   ${pin.asset} (sha256 ${pin.sha256})`,
      `Source:  ${LLAMA_SERVER_PIN.releaseUrl}`,
      `Licence: ${LLAMA_SERVER_PIN.licence} (https://github.com/ggml-org/llama.cpp/blob/master/LICENSE)`,
      "CPU build only. Calcula starts it on 127.0.0.1 on a free port and stops it with the app.",
      "",
    ].join("\n"),
  );
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  const bytes = written.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  log(
    `[OK] llama-server ${LLAMA_SERVER_PIN.build} for ${triple}: ${written.length} files, ` +
      `${formatBytes(bytes)} -> ${dir}`,
  );
  return { triple, dir, changed: true };
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { targets: [], all: false, check: false, soft: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") opts.targets.push(argv[++i]);
    else if (a === "--all") opts.all = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--soft") opts.soft = true;
    else if (a === "--force") opts.force = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.all) opts.targets = Object.keys(LLAMA_SERVER_PIN.targets);
  if (opts.targets.length === 0) opts.targets = [hostTriple()];
  return opts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  if (process.env.CALCULA_SKIP_LLAMA_FETCH === "1") {
    console.log("[llama-server] skipped (CALCULA_SKIP_LLAMA_FETCH=1)");
    process.exit(0);
  }
  if (opts.check) {
    let missing = 0;
    for (const triple of opts.targets) {
      const found = inspectRuntime(triple);
      const line =
        found.state === "current"
          ? `[OK] ${triple}: llama-server ${LLAMA_SERVER_PIN.build} at ${found.dir}`
          : found.state === "stale"
            ? `[STALE] ${triple}: on disk is "${found.recorded || "unstamped"}", pin is ${LLAMA_SERVER_PIN.build} (run without --check to update)`
            : `[MISSING] ${triple}: no runtime at ${found.dir} (run: npm run fetch:llama-server)`;
      console.log(line);
      if (found.state !== "current") missing++;
    }
    process.exit(missing > 0 ? 1 : 0);
  }
  let failed = false;
  for (const triple of opts.targets) {
    try {
      await fetchRuntime(triple, { force: opts.force });
    } catch (e) {
      failed = true;
      const message = e && e.message ? e.message : String(e);
      if (opts.soft) {
        console.log(
          `[llama-server] WARNING: could not fetch the runtime for ${triple}: ${message}\n` +
            "               The app builds and runs without it; the model picker will report the\n" +
            "               built-in runtime as not installed. Re-run: npm run fetch:llama-server",
        );
      } else {
        console.error(`[llama-server] FAILED for ${triple}: ${message}`);
      }
    }
  }
  process.exitCode = failed && !opts.soft ? 1 : 0;
}
