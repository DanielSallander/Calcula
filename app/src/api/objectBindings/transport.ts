//! FILENAME: app/src/api/objectBindings/transport.ts
// PURPOSE: The ONE door of the seam to the backend: the `object_bindings`
//          Tauri command (an op enum, so the whole binding surface costs one
//          entry in generate_handler!), and the refusal type its errors become.
// CONTEXT: Rust answers a refusal with a full SENTENCE (the gate's own words:
//          "Bind is refused: the sheet is protected...", "There is no measure
//          [X] in model 'M'..."). The seam hands that sentence on unchanged as a
//          `BindingRefusal`, so a caller shows it inline and never re-words it.

import { invokeBackend } from "../backend";
import type { ObjectBindingsRequest, ObjectBindingsResponse } from "../types";

/** The Tauri command every op goes through (`object_bindings::object_bindings`). */
export const OBJECT_BINDINGS_COMMAND = "object_bindings";

/** A binding operation the backend refused; `sentence` is Rust's own words. */
export class BindingRefusal extends Error {
  readonly sentence: string;
  constructor(sentence: string) {
    super(sentence);
    this.name = "BindingRefusal";
    this.sentence = sentence;
  }
}

/** The sentence inside whatever an invoke rejected with. */
function refusalSentence(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Send one op. Rejects with a `BindingRefusal` carrying the backend's sentence. */
export async function sendObjectBindingsRequest(request: ObjectBindingsRequest): Promise<ObjectBindingsResponse> {
  try {
    return await invokeBackend<ObjectBindingsResponse>(OBJECT_BINDINGS_COMMAND, { request });
  } catch (err) {
    throw err instanceof BindingRefusal ? err : new BindingRefusal(refusalSentence(err));
  }
}

/** Narrow a response to the kind an op promises, or fail loudly (a wire drift). */
export function expectResponse<K extends ObjectBindingsResponse["kind"]>(
  response: ObjectBindingsResponse | undefined | null,
  kind: K,
): Extract<ObjectBindingsResponse, { kind: K }> {
  if (!response || response.kind !== kind) {
    throw new BindingRefusal(
      `The backend answered the binding request with '${response?.kind ?? "nothing"}' where '${kind}' was expected.`,
    );
  }
  return response as Extract<ObjectBindingsResponse, { kind: K }>;
}
