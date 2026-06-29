import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PRIVILEGED_BACKEND_COMMANDS,
  isPrivilegedCommand,
  commandCapability,
  assertExtensionMayInvoke,
  BackendCapabilityError,
  createScopedInvokeBackend,
  createBackendChannel,
} from "../backendCommands";

/** Parse the actual Tauri command names from the generate_handler! macro. */
function backendCommandNames(): Set<string> {
  const libPath = path.resolve(__dirname, "../../../src-tauri/src/lib.rs");
  const src = fs.readFileSync(libPath, "utf8");
  const start = src.indexOf("generate_handler![");
  expect(start, "generate_handler! macro not found in lib.rs").toBeGreaterThan(-1);
  const block = src.slice(start, start + src.slice(start).indexOf("]"));
  const names = new Set<string>();
  // Each entry is `module::command,` or `command,`; capture the final identifier.
  for (const m of block.matchAll(/([a-z_][a-z0-9_]*)\s*,/g)) names.add(m[1]);
  return names;
}

describe("backend command capability model (A3)", () => {
  it("every privileged command exists in the Tauri surface (drift guard)", () => {
    const real = backendCommandNames();
    expect(real.size).toBeGreaterThan(400); // sanity: parsed the macro
    const missing = Object.values(PRIVILEGED_BACKEND_COMMANDS)
      .flat()
      .filter((c) => !real.has(c));
    expect(
      missing,
      `privileged commands not found in generate_handler! (stale registry): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("classifies privileged vs feature-open commands", () => {
    expect(isPrivilegedCommand("run_script")).toBe(true);
    expect(commandCapability("run_script")).toBe("codeExecution");
    expect(commandCapability("write_text_file")).toBe("hostFilesystem");
    expect(commandCapability("keychain_get_password")).toBe("credentials");
    expect(commandCapability("mcp_start")).toBe("mcpServer");
    // A normal data/feature command is open.
    expect(isPrivilegedCommand("get_charts")).toBe(false);
    expect(commandCapability("delete_columns")).toBeNull(); // grid op, not privileged
  });

  it("denies privileged commands for non-trusted callers, allows trusted + open", () => {
    expect(() => assertExtensionMayInvoke("run_script", { trusted: false })).toThrow(
      BackendCapabilityError,
    );
    expect(() => assertExtensionMayInvoke("run_script", { trusted: true })).not.toThrow();
    expect(() => assertExtensionMayInvoke("get_charts", { trusted: false })).not.toThrow();
  });
});

describe("scoped backend door (A3 — ExtensionContext.invokeBackend wiring)", () => {
  // This is the exact factory ExtensionManager wires into each extension's
  // context (createScopedInvokeBackend(trust === "trusted", invokeBackend)), so
  // these assertions cover the real production door, not a reconstruction.

  it("distributed extension: privileged command rejects (raw invoke never runs)", async () => {
    const raw = vi.fn().mockResolvedValue("ok");
    const door = createScopedInvokeBackend(false, raw);
    await expect(door("run_script", { code: "x" })).rejects.toBeInstanceOf(
      BackendCapabilityError,
    );
    expect(raw).not.toHaveBeenCalled();
  });

  it("distributed extension: feature-open command passes through to raw invoke", async () => {
    const raw = vi.fn().mockResolvedValue(["chart-1"]);
    const door = createScopedInvokeBackend(false, raw);
    await expect(door("get_charts")).resolves.toEqual(["chart-1"]);
    expect(raw).toHaveBeenCalledWith("get_charts", undefined);
  });

  it("trusted extension: privileged command passes through (built-ins are unrestricted)", async () => {
    const raw = vi.fn().mockResolvedValue("ran");
    const door = createScopedInvokeBackend(true, raw);
    await expect(door("run_script", { code: "x" })).resolves.toBe("ran");
    expect(raw).toHaveBeenCalledWith("run_script", { code: "x" });
  });

  it("gate failure surfaces as a rejected promise, never a synchronous throw", () => {
    const door = createScopedInvokeBackend(false, vi.fn());
    // Calling must NOT throw synchronously — it returns a promise that rejects.
    let result: Promise<unknown> | undefined;
    expect(() => {
      result = door("write_text_file", { path: "/etc/passwd" });
    }).not.toThrow();
    return expect(result).rejects.toBeInstanceOf(BackendCapabilityError);
  });
});

describe("backend channel (A3 — deferred door for ctx-less extension code)", () => {
  it("rejects before activate() binds it (never silently no-ops)", async () => {
    const channel = createBackendChannel("Slicer");
    expect(channel.bound).toBe(false);
    await expect(channel.invoke("get_all_slicers")).rejects.toThrow(/before activate/i);
  });

  it("delegates to the bound invoker once set(), preserving args + result", async () => {
    const channel = createBackendChannel("Slicer");
    const scoped = vi.fn().mockResolvedValue([{ id: "s1" }]);
    channel.set(scoped);
    expect(channel.bound).toBe(true);
    await expect(channel.invoke("get_all_slicers")).resolves.toEqual([{ id: "s1" }]);
    await channel.invoke("update_slicer", { slicerId: "s1", params: { x: 1 } });
    expect(scoped).toHaveBeenNthCalledWith(1, "get_all_slicers", undefined);
    expect(scoped).toHaveBeenNthCalledWith(2, "update_slicer", { slicerId: "s1", params: { x: 1 } });
  });

  it("late re-binding swaps the invoker (e.g. re-activate)", async () => {
    const channel = createBackendChannel();
    channel.set(vi.fn().mockResolvedValue("a"));
    channel.set(vi.fn().mockResolvedValue("b"));
    await expect(channel.invoke("x")).resolves.toBe("b");
  });

  it("composes with the scoped door: a distributed-bound channel still gates", async () => {
    // A channel bound to a DISTRIBUTED scoped door denies privileged commands.
    const channel = createBackendChannel("ThirdParty");
    channel.set(createScopedInvokeBackend(false, vi.fn().mockResolvedValue("ran")));
    await expect(channel.invoke("run_script", { code: "x" })).rejects.toBeInstanceOf(
      BackendCapabilityError,
    );
    await expect(channel.invoke("get_charts")).resolves.toBe("ran");
  });
});
