import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PRIVILEGED_BACKEND_COMMANDS,
  isPrivilegedCommand,
  commandCapability,
  assertExtensionMayInvoke,
  BackendCapabilityError,
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
