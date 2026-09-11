//! FILENAME: app/extensions/AIChat/__tests__/builtinRuntimePins.test.ts
// PURPOSE: The on-board model's pin exists in two places — the product's
//          downloader in Rust and the developer's fetch script — and the
//          runtime's folder layout in three: the fetch script, the Rust
//          locator and the release overlays. This test reads each of them and
//          fails the moment any two disagree.
// CONTEXT: 2026-09-10. A pin that drifts is worse than no pin: the developer
//          verifies one file, the product downloads another, and both report
//          "sha256 matches". The layout is the same shape of hazard — the
//          overlay puts the runtime under one folder name and the Rust code
//          looks under another, and nothing fails until an installer is run
//          on a machine that has neither a dev tree nor the override variable.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { BUILTIN_MODEL_PIN } from "../../../scripts/fetch-builtin-model.mjs";
import { LLAMA_SERVER_PIN, isRuntimeMember } from "../../../scripts/fetch-llama-server.mjs";

const repo = path.resolve(__dirname, "../../../..");
const rust = (file: string) => readFileSync(path.join(repo, "app/src-tauri/src/ai", file), "utf8");

/** `pub const NAME: &str = "value";` from a Rust source, or throws. */
function rustStr(source: string, name: string): string {
  const m = new RegExp(`pub const ${name}: &str =\\s*"([^"]+)";`).exec(source);
  if (!m) throw new Error(`${name} not found`);
  return m[1];
}

function rustU64(source: string, name: string): number {
  const m = new RegExp(`pub const ${name}: u64 = ([0-9_]+);`).exec(source);
  if (!m) throw new Error(`${name} not found`);
  return Number(m[1].replace(/_/g, ""));
}

describe("the model pin is the same bytes in Rust and in the fetch script", () => {
  const src = rust("builtin_model.rs");

  it("names the same file, URL, size, hash and licence", () => {
    expect(rustStr(src, "MODEL_ID")).toBe(BUILTIN_MODEL_PIN.id);
    expect(rustStr(src, "MODEL_FILE")).toBe(BUILTIN_MODEL_PIN.file);
    expect(rustStr(src, "MODEL_LABEL")).toBe(BUILTIN_MODEL_PIN.label);
    expect(rustStr(src, "MODEL_URL")).toBe(BUILTIN_MODEL_PIN.url);
    expect(rustStr(src, "MODEL_SOURCE_URL")).toBe(BUILTIN_MODEL_PIN.sourceUrl);
    expect(rustStr(src, "MODEL_LICENCE")).toBe(BUILTIN_MODEL_PIN.licence);
    expect(rustStr(src, "MODEL_SHA256")).toBe(BUILTIN_MODEL_PIN.sha256);
    expect(rustU64(src, "MODEL_SIZE_BYTES")).toBe(BUILTIN_MODEL_PIN.size);
  });

  it("is the Apache-2.0 1.5B, never the Qwen-Research 3B", () => {
    expect(BUILTIN_MODEL_PIN.licence).toBe("Apache-2.0");
    expect(BUILTIN_MODEL_PIN.file).toContain("1.5b");
    expect(BUILTIN_MODEL_PIN.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the runtime's folder layout agrees everywhere it is spelled", () => {
  const src = rust("runtime.rs");
  const triples = Object.keys(LLAMA_SERVER_PIN.targets).sort();

  it("pins both Windows architectures with a sha256 each", () => {
    expect(triples).toEqual(["aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc"]);
    for (const t of triples) {
      const pin = LLAMA_SERVER_PIN.targets[t as keyof typeof LLAMA_SERVER_PIN.targets];
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.asset).toContain(LLAMA_SERVER_PIN.build);
      expect(pin.asset).toContain("win-cpu");
    }
  });

  it("keeps the server and its DLLs from the archive and drops the sibling tools", () => {
    // Since b108xx the executable is a launcher and the program lives in
    // llama-server-impl.dll; the other tools' -impl DLLs are dead weight.
    for (const keep of ["llama-server.exe", "llama-server-impl.dll", "llama.dll", "llama-common.dll",
      "ggml.dll", "ggml-base.dll", "ggml-cpu-haswell.dll", "libomp.dll", "mtmd.dll", "LICENSE"]) {
      expect(isRuntimeMember(keep), keep).toBe(true);
    }
    for (const drop of ["llama-cli-impl.dll", "llama-bench-impl.dll", "llama-quantize-impl.dll",
      "llama-cli.exe", "llama-bench.exe", "README.md", "convert.py"]) {
      expect(isRuntimeMember(drop), drop).toBe(false);
    }
  });

  it("spells the target triples the way the Rust locator does", () => {
    expect(src).toContain('"aarch64-pc-windows-msvc"');
    expect(src).toContain('"x86_64-pc-windows-msvc"');
    // The dev-tree location the locator joins: binaries/llama-server-<triple>/llama-server.exe
    expect(src).toContain('join("binaries").join(format!("llama-server-{}", TARGET_TRIPLE))');
    expect(rustStr(src, "ENGINE_EXE")).toBe("llama-server.exe");
  });

  it("maps each release overlay to the folder the installed locator reads", () => {
    const installedDir = rustStr(src, "INSTALLED_ENGINE_DIR");
    for (const [arch, triple] of [["x64", "x86_64-pc-windows-msvc"], ["arm64", "aarch64-pc-windows-msvc"]]) {
      for (const kind of ["runtime", "offline"]) {
        const file = path.join(repo, `app/src-tauri/tauri.${kind}-${arch}.conf.json`);
        expect(existsSync(file), file).toBe(true);
        const overlay = JSON.parse(readFileSync(file, "utf8")) as { bundle: { resources: Record<string, string> } };
        const source = `binaries/llama-server-${triple}/*`;
        expect(overlay.bundle.resources[source], `${file} must map ${source}`).toBe(`${installedDir}/`);
        if (kind === "offline") {
          expect(overlay.bundle.resources["models/*.gguf"]).toBe(`${rustStr(src, "BUNDLED_MODELS_DIR")}/`);
        } else {
          expect(overlay.bundle.resources["models/*.gguf"], "a runtime-only overlay bundles no model").toBeUndefined();
        }
      }
    }
  });

  it("is fetched and applied by the release workflow, and never committed", () => {
    const workflow = readFileSync(path.join(repo, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("node scripts/fetch-llama-server.mjs --target ${{ matrix.target }}");
    expect(workflow).toContain("tauri.runtime-${{ matrix.arch }}.conf.json");
    expect(workflow).toContain('CALCULA_SKIP_LLAMA_FETCH: "1"');
    const gitignore = readFileSync(path.join(repo, ".gitignore"), "utf8");
    expect(gitignore).toContain("app/src-tauri/binaries/");
    expect(gitignore).toContain("app/src-tauri/models/");
    const pkg = JSON.parse(readFileSync(path.join(repo, "app/package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["fetch:llama-server"]).toContain("fetch-llama-server.mjs");
    expect(pkg.scripts["fetch:builtin-model"]).toContain("fetch-builtin-model.mjs");
    expect(pkg.scripts.pretauri, "tauri dev/build fetch the runtime softly first").toContain("--soft");
  });
});
