//! FILENAME: app/src/api/scriptHost/worker/extensionWorkerContext.ts
// PURPOSE: The worker-side ExtensionContext handed to a sandboxed distributed
//          extension's activate() (Wave 3 / S8-C7 Phase B). It exposes ONLY a
//          data-driven, async-RPC subset: registrations (commands / menu items /
//          event subscriptions) keep their handler in the worker and install a
//          host-side proxy; capabilities + side effects go through the broker.
//          React-component surfaces (ribbon tabs, panels, dialogs, custom cell
//          editors) and synchronous grid hooks CANNOT cross a worker boundary,
//          so accessing them throws a clear, actionable error.
/// <reference lib="webworker" />

import { safeClone } from "./workerHardening";
import {
  EXTENSION_CALL_TIMEOUT_MS,
  type WX2H,
  type ExtRpcError,
} from "../extensionProtocol";

type PostFn = (msg: WX2H) => void;
type Handler = (...args: unknown[]) => unknown;

/** Error a rejected broker call throws into extension code, so it can inspect
 *  `code` (e.g. CapabilityRequired) and degrade gracefully. */
export class ExtensionCallError extends Error {
  code: string;
  capability?: string;
  constructor(error?: ExtRpcError) {
    super(error?.message ?? "extension host call failed");
    this.name = "ExtensionCallError";
    this.code = error?.code ?? "HostError";
    this.capability = error?.detail?.capability;
  }
}

/** Worker-internal control surface the bootstrap drives from host messages. */
export interface ExtWorkerRuntime {
  invokeHandler(reqId: number, handlerId: number, args: unknown[]): Promise<void>;
  dispatchAppEvent(handlerId: number, payload: unknown): void;
  settleCall(callId: number, ok: boolean, value: unknown, error?: ExtRpcError): void;
  runDeactivate(): void;
}

function unsupported(surface: string): never {
  throw new Error(
    `${surface} is not available to a sandboxed (workerSupport) extension. ` +
      `Use commands, ui.menus, events, ui.notifications, or capabilities — or run ` +
      `the extension on the main thread (omit workerSupport from the manifest) for ` +
      `full-trust UI registration.`,
  );
}

export function buildExtensionContext(post: PostFn): {
  context: unknown;
  runtime: ExtWorkerRuntime;
} {
  const handlers = new Map<number, Handler>();
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number }
  >();
  let nextHandlerId = 1;
  let nextRegId = 1;
  let nextCallId = 1;
  let deactivateFn: (() => void) | null = null;

  const registerHandler = (fn: Handler): number => {
    const id = nextHandlerId++;
    handlers.set(id, fn);
    return id;
  };

  const brokerCall = (method: string, args: unknown[]): Promise<unknown> => {
    const callId = nextCallId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = self.setTimeout(() => {
        if (pending.delete(callId)) {
          reject(new ExtensionCallError({ code: "Timeout", message: `${method}: timed out` }));
        }
      }, EXTENSION_CALL_TIMEOUT_MS) as unknown as number;
      pending.set(callId, { resolve, reject, timer });
      post({ t: "call", callId, method, args });
    });
  };

  const context = {
    /** Set by the extension if it returns a deactivate function from activate. */
    onDeactivate(fn: () => void): void {
      deactivateFn = fn;
    },

    commands: {
      register(id: string, handler: Handler, metadata?: Record<string, unknown>): () => void {
        const handlerId = registerHandler(handler);
        const regId = nextRegId++;
        post({ t: "register", reg: { kind: "command", regId, id, handlerId, metadata } });
        return () => {
          handlers.delete(handlerId);
          post({ t: "unregister", regId });
        };
      },
      executeCommand(id: string, args?: unknown): Promise<unknown> {
        return brokerCall("ext.executeCommand", [id, args]);
      },
    },

    ui: {
      notifications: {
        showToast(message: string, opts?: { type?: string }): void {
          void brokerCall("ext.notify", [message, opts?.type]);
        },
      },
      // Menu registration for worker extensions is a planned fast-follow (the
      // host menu registry has no per-item teardown yet); throws clearly for now.
      get menus(): never {
        return unsupported("ui.menus");
      },
      get taskPanes(): never {
        return unsupported("ui.taskPanes");
      },
      get dialogs(): never {
        return unsupported("ui.dialogs");
      },
      get overlays(): never {
        return unsupported("ui.overlays");
      },
      get panels(): never {
        return unsupported("ui.panels");
      },
      get activityBar(): never {
        return unsupported("ui.activityBar");
      },
      get statusBar(): never {
        return unsupported("ui.statusBar");
      },
    },

    events: {
      onAppEvent(name: string, cb: Handler): () => void {
        const handlerId = registerHandler(cb);
        const regId = nextRegId++;
        post({ t: "register", reg: { kind: "event", regId, eventName: name, handlerId } });
        return () => {
          handlers.delete(handlerId);
          post({ t: "unregister", regId });
        };
      },
      emitAppEvent(name: string, payload?: unknown): void {
        void brokerCall("ext.emitEvent", [name, payload]);
      },
    },

    capabilities: {
      fetch(url: string, init?: unknown): Promise<unknown> {
        return brokerCall("cap.fetch", [url, init]);
      },
      storage: {
        get(key: string): Promise<unknown> {
          return brokerCall("cap.storageGet", [key]);
        },
        set(key: string, value: string): Promise<unknown> {
          return brokerCall("cap.storageSet", [key, value]);
        },
      },
      // Structured, model-scoped BI query (no raw SQL). request =
      // { measures, groupBy, filters }; resolves to { columns, rows, rowCount }.
      biQuery(connectionId: string, request: unknown): Promise<unknown> {
        return brokerCall("cap.biQuery", [connectionId, request]);
      },
      listBiConnections(): Promise<unknown> {
        return brokerCall("cap.biListConnections", []);
      },
    },

    // Surfaces that cannot cross the worker boundary throw on access.
    get grid(): never {
      return unsupported("grid");
    },
    get keyboard(): never {
      return unsupported("keyboard");
    },
    get keybindings(): never {
      return unsupported("keybindings");
    },
    get settings(): never {
      return unsupported("settings");
    },
    get cellEditors(): never {
      return unsupported("cellEditors");
    },
    get fileFormats(): never {
      return unsupported("fileFormats");
    },
    get formulas(): never {
      return unsupported("formulas");
    },
  };

  const runtime: ExtWorkerRuntime = {
    async invokeHandler(reqId, handlerId, args) {
      const fn = handlers.get(handlerId);
      if (!fn) {
        post({ t: "handlerResult", reqId, ok: false, error: { code: "UnknownMethod", message: "handler not found" } });
        return;
      }
      try {
        const value = await fn(...args);
        post({ t: "handlerResult", reqId, ok: true, value: safeClone(value) });
      } catch (e) {
        post({
          t: "handlerResult",
          reqId,
          ok: false,
          error: { code: "HostError", message: e instanceof Error ? e.message : String(e) },
        });
      }
    },
    dispatchAppEvent(handlerId, payload) {
      const fn = handlers.get(handlerId);
      if (!fn) return;
      try {
        void fn(payload);
      } catch (e) {
        post({ t: "error", message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      }
    },
    settleCall(callId, ok, value, error) {
      const p = pending.get(callId);
      if (!p) return;
      pending.delete(callId);
      self.clearTimeout(p.timer);
      if (ok) p.resolve(value);
      else p.reject(new ExtensionCallError(error));
    },
    runDeactivate() {
      try {
        deactivateFn?.();
      } catch {
        /* best effort */
      }
    },
  };

  return { context, runtime };
}
