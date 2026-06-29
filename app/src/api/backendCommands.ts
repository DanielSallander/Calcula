//! FILENAME: app/src/api/backendCommands.ts
// PURPOSE: Capability model for the backend (Tauri) command surface — the data
//   layer for a governed, capability-scoped backend door (A3).
// CONTEXT: The Rust backend exposes ~569 #[tauri::command]s, reached from the
//   frontend via invokeBackend(cmd, args) — an untyped passthrough. Built-in
//   extensions are compiled into the host bundle and import @api/backend
//   directly (trusted, kernel-adjacent). Runtime (third-party) extensions do
//   NOT get @api/backend (no global, no import map) — they only get the
//   injected ExtensionContext, which today exposes NO raw backend access.
//
//   So third-party extensions are already constrained, but the architecture has
//   no DECLARED capability boundary for backend commands. This module is that
//   declaration, as data (mirroring the script broker's ALLOWLIST): it names the
//   privileged commands that a non-trusted caller must never invoke, so when the
//   ExtensionContext gains a governed `invokeBackend` (the planned facade), the
//   enforcement is one lookup away. See docs/design/backend-facade.md.

/** Security-critical command categories — the "VBA-escape" surface. */
export type PrivilegedCapability =
  | "codeExecution"
  | "hostFilesystem"
  | "credentials"
  | "extensionManagement"
  | "mcpServer";

/**
 * Backend commands that must NEVER be callable by a non-trusted (third-party)
 * extension. Grouped by capability. Everything NOT listed here is "feature-open"
 * (a normal data/feature command a third party could legitimately use through a
 * future governed door). This is intentionally a DENYLIST of the dangerous few,
 * not an allowlist of the safe many — the danger is concentrated.
 */
export const PRIVILEGED_BACKEND_COMMANDS: Record<PrivilegedCapability, readonly string[]> = {
  // Arbitrary code execution and script-capability grants.
  codeExecution: [
    "run_script",
    "notebook_run_cell",
    "notebook_run_all",
    "notebook_run_from",
    "grant_script_session_approval",
    "grant_script_net_origin",
    "set_script_security_level",
    "script_http_fetch",
    "script_bi_sql",
  ],
  // Reading/writing the host filesystem (outside the workbook archive).
  hostFilesystem: [
    "read_text_file",
    "write_text_file",
    "write_binary_file",
    "sort_log_file",
  ],
  // OS credential store.
  credentials: [
    "keychain_get_password",
    "keychain_set_password",
    "keychain_delete_password",
    "keychain_has_password",
  ],
  // Installing / removing / scanning extensions from disk.
  extensionManagement: [
    "scan_extension_directory",
    "uninstall_extension",
  ],
  // Starting the local MCP server (exposes the live workbook to external clients).
  mcpServer: ["mcp_start", "mcp_stop", "mcp_set_port", "mcp_status"],
};

/** Flat set of all privileged command names (built once). */
const PRIVILEGED_SET: ReadonlySet<string> = new Set(
  Object.values(PRIVILEGED_BACKEND_COMMANDS).flat(),
);

/** The capability a command belongs to, or null if it is feature-open. */
export function commandCapability(command: string): PrivilegedCapability | null {
  for (const cap of Object.keys(PRIVILEGED_BACKEND_COMMANDS) as PrivilegedCapability[]) {
    if (PRIVILEGED_BACKEND_COMMANDS[cap].includes(command)) return cap;
  }
  return null;
}

/** True if the command is in the privileged (never-for-untrusted) set. */
export function isPrivilegedCommand(command: string): boolean {
  return PRIVILEGED_SET.has(command);
}

/** Thrown when a non-trusted caller attempts a privileged backend command. */
export class BackendCapabilityError extends Error {
  readonly command: string;
  readonly capability: PrivilegedCapability;
  constructor(command: string, capability: PrivilegedCapability) {
    super(
      `Backend command "${command}" requires the "${capability}" capability, ` +
        `which is not granted to this extension.`,
    );
    this.name = "BackendCapabilityError";
    this.command = command;
    this.capability = capability;
  }
}

