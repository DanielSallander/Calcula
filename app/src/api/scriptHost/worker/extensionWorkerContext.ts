//! FILENAME: app/src/api/scriptHost/worker/extensionWorkerContext.ts
// PURPOSE: The worker-side ExtensionContext handed to a sandboxed distributed
//          extension's activate() (Wave 3 / S8-C7 Phase B; contribution surface
//          added by the third-party add-in slice —
//          docs/design/third-party-addin-authoring.md).
//
//          It exposes ONLY a data-driven, async-RPC subset:
//            - REGISTRATIONS keep their handler in the worker and install a
//              host-side proxy. Commands, menu items and event subscriptions
//              have always worked this way; worksheet FUNCTIONS, ribbon
//              buttons, keyboard shortcuts, cell styling and file-format
//              importers now work the same way. What crosses is a DESCRIPTOR
//              the trusted host renders/registers — never a component, never
//              markup, never a closure.
//            - CAPABILITIES + side effects go through the broker, so the
//              declared-capability ceiling, consent and audit apply.
//
//          Surfaces that still cannot cross are the ones that demand a live
//          React component (panels, task panes, custom cell editors) or a
//          SYNCHRONOUS answer inside a paint/recalc tick. Accessing them throws
//          a clear, actionable error naming the declarative equivalent.
/// <reference lib="webworker" />

import { safeClone } from "./workerHardening";
import {
  EXTENSION_CALL_TIMEOUT_MS,
  type WX2H,
  type ExtContributionDeclaration,
  type ExtFileFormatData,
  type ExtFormulaDef,
  type ExtKeybindingData,
  type ExtPackageInfo,
  type ExtRibbonButtonData,
  type ExtRpcError,
  type ExtMenuItemData,
} from "../extensionProtocol";
import { METHOD_DEADLINES_MS } from "../protocol";
import type {
  ScriptDialogFormSpec,
  ScriptDialogPromptOptions,
  ScriptDialogTextOptions,
} from "../scriptDialogSpec";

type PostFn = (msg: WX2H) => void;
type Handler = (...args: unknown[]) => unknown;

/** Options an extension passes to formulas.registerFunction (everything except
 *  the name, which is the first positional argument, and the implementation). */
export type ExtFormulaOptions = Omit<ExtFormulaDef, "name">;

/** capabilities.file.exportText options (file.picker). No field names a
 *  location: the labels only change words on the picker's file-type row. */
export interface ExtFileExportOptions {
  mimeType?: string;
  encoding?: "utf-8" | "utf-8-bom" | "ansi";
  description?: string;
}

/** capabilities.file.importText options (file.picker). */
export interface ExtFileImportOptions {
  /** Extensions without dots, e.g. ["csv"]. Filters what the picker OFFERS. */
  extensions?: string[];
  description?: string;
}

/** What capabilities.file.importText resolves to: the file NAME the user saw in
 *  the picker (never its folder) and its text. */
export interface ExtImportedFile {
  name: string;
  content: string;
}

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

/**
 * A surface a sandboxed extension cannot have, with the declarative equivalent
 * it should use instead. There is no "run it on the main thread" escape here:
 * third-party code stays sandboxed by design (the one thing
 * docs/design/third-party-addin-authoring.md rejects is moving that boundary),
 * so the message points at what CAN be done rather than at a trust escalation
 * that does not exist.
 */
function unsupported(surface: string, instead: string): never {
  throw new Error(
    `${surface} is not available to a sandboxed extension — it needs a live ` +
      `component or a synchronous answer, neither of which can cross the worker ` +
      `boundary. ${instead}`,
  );
}

