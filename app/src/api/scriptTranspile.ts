//! FILENAME: app/src/api/scriptTranspile.ts
// PURPOSE: Turn user-authored script text into the JavaScript that will actually
//          run — at SAVE time, in trusted host code, with a hard failure when the
//          text does not compile.
// CONTEXT: Object scripts are executed by importing their `source` as a blob ES
//          module inside a hardened Worker realm (see scriptHost/host.ts). There
//          is no build step behind that import, so the STORED text must be plain
//          JavaScript. The editors, however, advertise TypeScript: the product
//          describes objects as "user-scriptable via TypeScript" and ships a
//          generated objectContexts.d.ts describing the whole surface.
//
//          This module is the bridge, and it is deliberately built around ONE
//          rule:
//
//            EXACTLY ONE ARTIFACT LEAVES HERE — the JavaScript that runs.
//
//          Why that matters for the security bar, not just for tidiness:
//
//          * The consent binding hashes `script.source` (scriptSecurity.ts:600,
//            :863, :925) and lapses a stored capability grant when the hash
//            changes. The transparency panel and the audit trail show the same
//            field. If we stored an authoring copy ALONGSIDE the executable one,
//            "the code you were shown" and "the code that ran" would be two
//            different strings that a hand-built .calp could make disagree —
//            consent text would stop matching real reach. One artifact makes
//            that class of divergence impossible by construction rather than by
//            a check someone has to remember to run.
//          * `.cala` persistence and `.calp` distribution carry `source`
//            verbatim; a second field would have to be carried, versioned,
//            signed and re-verified everywhere. Nothing here needs a format
//            change: the JavaScript we emit is just a script source.
//
//          The cost is that TypeScript annotations are a compile-time authoring
//          aid, not a round-trip artifact: saving a TypeScript script stores (and
//          the editor then shows) the emitted JavaScript. That is the honest
//          trade — the author sees exactly the text that will run, be hashed,
//          be shown to a reviewer and be distributed. JSDoc types (`@param
//          {ObjectScriptContext} context`) survive transpilation untouched and
//          remain the round-trippable way to type a script.
//
//          NOTHING USER-AUTHORED EXECUTES HERE. `ts.transpileModule` is a pure
//          text-to-text transform: parse, drop types, print. It runs no script,
//          resolves no imports and touches no file system.
//
//          WHY THE `typescript` PACKAGE AND NOT esbuild. esbuild IS already a
//          dependency (Vite's), but it is a native Node binary with no browser
//          build — it cannot run in the WebView where a save happens. The
//          `typescript` package is already installed (the object-script typings
//          generator and its lockstep tests use it), is the same compiler Monaco
//          embeds for the editor's diagnostics, and bundles for the browser
//          cleanly. It is imported DYNAMICALLY so it lands in its own lazy chunk
//          (~3.5 MB minified, verified in `vite build`) that is fetched the
//          first time someone saves a script and never on startup.

/** One compile error, positioned for display next to the author's code. */
export interface ScriptSyntaxError {
  /** 1-based line in the authored text. */
  line: number;
  /** 1-based column in the authored text. */
  column: number;
  /** TypeScript diagnostic code (e.g. 1005). */
  code: number;
  /** Flattened, human-readable message. */
  message: string;
}

/** The compile succeeded; `javascript` is what must be stored and run. */
export interface ScriptTranspileSuccess {
  ok: true;
  /**
   * The JavaScript to store. When the authored text was already valid
   * JavaScript this is the ORIGINAL string, byte for byte — see `transformed`.
   */
  javascript: string;
  /**
   * True when the authored text was TypeScript and had to be compiled, i.e.
   * when `javascript !== source`. False means "stored verbatim": an existing
   * JavaScript script re-saved unchanged keeps its exact bytes, so its
   * source hash — and therefore its capability grant — does not lapse.
   */
  transformed: boolean;
}

/** The compile failed. The caller MUST abort the save. */
export interface ScriptTranspileFailure {
  ok: false;
  /** Positioned errors, in source order. Never empty. */
  errors: ScriptSyntaxError[];
  /** A single line suitable for a toast or a console entry. */
  message: string;
}

