//! FILENAME: app/extensions/ScriptableObjects/lib/scriptWorker.ts
// PURPOSE: Web Worker-based script executor for sandboxed object script execution.
// CONTEXT: Provides crash isolation — a faulty script can't freeze the main thread.
//          Falls back to main-thread execution (new Function()) if Workers are unavailable.
//
// Architecture:
//   Main thread sends: { type: "exec", scriptId, source, objectType }
//   Worker sends back:  { type: "log", scriptId, args }
//                       { type: "error", scriptId, error, stack }
//                       { type: "ready", scriptId }
//                       { type: "call", scriptId, method, args, callId }  (for context method calls)
//   Main thread responds: { type: "callResult", callId, result } or { type: "callError", callId, error }
//
// NOTE: The Worker approach has a fundamental limitation — context methods that access
// the main thread (getCellValue, event subscriptions) require async message passing.
// For now we use the Worker for compilation validation and error isolation,
// but actual execution remains on the main thread for synchronous context access.

/** Result of a worker-based script validation. */
export interface ScriptValidationResult {
  valid: boolean;
  error?: string;
  stack?: string;
}

// Worker source as a blob URL (inline worker)
const WORKER_SOURCE = `
self.onmessage = function(e) {
  const { type, scriptId, source } = e.data;

  if (type === "validate") {
    try {
      // Attempt to compile the script
      const cleanedSource = source
        .replace(/^\\s*import\\s+.*$/gm, "")
        .replace(/^\\s*export\\s+default\\s+/gm, "");

      // Check if there's a setup function
      const setupMatch = cleanedSource.match(/function\\s+setup\\s*\\(/);
      let wrappedSource;
      if (setupMatch) {
        wrappedSource = cleanedSource + "\\nreturn setup;";
      } else {
        wrappedSource = cleanedSource;
      }

      // Try to compile (will throw SyntaxError on invalid code)
      new Function("context", wrappedSource);
      self.postMessage({ type: "validated", scriptId, valid: true });
    } catch (error) {
      self.postMessage({
        type: "validated",
        scriptId,
        valid: false,
        error: error.message,
        stack: error.stack,
      });
    }
  }
};
`;

let worker: Worker | null = null;
let pendingValidations = new Map<string, {
  resolve: (result: ScriptValidationResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

function getWorker(): Worker | null {
  if (worker) return worker;

  try {
    const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);

    worker.onmessage = (e) => {
      const { type, scriptId, valid, error, stack } = e.data;
      if (type === "validated") {
        const pending = pendingValidations.get(scriptId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingValidations.delete(scriptId);
          pending.resolve({ valid, error, stack });
        }
      }
    };

    worker.onerror = () => {
      // Worker crashed — resolve all pending with error
      for (const [id, pending] of pendingValidations) {
        clearTimeout(pending.timeout);
        pending.resolve({ valid: false, error: "Worker crashed" });
      }
      pendingValidations.clear();
      worker = null;
    };

    return worker;
  } catch {
    // Workers not available
    return null;
  }
}

/**
 * Validate a script source in a Web Worker (compile check without execution).
 * Returns quickly — no execution, just syntax validation.
 * Falls back to main-thread validation if Workers are unavailable.
 */
export function validateScript(scriptId: string, source: string): Promise<ScriptValidationResult> {
  const w = getWorker();

  if (!w) {
    // Fallback: validate on main thread
    return Promise.resolve(validateOnMainThread(source));
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingValidations.delete(scriptId);
      resolve({ valid: false, error: "Validation timed out" });
    }, 5000);

    pendingValidations.set(scriptId, { resolve, timeout });
    w.postMessage({ type: "validate", scriptId, source });
  });
}

/** Main-thread fallback for script validation. */
function validateOnMainThread(source: string): ScriptValidationResult {
  try {
    const cleanedSource = source
      .replace(/^\s*import\s+.*$/gm, "")
      .replace(/^\s*export\s+default\s+/gm, "");

    const setupMatch = cleanedSource.match(/function\s+setup\s*\(/);
    let wrappedSource: string;
    if (setupMatch) {
      wrappedSource = cleanedSource + "\nreturn setup;";
    } else {
      wrappedSource = cleanedSource;
    }

    // eslint-disable-next-line no-new-func
    new Function("context", wrappedSource);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }
}

/** Terminate the validation worker (cleanup). */
export function terminateWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const [, pending] of pendingValidations) {
    clearTimeout(pending.timeout);
  }
  pendingValidations.clear();
}