export function buildExtensionContext(
  post: PostFn,
  packageInfo: ExtPackageInfo,
  contributes: ExtContributionDeclaration = {},
): {
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
    // The ui.dialog family blocks on a person, so it gets the long deadline
    // (shared with object scripts via protocol.ts) instead of the 30s that
    // bounds machine work.
    const deadline = METHOD_DEADLINES_MS[method] ?? EXTENSION_CALL_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = self.setTimeout(() => {
        if (pending.delete(callId)) {
          reject(new ExtensionCallError({ code: "Timeout", message: `${method}: timed out` }));
        }
      }, deadline) as unknown as number;
      pending.set(callId, { resolve, reject, timer });
      post({ t: "call", callId, method, args });
    });
  };

  const context = {
    /**
     * Which distributed bundle (and version) this extension is running as.
     * Host-built from the authoritative manifest and frozen — an extension
     * cannot rewrite its own provenance before handing the object to anyone.
     */
    package: Object.freeze({
      name: packageInfo.name,
      version: packageInfo.version,
      provenance: packageInfo.provenance,
    }),

    /**
     * The contribution ceiling the host will enforce, mirrored read-only from
     * the AUTHORITATIVE manifest. An extension can branch on it ("my formulas
     * were not declared, so degrade to a menu command") instead of discovering
     * the refusal through a toast. Display only: the host re-checks every
     * registration against its own copy.
     */
    contributes: Object.freeze({
      formulas: Object.freeze([...(contributes.formulas ?? [])]),
      commands: Object.freeze([...(contributes.commands ?? [])]),
      menuItems: Object.freeze([...(contributes.menuItems ?? [])]),
      ribbonButtons: Object.freeze([...(contributes.ribbonButtons ?? [])]),
      keybindings: Object.freeze([...(contributes.keybindings ?? [])]),
      cellStyles: Object.freeze([...(contributes.cellStyles ?? [])]),
      fileFormats: Object.freeze([...(contributes.fileFormats ?? [])]),
    }),

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
      menus: {
        /**
         * Register a menu item. `command` runs a registered command id on click;
         * `onClick` relays to a worker-side handler. The item DATA crosses; the
         * handler stays in the worker (the host installs a proxy).
         */
        registerMenuItem(
          menuId: string,
          item: ExtMenuItemData & { command?: string; onClick?: Handler },
        ): () => void {
          const regId = nextRegId++;
          let handlerId: number | undefined;
          if (typeof item.onClick === "function") handlerId = registerHandler(item.onClick);
          const data: ExtMenuItemData = {
            id: item.id,
            label: item.label,
            icon: item.icon,
            order: item.order,
            separator: item.separator,
          };
          post({
            t: "register",
            reg: { kind: "menuItem", regId, menuId, item: data, commandId: item.command, handlerId },
          });
          return () => {
            if (handlerId !== undefined) handlers.delete(handlerId);
            post({ t: "unregister", regId });
          };
        },
      },
      ribbon: {
        /**
         * Contribute a ribbon BUTTON. The host draws it (under the "Add-ins"
         * tab, grouped by extension) from this descriptor and runs the named
         * command on click — there is no click callback, so a sandboxed
         * extension can never paint or capture inside the app frame.
         */
        registerButton(button: ExtRibbonButtonData): () => void {
          const regId = nextRegId++;
          post({
            t: "register",
            reg: {
              kind: "ribbonButton",
              regId,
              button: {
                id: button.id,
                label: button.label,
                group: button.group,
                icon: button.icon,
                tooltip: button.tooltip,
                order: button.order,
                command: button.command,
              },
            },
          });
          return () => post({ t: "unregister", regId });
        },
      },
      get taskPanes(): never {
        return unsupported(
          "ui.taskPanes",
          "Use ui.ribbon.registerButton + capabilities.dialog.form for an input surface.",
        );
      },
      get dialogs(): never {
        // ui.dialogs registers a React COMPONENT, which cannot cross a worker
        // boundary. Asking the user something can: capabilities.dialog.* renders
        // a declarative modal in trusted host code and resolves with the answer.
        return unsupported(
          "ui.dialogs",
          "To ask the user something use capabilities.dialog.confirm / prompt / form — the host paints the modal from your data.",
        );
      },
      get overlays(): never {
        return unsupported("ui.overlays", "No declarative equivalent exists yet.");
      },
      get panels(): never {
        return unsupported(
          "ui.panels",
          "Use ui.ribbon.registerButton; a host-rendered panel surface is a later slice.",
        );
      },
      get activityBar(): never {
        return unsupported("ui.activityBar", "Use ui.ribbon.registerButton or ui.menus.registerMenuItem.");
      },
      get statusBar(): never {
        return unsupported("ui.statusBar", "Use ui.notifications.showToast.");
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
      // Higher-trust RAW SQL (read-only; needs the separate bi.sql capability).
      biSql(connectionId: string, sql: string): Promise<unknown> {
        return brokerCall("cap.biSql", [connectionId, sql]);
      },
      listBiConnections(): Promise<unknown> {
        return brokerCall("cap.biListConnections", []);
      },
      // CUBE convenience (bi.query trust class): query a BI model with member-
      // expression ergonomics instead of building a QueryRequest. `connection`
      // is a connection name or id; members are CUBE member expressions like
      // "[Revenue]" or "Geo[Country]=Sweden".
      cube: {
        value(connection: string, ...members: string[]): Promise<number | null> {
          return brokerCall("cap.cubeValue", [connection, members]) as Promise<number | null>;
        },
        kpi(connection: string, kpi: string, property: number): Promise<number | null> {
          return brokerCall("cap.cubeKpi", [connection, kpi, property]) as Promise<number | null>;
        },
        members(connection: string, level: string): Promise<string[]> {
          return brokerCall("cap.cubeMembers", [connection, level]) as Promise<string[]>;
        },
      },
      // Governed model definitions (the bi.model capability): sanitized read +
      // undoable, audited mutation via the Rust script_bi_model gateway. RLS
      // roles, connections/credentials, storage/refresh knobs are not reachable.
      biModel: {
        info(connectionId: string): Promise<unknown> {
          return brokerCall("cap.biModelInfo", [connectionId]);
        },
        upsert(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown> {
          return brokerCall("cap.biModelUpsert", [connectionId, kind, payload]);
        },
        delete(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown> {
          return brokerCall("cap.biModelDelete", [connectionId, kind, payload]);
        },
        // Read-only diagnostics (own 120/min Rust bucket, so they still answer
        // once the mutation budget is spent). Answers and error text are
        // rebuilt/scrubbed Rust-side: no role, source, host or database name.
        validateMeasure(connectionId: string, name: string, formula: string, originalName?: string): Promise<unknown> {
          return brokerCall("cap.biModelValidate", [
            connectionId,
            "validateMeasure",
            { name, formula, originalName: originalName ?? null },
          ]);
        },
        validateContext(connectionId: string, name: string, expression: string, originalName?: string): Promise<unknown> {
          return brokerCall("cap.biModelValidate", [
            connectionId,
            "validateContext",
            { name, expression, originalName: originalName ?? null },
          ]);
        },
        validateModel(connectionId: string): Promise<unknown> {
          return brokerCall("cap.biModelValidate", [connectionId, "validateModel", {}]);
        },
        dependencyGraph(connectionId: string): Promise<unknown> {
          return brokerCall("cap.biModelLineage", [connectionId, "dependencyGraph", {}]);
        },
        measureLineage(connectionId: string, name: string): Promise<unknown> {
          return brokerCall("cap.biModelLineage", [connectionId, "measureLineage", { name }]);
        },
        dependents(connectionId: string, kind: string, name: string, table?: string): Promise<unknown> {
          return brokerCall("cap.biModelLineage", [
            connectionId,
            "dependents",
            { kind, name, table: table ?? null },
          ]);
        },
        // Atomicity, never budget: batchBegin costs a mutation token and each
        // edit inside still costs one. Only the opener may close it.
        batchBegin(connectionId: string): Promise<unknown> {
          return brokerCall("cap.biModelBatch", [connectionId, "batchBegin"]);
        },
        batchEnd(connectionId: string): Promise<unknown> {
          return brokerCall("cap.biModelBatch", [connectionId, "batchEnd"]);
        },
        batchCancel(connectionId: string): Promise<unknown> {
          return brokerCall("cap.biModelBatch", [connectionId, "batchCancel"]);
        },
      },
      // The .calp collection loop (the distribution.writeback capability).
      // listSubmissions / setSubmissionState act on OTHER PEOPLE'S submitted
      // data and are additionally gated on Ed25519 package-signing key
      // possession in Rust — the capability alone never buys them.
      writeback: {
        listRegions(): Promise<unknown> {
          return brokerCall("cap.writebackListRegions", []);
        },
        getLayer(): Promise<unknown> {
          return brokerCall("cap.writebackGetLayer", []);
        },
        saveDraft(
          regionId: string,
          sheetId: string,
          row: number,
          col: number,
          value: unknown,
        ): Promise<unknown> {
          return brokerCall("cap.writebackSaveDraft", [regionId, sheetId, row, col, value]);
        },
        submitRegion(regionId: string): Promise<unknown> {
          return brokerCall("cap.writebackSubmit", [regionId]);
        },
        previewSubmission(regionId: string): Promise<unknown> {
          return brokerCall("cap.writebackPreview", [regionId]);
        },
        listSubmissions(target: Record<string, unknown>): Promise<unknown> {
          return brokerCall("cap.writebackListSubmissions", [target]);
        },
        setSubmissionState(decision: Record<string, unknown>): Promise<unknown> {
          return brokerCall("cap.writebackReview", [decision]);
        },
      },
      // Persistent recurring jobs (the `schedule` capability). `handlerName`
      // must be a method the extension published with context.expose(...) —
      // a schedule stores a NAME, never a closure, so what it will run stays
      // reviewable in the transparency panel after the workbook reloads.
      //
      // Jobs live in the workbook and resume when it is reopened, but only
      // while Calcula is open: there is no headless runtime behind this.
      schedule: {
        every(
          intervalSecs: number,
          handlerName: string,
          options?: { label?: string },
        ): Promise<unknown> {
          return brokerCall("cap.scheduleEvery", [intervalSecs, handlerName, options]);
        },
        at(
          timeOfDay: string,
          handlerName: string,
          options?: { label?: string },
        ): Promise<unknown> {
          return brokerCall("cap.scheduleAt", [timeOfDay, handlerName, options]);
        },
        list(): Promise<unknown> {
          return brokerCall("cap.scheduleList", []);
        },
        cancel(jobId: string): Promise<unknown> {
          return brokerCall("cap.scheduleCancel", [jobId]);
        },
      },
      // Modal question + declarative form (the ui.dialog capability). A
      // sandboxed extension cannot register UI, but it CAN ask — the dialog is
      // painted by trusted host code from this data-only spec, headed by the
      // extension's own name so it can never pass itself off as the app.
      // Dismissal resolves (false / null); it never rejects.
      dialog: {
        alert(message: string, options?: ScriptDialogTextOptions): Promise<void> {
          return brokerCall("cap.dialogAlert", [message, options]) as Promise<void>;
        },
        confirm(message: string, options?: ScriptDialogTextOptions): Promise<boolean> {
          return brokerCall("cap.dialogConfirm", [message, options]) as Promise<boolean>;
        },
        prompt(message: string, options?: ScriptDialogPromptOptions): Promise<string | null> {
          return brokerCall("cap.dialogPrompt", [message, options]) as Promise<string | null>;
        },
        form(spec: ScriptDialogFormSpec): Promise<Record<string, unknown> | null> {
          return brokerCall("cap.dialogForm", [spec]) as Promise<Record<string, unknown> | null>;
        },
      },
      // User-chosen file export / import (the file.picker capability) — the
      // "export this as CSV" button an add-in exists to provide. The extension
      // hands over a file NAME and the CONTENT; the HOST opens a native picker
      // and the USER chooses the file. No path is accepted and none is returned,
      // so a sandboxed extension has no way to name, remember or re-open a
      // location on this machine.
      //
      // Note the asymmetry with `fileFormats` below: registerImporter is allowed
      // because the host feeds it bytes the user already chose to open, and
      // registerFormat (an exporter) is refused because it would be handed
      // ambient whole-workbook read authority. These two methods are neither —
      // the extension supplies the content it already has.
      file: {
        /** Save `content` to a file the user picks; resolves to the chosen file
         *  NAME, or null if they cancelled. */
        exportText(
          suggestedName: string,
          content: string,
          options?: ExtFileExportOptions,
        ): Promise<string | null> {
          return brokerCall("cap.fileExportText", [
            suggestedName,
            content,
            options,
          ]) as Promise<string | null>;
        },
        /** Read a file the user picks; resolves to { name, content }, or null if
         *  they cancelled. Rejects (never truncates) an oversized file. */
        importText(options?: ExtFileImportOptions): Promise<ExtImportedFile | null> {
          return brokerCall("cap.fileImportText", [options]) as Promise<ExtImportedFile | null>;
        },
        /**
         * Save the sheet the user would PRINT as a PDF, to a file they pick.
         * Resolves to the chosen file NAME, or null if they cancelled.
         *
         * Safer than exportText by construction: the extension supplies no
         * content at all. Calcula renders the document from the workbook's own
         * page setup, print area, print titles, page breaks and headers/footers
         * — the same path File > Export to PDF takes — so there is nothing here
         * an extension could use to write bytes of its own choosing.
         */
        exportPdf(suggestedName?: string): Promise<string | null> {
          return brokerCall("cap.filePrintPdf", [suggestedName]) as Promise<string | null>;
        },
      },
    },

    /**
     * WORKSHEET FUNCTIONS — the `.xlam` function-library case, and the reason
     * this slice exists. The implementation stays in the worker; the host
     * registers a real UDF whose body RPCs back here through the same relay a
     * command click uses, and the recalculation path (formulaUdf.ts) brokers
     * every invocation under the formula.udf capability.
     *
     * `impl` receives the evaluated argument VALUES and returns a scalar, an
     * array (which spills), or `{ __calculaError: "#N/A" }` for an explicit
     * cell error. It may be async; it must answer within the host's
     * EXTENSION_HANDLER_TIMEOUT_MS budget or the cell shows an error.
     */
    formulas: {
      registerFunction(
        name: string,
        options: ExtFormulaOptions,
        impl: Handler,
      ): () => void {
        const handlerId = registerHandler(impl);
        const regId = nextRegId++;
        const params = (options?.params ?? []).map(String);
        post({
          t: "register",
          reg: {
            kind: "formula",
            regId,
            handlerId,
            def: {
              name: String(name),
              description: options?.description,
              params,
              minArgs: options?.minArgs,
              maxArgs: options?.maxArgs,
              volatile: options?.volatile === true,
            },
          },
        });
        return () => {
          handlers.delete(handlerId);
          post({ t: "unregister", regId });
        };
      },
    },

    /** KEYBOARD SHORTCUTS. Data only: a combo bound to one of the extension's
     *  own commands. The host owns the listener and the conflict resolution, so
     *  an extension can neither observe keystrokes nor steal an app shortcut. */
    keybindings: {
      register(binding: ExtKeybindingData): () => void {
        const regId = nextRegId++;
        post({
          t: "register",
          reg: {
            kind: "keybinding",
            regId,
            binding: {
              id: binding.id,
              combo: binding.combo,
              command: binding.command,
              label: binding.label,
              context: binding.context,
            },
          },
        });
        return () => post({ t: "unregister", regId });
      },
    },

    grid: {
      /**
       * CELL STYLING — the safe subset of "grid decorations". A style
       * interceptor must answer INSIDE the paint loop, which a worker can never
       * do; so the host installs the same stale-while-revalidate style cache
       * object scripts' `cell.onRender` uses (renderCache.ts): the extension is
       * asked in BATCHES, off the paint path, and its answers are cached until
       * the underlying cells change. The cost is a one-frame lag on first
       * paint; the benefit is that no untrusted code runs inside a frame.
       *
       * `handler` receives an array of `{ row, col, sheetIndex, value }` and
       * returns an array of style overrides (or nulls) of the SAME length. The
       * host sanitizes every returned override against a fixed key set.
       */
      cellStyles: {
        register(id: string, handler: Handler): () => void {
          const handlerId = registerHandler(handler);
          const regId = nextRegId++;
          post({ t: "register", reg: { kind: "cellStyle", regId, id: String(id), handlerId } });
          return () => {
            handlers.delete(handlerId);
            post({ t: "unregister", regId });
          };
        },
        /** Drop this extension's cached styles so the next paint re-asks. */
        invalidate(): void {
          void brokerCall("ext.invalidateCellStyles", []);
        },
      },
      get decorations(): never {
        return unsupported(
          "grid.decorations",
          "A decoration draws on the shared canvas synchronously. Use grid.cellStyles.register for background/text styling.",
        );
      },
      get styleInterceptors(): never {
        return unsupported("grid.styleInterceptors", "Use grid.cellStyles.register.");
      },
      get overlays(): never {
        return unsupported("grid.overlays", "No declarative equivalent exists yet.");
      },
      get editGuards(): never {
        return unsupported(
          "grid.editGuards",
          "A guard must veto an edit synchronously; no declarative equivalent exists yet.",
        );
      },
      get rangeGuards(): never {
        return unsupported("grid.rangeGuards", "No declarative equivalent exists yet.");
      },
      get cellClicks(): never {
        return unsupported("grid.cellClicks", "No declarative equivalent exists yet.");
      },
      get cellTypes(): never {
        return unsupported("grid.cellTypes", "A cell type renders a component; no declarative equivalent exists yet.");
      },
      get layers(): never {
        return unsupported("grid.layers", "No declarative equivalent exists yet.");
      },
    },

    /**
     * FILE FORMATS — import only, and deliberately so. The HOST does all I/O:
     * it opens the file the user chose and hands the bytes here; the importer
     * returns cell data. An EXPORTER is handed a live workbook-reading context
     * (getCell / getUsedRange), which is ambient whole-workbook read authority
     * with no capability in the vocabulary to describe it — so it is refused
     * rather than smuggled in behind a file dialog.
     */
    fileFormats: {
      registerImporter(format: ExtFileFormatData, importer: Handler): () => void {
        const handlerId = registerHandler(importer);
        const regId = nextRegId++;
        post({
          t: "register",
          reg: {
            kind: "fileFormat",
            regId,
            handlerId,
            format: {
              id: format.id,
              name: format.name,
              extensions: (format.extensions ?? []).map(String),
              priority: format.priority,
            },
          },
        });
        return () => {
          handlers.delete(handlerId);
          post({ t: "unregister", regId });
        };
      },
      get registerFormat(): never {
        return unsupported(
          "fileFormats.registerFormat",
          "Use fileFormats.registerImporter — an exporter needs whole-workbook read authority the sandbox has no capability for.",
        );
      },
    },

    // Surfaces that cannot cross the worker boundary throw on access.
    get keyboard(): never {
      return unsupported(
        "keyboard",
        "Raw key handling would let an extension observe every keystroke. Use keybindings.register to bind one combo to one of your commands.",
      );
    },
    get settings(): never {
      return unsupported(
        "settings",
        "Use capabilities.storage.get / set for extension-private state.",
      );
    },
    get cellEditors(): never {
      return unsupported(
        "cellEditors",
        "A cell editor is a live React component; no declarative equivalent exists yet.",
      );
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
