//! FILENAME: app/extensions/AIChat/__tests__/builtinRuntime.test.ts
// PURPOSE: The consent sentence names everything D6 requires, and the one-line
//          state descriptions say what is on the machine and what is running.
// CONTEXT: 2026-09-10. The sentence is what a person agrees to; a version that
//          dropped the size or the licence would still read fine and would be
//          a consent to something else.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BuiltinStatus } from "../lib/aiTypes";

const h = vi.hoisted(() => ({ invoke: vi.fn(), listeners: [] as Array<(e: unknown) => void>, disposed: 0 }));

vi.mock("@api", () => ({
  listenTauriEvent: async (_event: string, cb: (e: unknown) => void) => {
    h.listeners.push(cb);
    return () => {
      h.disposed++;
    };
  },
}));
vi.mock("../lib/aiChatBackend", () => ({
  aiChatBackend: { invoke: (...a: unknown[]) => h.invoke(...a) },
}));

const {
  builtinBadge, consentSentence, describeBuiltin, downloadBuiltinModel, formatSize,
} = await import("../lib/builtinRuntime");

function status(over: Partial<BuiltinStatus> = {}): BuiltinStatus {
  return {
    providerId: "calcula-builtin",
    target: "aarch64-pc-windows-msvc",
    engine: { present: true, path: "C:\\app\\llama-server\\llama-server.exe", build: "b10897", searched: [] },
    model: {
      pin: {
        id: "qwen2.5-coder-1.5b-instruct-q4_k_m",
        file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        label: "Qwen2.5-Coder 1.5B Instruct (Q4_K_M)",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        sourceUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
        licence: "Apache-2.0",
        sizeBytes: 1_117_320_768,
        sha256: "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046",
      },
      presence: "absent",
      path: null,
      foundIn: null,
      sizeOnDisk: null,
      downloadDir: "C:\\Users\\me\\AppData\\Local\\com.calcula.app\\models",
    },
    running: null,
    starting: false,
    download: null,
    idleUnloadSecs: 900,
    ...over,
  };
}

beforeEach(() => {
  h.invoke.mockReset();
  h.listeners.length = 0;
  h.disposed = 0;
});

describe("the consent sentence (D6)", () => {
  it("names the size, the licence, the source, the hash and the destination", () => {
    const s = status();
    const text = consentSentence(s.model.pin, s.model.downloadDir);
    expect(text).toContain("1.04 GB");
    expect(text).toContain("Apache-2.0");
    expect(text).toContain("huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF");
    expect(text).toContain("cc324af0");
    expect(text).toContain("bb046");
    expect(text).toContain("com.calcula.app\\models");
    expect(text).toContain("Nothing else is sent or received");
    expect(text.endsWith("Download now?")).toBe(true);
  });

  it("is one paragraph a native dialog can show", () => {
    const s = status();
    expect(consentSentence(s.model.pin, s.model.downloadDir)).not.toContain("\n");
  });
});

describe("formatSize", () => {
  it("rounds to what a person compares against free disk space", () => {
    expect(formatSize(1_117_320_768)).toBe("1.04 GB");
    expect(formatSize(412 * 1024 * 1024)).toBe("412 MB");
    expect(formatSize(1_000)).toBe("1 KB");
  });
});

describe("the one-line description", () => {
  it("says a missing runtime is a fact about this build, and where it looked", () => {
    const text = describeBuiltin(status({ engine: { present: false, path: null, build: null, searched: ["C:\\a", "C:\\b"] } }));
    expect(text).toContain("does not include the on-board runtime");
    expect(text).toContain("C:\\a; C:\\b");
    expect(text).toContain("npm run fetch:llama-server");
  });

  it("names the download once, with its size and folder, when the model is absent", () => {
    const text = describeBuiltin(status());
    expect(text).toContain("not on this machine yet");
    expect(text).toContain("1.04 GB");
    expect(text).toContain("com.calcula.app\\models");
  });

  it("refuses a wrong-sized file by name and size", () => {
    const s = status();
    s.model = { ...s.model, presence: "mismatch", path: "C:\\x\\m.gguf", foundIn: "downloaded", sizeOnDisk: 5 };
    const text = describeBuiltin(s);
    expect(text).toContain("C:\\x\\m.gguf");
    expect(text).toContain("will not be used");
  });

  it("says where the model is, which build runs it, and that it starts on the first request", () => {
    const s = status();
    s.model = { ...s.model, presence: "present", path: "C:\\x\\m.gguf", foundIn: "downloaded", sizeOnDisk: 1_117_320_768 };
    const text = describeBuiltin(s);
    expect(text).toContain("C:\\x\\m.gguf");
    expect(text).toContain("downloaded");
    expect(text).toContain("llama.cpp b10897");
    expect(text).toContain("Starts on the first request");
    expect(text).toContain("15 minutes");
  });

  it("names the port and the process while it runs", () => {
    const s = status({ running: { port: 4321, baseUrl: "http://127.0.0.1:4321/v1", pid: 99, uptimeSecs: 5, idleSecs: 1, modelPath: "m" } });
    s.model = { ...s.model, presence: "present", path: "m", foundIn: "bundled", sizeOnDisk: 1 };
    const text = describeBuiltin(s);
    expect(text).toContain("port 4321");
    expect(text).toContain("process 99");
    expect(text).toContain("bundled with this installation");
  });

  it("badges the provider entry from the same facts", () => {
    expect(builtinBadge(null)).toBe("");
    expect(builtinBadge(status())).toBe("download needed");
    expect(builtinBadge(status({ engine: { present: false, path: null, build: null, searched: [] } }))).toBe("not in this build");
    const present = status();
    present.model = { ...present.model, presence: "present" };
    expect(builtinBadge(present)).toBe("ready");
    expect(builtinBadge({ ...present, running: { port: 1, baseUrl: "", pid: 1, uptimeSecs: 0, idleSecs: 0, modelPath: "" } })).toBe("running");
  });
});

describe("the download", () => {
  it("listens for progress before invoking and stops listening after, even on failure", async () => {
    h.invoke.mockRejectedValue(new Error("stalled"));
    const seen: unknown[] = [];
    await expect(downloadBuiltinModel((e) => seen.push(e))).rejects.toThrow("stalled");
    expect(h.listeners.length, "subscribed before the command ran").toBe(1);
    expect(h.disposed, "and unsubscribed when it settled").toBe(1);
    expect(h.invoke).toHaveBeenCalledWith("ai_builtin_ensure_model");
  });

  it("forwards progress events and returns the status the command answers with", async () => {
    const done = status();
    h.invoke.mockImplementation(async () => {
      for (const cb of h.listeners) cb({ phase: "downloading", bytes: 10, total: 100 });
      return done;
    });
    const seen: unknown[] = [];
    const result = await downloadBuiltinModel((e) => seen.push(e));
    expect(result).toBe(done);
    expect(seen).toEqual([{ phase: "downloading", bytes: 10, total: 100 }]);
  });
});
