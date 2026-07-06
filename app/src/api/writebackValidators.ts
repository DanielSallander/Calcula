//! FILENAME: app/src/api/writebackValidators.ts
// PURPOSE: Custom writeback validators (distribution brick 3). A publisher can
//          name a validator on a writeback region's schema; the subscriber's
//          client runs the matching registered function as an ADVISORY,
//          as-you-type check on top of the built-in schema constraints.
// CONTEXT: The built-in ValueSchema constraints (type/min/max/pattern/enum/
//          required) are enforced AUTHORITATIVELY on the Rust submit path — a
//          client cannot bypass them. A custom validator adds EXTRA
//          publisher-defined guidance (e.g. "looks like a valid IBAN",
//          "matches our SKU format") but is frontend-only: it improves UX, it
//          is NOT a hard server-side gate. A subscriber whose client has not
//          registered the named validator simply skips it (the built-in schema
//          still applies). The validator NAME travels in the schema's
//          forward-compatible `extra` map — no manifest/format change.
// ARCHITECTURE: Pure frontend registry (like fillLists / packageKinds).

/** Context a validator receives about the region it guards. */
export interface WritebackValidatorContext {
  valueType?: "number" | "integer" | "text" | "date" | "boolean" | "enum";
  regionId: string;
}

/**
 * A validator function: given the raw entered string (already type-coerced by
 * the region's declared type) and the region context, return `null` when the
 * value is acceptable, or a short human error message to reject it (the client
 * keeps the user in edit mode and shows the message).
 */
export type WritebackValidatorFn = (
  value: string,
  ctx: WritebackValidatorContext
) => string | null;

interface Registration {
  name: string;
  label: string;
  validate: WritebackValidatorFn;
}

const registry = new Map<string, Registration>();

/**
 * Register a named writeback validator.
 * @param name  Stable id stored on a region's schema (`customValidator`).
 * @param label Human label for the publisher's designate dialog picker.
 * @returns Cleanup that unregisters the validator.
 */
export function registerWritebackValidator(
  name: string,
  label: string,
  validate: WritebackValidatorFn
): () => void {
  const id = name.trim();
  registry.set(id, { name: id, label, validate });
  return () => {
    const current = registry.get(id);
    if (current && current.validate === validate) registry.delete(id);
  };
}

/** List registered validators (for the designate dialog picker). */
export function listWritebackValidators(): Array<{ name: string; label: string }> {
  return [...registry.values()].map((r) => ({ name: r.name, label: r.label }));
}

/**
 * Run a named validator (null when the name is unknown/unregistered — an
 * unknown validator is skipped, never a hard failure). Returns the validator's
 * verdict: null = ok, string = error message.
 */
export function runWritebackValidator(
  name: string | undefined | null,
  value: string,
  ctx: WritebackValidatorContext
): string | null {
  if (!name) return null;
  const reg = registry.get(name);
  if (!reg) return null;
  try {
    return reg.validate(value, ctx);
  } catch (error) {
    console.error(`[WritebackValidators] "${name}" threw:`, error);
    return null; // a broken validator must not block the user
  }
}
