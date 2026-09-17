//! FILENAME: tests/eval/lib/llamaServer.mjs
// PURPOSE: Start the product's own llama-server on the product's own flags for
//          the duration of a suite run, and describe what it is serving.
// CONTEXT: The runners talk to an OpenAI-compatible endpoint and never start
//          anything; until 2026-09-17 the server behind every on-board
//          measurement was started BY HAND in a second terminal, with a GGUF
//          picked by hand, and no artifact recorded which. The suite starts it
//          here — from the fetched runtime in `app/src-tauri/binaries/`, with
//          `serverArgs()` mirroring `ai/runtime.rs`, on a free port so a server
//          someone left running on 8080 cannot answer in its place — and hashes
//          the model file, so the aggregate says what answered, byte for byte.
//
//          Nothing here is a second implementation of the product's launch:
//          the flags are asserted equal to the Rust ones by `evalSuite.test.mjs`,
//          the binary location is the fetch script's own `runtimeDir`, and the
//          model pin is `BUILTIN_MODEL_PIN` itself.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { hostTriple, inspectRuntime, LLAMA_SERVER_PIN } from "../../../app/scripts/fetch-llama-server.mjs";
import { BUILTIN_MODEL_PIN, MODELS_DIR } from "../../../app/scripts/fetch-builtin-model.mjs";
import { sha256File } from "../../../app/scripts/lib/artifact.mjs";
import { serverArgs } from "../suite.mjs";

/** Where the bake-off candidates were downloaded to (outside the repo, outside Dropbox). */
export const BAKEOFF_DIR = path.join(process.env.LOCALAPPDATA ?? "", "calcula-bakeoff");

// ---------------------------------------------------------------------------
// Which model
// ---------------------------------------------------------------------------

/**
 * `calcula-builtin` (or the pin's id) is the fetched on-board model; anything
 * else is a GGUF by path, or by name under `app/src-tauri/models/` or the
 * bake-off folder. The id is the file's stem, so an artifact names the FILE
 * that answered rather than the alias the runner was told.
 */
export function resolveModel(spec = "calcula-builtin") {
  if (spec === "calcula-builtin" || spec === BUILTIN_MODEL_PIN.id) {
    return describeFile(path.join(MODELS_DIR, BUILTIN_MODEL_PIN.file), "the pinned on-board model", true);
  }
  const candidates = [];
  if (/[\\/]/.test(spec) || /\.gguf$/i.test(spec)) candidates.push(path.resolve(spec));
  for (const dir of [MODELS_DIR, BAKEOFF_DIR]) {
    candidates.push(path.join(dir, spec), path.join(dir, `${spec}.gguf`));
  }
  const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (!hit) {
    throw new Error(`no GGUF called ${JSON.stringify(spec)}. Looked at:\n  ${candidates.join("\n  ")}`);
  }
  return describeFile(hit, "a GGUF on disk", false);
}

function describeFile(file, source, pinned) {
  if (!existsSync(file)) {
    throw new Error(`${file} is not on disk${pinned ? " (run: cd app && npm run fetch:builtin-model)" : ""}`);
  }
  return { id: path.basename(file).replace(/\.gguf$/i, ""), path: file, bytes: statSync(file).size, source, pinned };
}

/** The same, plus the hash — the identity of the arm. A 1 GB file takes a few seconds. */
export async function describeModel(model) {
  const sha256 = await sha256File(model.path);
  return { ...model, sha256, matchesPin: sha256 === BUILTIN_MODEL_PIN.sha256 };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** A loopback port nothing is listening on right now (`free_port` in runtime.rs). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** The last N lines of a child's output, for the error a launch failure prints. */
class Tail {
  constructor(lines) {
    this.max = lines;
    this.lines = [];
    this.partial = "";
  }
  push(chunk) {
    const text = this.partial + String(chunk);
    const parts = text.split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      this.lines.push(line);
      if (this.lines.length > this.max) this.lines.shift();
    }
  }
  text() {
    return [...this.lines, this.partial].filter(Boolean).join("\n");
  }
}

/** What is on disk for this machine, without starting anything. */
export function runtimeState() {
  const triple = hostTriple();
  const state = inspectRuntime(triple);
  return { ...state, exe: path.join(state.dir, "llama-server.exe"), pinnedBuild: LLAMA_SERVER_PIN.build };
}

async function waitForHealth(baseUrl, child, tail, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited with code ${child.exitCode} before it was healthy:\n${tail.text()}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`llama-server did not become healthy within ${Math.round(timeoutMs / 1000)}s:\n${tail.text()}`);
}

/** What the server says it is serving — the FIM runner reads the same endpoint. */
export async function readProps(baseUrl) {
  try {
    const p = await (await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(5000) })).json();
    return {
      modelPath: p.model_path ? String(p.model_path) : "",
      nCtx: p.default_generation_settings?.n_ctx ?? null,
      totalSlots: p.total_slots ?? null,
      buildInfo: p.build_info ? String(p.build_info) : "",
    };
  } catch {
    return null;
  }
}

/**
 * Start the runtime on `modelPath` and wait until it answers `/health`.
 * Returns a handle whose `stop()` terminates it; the process also dies with
 * this one, so an interrupted suite leaves no server behind.
 */
export async function startServer({ modelPath, log = console.log, healthTimeoutMs = 180_000 }) {
  const state = runtimeState();
  if (state.state === "missing" || state.state === "unknown-target") {
    throw new Error(
      `llama-server is not on disk for ${state.triple} (${state.dir}).\nRun: cd app && npm run fetch:llama-server`,
    );
  }
  const port = await freePort();
  const args = serverArgs(modelPath, port);
  const tail = new Tail(60);
  const child = spawn(state.exe, args, { cwd: state.dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (d) => tail.push(d));
  child.stderr.on("data", (d) => tail.push(d));
  const onExit = () => {
    if (child.exitCode === null) child.kill();
  };
  process.once("exit", onExit);

  async function stop() {
    if (child.exitCode !== null) return;
    child.kill();
    const exited = await Promise.race([
      new Promise((r) => child.once("exit", () => r(true))),
      new Promise((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (!exited && process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
    process.off("exit", onExit);
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  log(`[suite] llama-server ${state.recorded || "?"} (${state.state}, pinned ${state.pinnedBuild}) pid ${child.pid} on ${baseUrl}`);
  try {
    await waitForHealth(baseUrl, child, tail, healthTimeoutMs);
  } catch (e) {
    await stop();
    throw e;
  }
  const props = await readProps(baseUrl);
  return {
    baseUrl,
    port,
    pid: child.pid,
    exe: state.exe,
    args,
    triple: state.triple,
    build: state.recorded || "",
    buildState: state.state,
    pinnedBuild: state.pinnedBuild,
    props,
    stop,
    logTail: () => tail.text(),
  };
}
