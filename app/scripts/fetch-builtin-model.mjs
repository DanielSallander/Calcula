//! FILENAME: app/scripts/fetch-builtin-model.mjs
// PURPOSE: Download the on-board model to a folder the app reads, from the
//          same pin the product's own downloader carries — for a developer
//          machine, for the offline installer, and for the eval runners.
// CONTEXT: In the PRODUCT the model is downloaded by Rust
//          (`app/src-tauri/src/ai/builtin_model.rs`) after the user accepts one
//          consent sentence naming its size, licence, source and hash (D6).
//          This script is the developer's shortcut to the same file, and the
//          way an offline installer gets its copy: a `.gguf` in
//          `app/src-tauri/models/` is bundled by the `tauri.offline-<arch>`
//          overlay and found by the app before it ever looks at the download
//          folder.
//
//          THE PIN IS MIRRORED IN RUST. `builtinRuntimePins.test.ts` reads
//          both files and fails when the file name, URL, size or sha256
//          disagree, so the developer's copy and the product's download are
//          always the same bytes.
//
// USAGE
//   node scripts/fetch-builtin-model.mjs                 # -> app/src-tauri/models/
//   node scripts/fetch-builtin-model.mjs --dest <dir>    # e.g. the app's own models folder
//   node scripts/fetch-builtin-model.mjs --check

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadPinned, formatBytes, sha256File } from "./lib/artifact.mjs";
import { markIgnored } from "./dropbox-ignore.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MODELS_DIR = path.join(APP_DIR, "src-tauri", "models");

/**
 * THE PIN — the default on-board model (D6). Qwen2.5-Coder-3B is under the
 * "Qwen Research" licence and must never be a default; the 1.5B is Apache-2.0.
 * The hash is Hugging Face's LFS object id for the file, read from the
 * repository listing, never from a downloaded copy.
 */
export const BUILTIN_MODEL_PIN = {
  id: "qwen2.5-coder-1.5b-instruct-q4_k_m",
  file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
  label: "Qwen2.5-Coder 1.5B Instruct (Q4_K_M)",
  url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
  sourceUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
  licence: "Apache-2.0",
  size: 1_117_320_768,
  sha256: "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046",
};

export async function fetchModel({ dest = MODELS_DIR, log = console.log } = {}) {
  // A 1.1 GB file under Dropbox would start uploading the moment it is
  // written; the folder is marked ignored before the download begins.
  fs.mkdirSync(dest, { recursive: true });
  markIgnored(dest);
  const file = path.join(dest, BUILTIN_MODEL_PIN.file);
  const result = await downloadPinned(BUILTIN_MODEL_PIN.url, file, {
    size: BUILTIN_MODEL_PIN.size,
    sha256: BUILTIN_MODEL_PIN.sha256,
    log,
    label: BUILTIN_MODEL_PIN.file,
  });
  fs.writeFileSync(
    path.join(dest, `${BUILTIN_MODEL_PIN.file}.NOTICE.txt`),
    [
      `${BUILTIN_MODEL_PIN.label}, the on-board model Calcula uses for wording and drafting.`,
      `Source:  ${BUILTIN_MODEL_PIN.sourceUrl}`,
      `File:    ${BUILTIN_MODEL_PIN.file} (${formatBytes(BUILTIN_MODEL_PIN.size)}, sha256 ${BUILTIN_MODEL_PIN.sha256})`,
      `Licence: ${BUILTIN_MODEL_PIN.licence}`,
      "",
    ].join("\n"),
  );
  if (result.downloaded) log(`[OK] ${BUILTIN_MODEL_PIN.file} -> ${file}`);
  return file;
}

// --- CLI ---------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const soft = argv.includes("--soft");
  const destIndex = argv.indexOf("--dest");
  const dest = destIndex >= 0 ? path.resolve(argv[destIndex + 1]) : MODELS_DIR;
  const file = path.join(dest, BUILTIN_MODEL_PIN.file);
  if (check) {
    if (!fs.existsSync(file)) {
      console.log(`[MISSING] ${file} (run: npm run fetch:builtin-model)`);
      process.exit(1);
    }
    const size = fs.statSync(file).size;
    const sha = await sha256File(file);
    const ok = size === BUILTIN_MODEL_PIN.size && sha === BUILTIN_MODEL_PIN.sha256;
    console.log(ok ? `[OK] ${file} matches the pin` : `[MISMATCH] ${file}: ${size} bytes, sha256 ${sha}`);
    process.exit(ok ? 0 : 1);
  }
  try {
    await fetchModel({ dest });
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    if (soft) console.log(`[builtin-model] WARNING: ${message}`);
    else {
      console.error(`[builtin-model] FAILED: ${message}`);
      process.exitCode = 1;
    }
  }
}