export type ScriptTranspileResult = ScriptTranspileSuccess | ScriptTranspileFailure;

/**
 * The compiler settings the save-time transpile uses.
 *
 * `module: ESNext` is load-bearing: the worker imports the stored text as an ES
 * module, so `import`/`export` must survive verbatim. Emitting CommonJS here
 * would produce a `require(...)` that fails at mount with no useful message.
 *
 * `target: ESNext` keeps async/await, classes and optional chaining as written —
 * the worker realm is the same engine the editor runs in, so down-levelling
 * would only obscure the stored text.
 *
 * `removeComments: false` keeps `// @capability` pragmas (the backend derives a
 * script's declared ceiling from them) and JSDoc in the emitted JavaScript. A
 * transpile that silently dropped a capability pragma would change what the
 * backend believes the script may reach.
 */
export interface ScriptTranspileCompilerOptions {
  target: number;
  module: number;
  removeComments: boolean;
  isolatedModules: boolean;
  newLine: number;
  jsx?: number;
}

/** Loaded lazily: the compiler is ~9 MB and is only needed when a human saves. */
type TypeScriptModule = typeof import("typescript");
let compilerPromise: Promise<TypeScriptModule> | null = null;

async function loadCompiler(): Promise<TypeScriptModule> {
  if (!compilerPromise) {
    compilerPromise = import("typescript")
      .then((mod) => {
        // `typescript` is CommonJS; bundlers and Node both expose the real
        // module object on `default`, while a namespace-interop shim exposes it
        // directly. Accept either, then prove it is the compiler we expect.
        const candidate = ((mod as unknown as { default?: TypeScriptModule }).default ??
          mod) as TypeScriptModule;
        if (typeof candidate?.transpileModule !== "function") {
          throw new Error("the TypeScript compiler module did not expose transpileModule");
        }
        return candidate;
      })
      .catch((err) => {
        // Never cache a failed load: a transient chunk failure must not
        // permanently disable saving.
        compilerPromise = null;
        throw err;
      });
  }
  return compilerPromise;
}

/**
 * Start loading the compiler without blocking anything.
 *
 * Editors call this when they mount so the first save is not the moment the
 * chunk is fetched. It is fire-and-forget by design: mounting must not depend
 * on it, and a failure here is only re-tried at save time, where it can be
 * reported to the author.
 */
export function prefetchScriptTranspiler(): void {
  void loadCompiler().catch(() => {
    /* reported at save time, where there is a place to show it */
  });
}

/** Test seam: forget the cached compiler module. */
export function resetScriptTranspilerForTest(): void {
  compilerPromise = null;
}

function toSyntaxErrors(
  ts: TypeScriptModule,
  diagnostics: readonly import("typescript").Diagnostic[],
): ScriptSyntaxError[] {
  return diagnostics
    .map((d) => {
      let line = 1;
      let column = 1;
      if (d.file && typeof d.start === "number") {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        line = pos.line + 1;
        column = pos.character + 1;
      }
      return {
        line,
        column,
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, " "),
      };
    })
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Does this text contain JSX?
 *
 * Needed because TypeScript parses `.js` files with the JSX language variant:
 * `const a = <div>hi</div>;` is a CLEAN parse as JavaScript, so the "already
 * JavaScript" branch would happily store text that no script runtime can
 * import. A script worker has no JSX transform and never will — it imports the
 * stored text as a plain ES module — so JSX is rejected here rather than left
 * to fail at mount inside a sandbox where the author would never see why.
 */