/**
 * The capability check for a governed backend door. Trusted (built-in) callers
 * pass everything; a non-trusted caller is denied privileged commands. This is
 * the primitive the planned scoped `ExtensionContext.invokeBackend` will call —
 * see docs/design/backend-facade.md. It is intentionally pure + side-effect-free
 * so it can be unit-tested and reused on both the main thread and worker realm.
 */
export function assertExtensionMayInvoke(
  command: string,
  options: { trusted: boolean },
): void {
  if (options.trusted) return;
  const cap = commandCapability(command);
  if (cap) throw new BackendCapabilityError(command, cap);
}

/** Args object accepted by a backend invoke (mirrors @api/backend InvokeArgs). */
export type BackendInvokeArgs = Record<string, unknown>;

/** A raw backend invoker — the ungated passthrough this door wraps. */
export type RawBackendInvoke = <T>(command: string, args?: BackendInvokeArgs) => Promise<T>;

/**
 * Build the capability-scoped backend door wired into each extension's
 * `ExtensionContext.invokeBackend` (A3). It runs the trust gate
 * (`assertExtensionMayInvoke`) and only then delegates to the raw invoker.
 * Always returns a Promise (the gate failure surfaces as a REJECTED promise,
 * never a synchronous throw), so callers can rely on `.catch`/`await` uniformly.
 *
 * Kept as a pure factory here, beside the denylist + primitive, so the door's
 * behavior is unit-testable against the real enforcement logic rather than a
 * reconstruction. The host (ExtensionManager) supplies `trusted` (from the
 * extension's trust classification) and the raw invoker.
 */
export function createScopedInvokeBackend(
  trusted: boolean,
  rawInvoke: RawBackendInvoke,
): RawBackendInvoke {
  return async <T>(command: string, args?: BackendInvokeArgs): Promise<T> => {
    assertExtensionMayInvoke(command, { trusted });
    return rawInvoke<T>(command, args);
  };
}

/**
 * A deferred backend door for extension code that runs OUTSIDE the
 * ExtensionContext and therefore cannot reach `ctx.invokeBackend` directly —
 * lib-api wrapper modules, zustand stores, and React components (none of which
 * receive `ctx`). The extension binds the channel once in `activate()`
 * (`channel.set(ctx.invokeBackend)`); the module's functions then call
 * `channel.invoke(cmd, args)`, so every call flows through the SAME
 * capability-gated door as `ctx.invokeBackend` (A3) instead of the raw
 * `@api/backend` passthrough.
 *
 * Until bound, `invoke()` REJECTS with a clear message (a call ran before
 * `activate()` bound the channel) rather than silently no-op'ing. For
 * surfaces that run in a separate window/realm where the extension's
 * `activate()` does not execute (e.g. the standalone script-editor window),
 * that window's own entry point binds the channel with its own scoped invoker.
 */
export interface BackendChannel {
  /** Bind the channel to a scoped invoker. Call once, in activate() (or a window entry). */
  set(invoke: RawBackendInvoke): void;
  /** Invoke a backend command through the bound scoped door. */
  invoke: RawBackendInvoke;
  /** True once `set()` has bound an invoker. */
  readonly bound: boolean;
}

export function createBackendChannel(label = "extension"): BackendChannel {
  let invoker: RawBackendInvoke | null = null;
  return {
    set(invoke: RawBackendInvoke) {
      invoker = invoke;
    },
    invoke: <T>(command: string, args?: BackendInvokeArgs): Promise<T> => {
      if (!invoker) {
        return Promise.reject(
          new Error(
            `Backend channel for "${label}" was used before activate() bound it. ` +
              `Call <channel>.set(ctx.invokeBackend) at the top of the extension's activate().`,
          ),
        );
      }
      return invoker<T>(command, args);
    },
    get bound() {
      return invoker !== null;
    },
  };
}