function containsJsx(ts: TypeScriptModule, source: string): boolean {
  if (!source.includes("<")) return false;
  const file = ts.createSourceFile("probe.js", source, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  const isJsx = (kind: number): boolean =>
    kind === ts.SyntaxKind.JsxElement ||
    kind === ts.SyntaxKind.JsxSelfClosingElement ||
    kind === ts.SyntaxKind.JsxFragment;
  let found = false;
  const walk = (node: import("typescript").Node): void => {
    if (found) return;
    if (isJsx(node.kind)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return found;
}

/** One line per error, prefixed with its position. */
export function formatScriptSyntaxErrors(errors: readonly ScriptSyntaxError[]): string {
  return errors.map((e) => `Line ${e.line}:${e.column} — ${e.message} (TS${e.code})`).join("\n");
}

/**
 * Compile authored script text to the JavaScript that will be stored and run.
 *
 * The decision of "is this already JavaScript?" is made by the compiler, not by
 * a regex over the text:
 *
 *   1. Parse the text AS JAVASCRIPT. TypeScript reports every TypeScript-only
 *      construct in a `.js` file as a grammar error (8010 "Type annotations can
 *      only be used in TypeScript files", 8006 for interfaces, and so on), so a
 *      clean parse means "this is valid JavaScript". In that case the ORIGINAL
 *      string is returned untouched — re-emitting would reindent and drop blank
 *      lines, which would rewrite every existing script's bytes and lapse its
 *      capability grant for no reason.
 *   2. Otherwise parse it AS TYPESCRIPT and emit. A clean parse means the author
 *      wrote TypeScript; the emitted JavaScript is the artifact.
 *   3. If neither parse is clean the text is broken. Return the TypeScript
 *      diagnostics (they are the meaningful ones — for broken JavaScript the two
 *      parses report the same syntax error) and let the caller BLOCK the save.
 *      Storing at this point would either persist un-runnable TypeScript in a
 *      field the runtime imports as JavaScript, or persist a syntax error that
 *      the next mount would only discover inside a sandboxed worker.
 *
 * Type errors do NOT reach this function's failure path: `transpileModule` is a
 * single-file syntactic transform with no type checker. Type checking is the
 * editor's job (real red squiggles from the language service, with the generated
 * .d.ts loaded); a type mistake must not make a script unsaveable.
 */
export async function transpileScriptToJavaScript(
  source: string,
  options?: { fileLabel?: string },
): Promise<ScriptTranspileResult> {
  const label = (options?.fileLabel ?? "script").replace(/[^A-Za-z0-9._-]/g, "_");
  let ts: TypeScriptModule;
  try {
    ts = await loadCompiler();
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          line: 1,
          column: 1,
          code: 0,
          message: `The TypeScript compiler could not be loaded (${String(err)}). The script was not saved.`,
        },
      ],
      message: "The TypeScript compiler could not be loaded, so the script was not saved.",
    };
  }

  const compilerOptions: import("typescript").CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    removeComments: false,
    isolatedModules: true,
    newLine: ts.NewLineKind.LineFeed,
  };

  const asJavaScript = ts.transpileModule(source, {
    compilerOptions,
    fileName: `${label}.js`,
    reportDiagnostics: true,
  });
  if ((asJavaScript.diagnostics ?? []).length === 0 && !containsJsx(ts, source)) {
    // Already JavaScript. Return the author's bytes, not the compiler's
    // re-print: identical input must produce an identical stored artifact.
    return { ok: true, javascript: source, transformed: false };
  }

  const asTypeScript = ts.transpileModule(source, {
    compilerOptions,
    fileName: `${label}.ts`,
    reportDiagnostics: true,
  });
  const tsDiagnostics = asTypeScript.diagnostics ?? [];
  if (tsDiagnostics.length > 0) {
    const errors = toSyntaxErrors(ts, tsDiagnostics);
    return {
      ok: false,
      errors,
      message: `The script does not compile: ${errors[0].message} (line ${errors[0].line})`,
    };
  }

  const javascript = asTypeScript.outputText;
  if (source.trim().length > 0 && javascript.trim().length === 0) {
    // Defensive: an emit that produced nothing from non-empty input would
    // silently erase a script. Refuse rather than store an empty artifact.
    const errors: ScriptSyntaxError[] = [
      {
        line: 1,
        column: 1,
        code: 0,
        message: "The compiler produced no JavaScript for this source.",
      },
    ];
    return { ok: false, errors, message: errors[0].message };
  }

  return { ok: true, javascript, transformed: javascript !== source };
}
