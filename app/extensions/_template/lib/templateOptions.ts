//! FILENAME: app/extensions/_template/lib/templateOptions.ts
// PURPOSE: The option state behind the template's ribbon/sidebar panel, kept
//          OUTSIDE React, plus the pure description of what a run would do.
// CONTEXT: Why a module store and not `useState` in the section component:
//          the SAME section component is mounted by the shell in up to three
//          places over its life — inline in the ribbon band, inside a launcher
//          flyout when the band is too narrow (the cluster DEMOTES), and in the
//          sidebar when the user right-clicks the tab and picks "Move to
//          Sidebar". Each of those is a fresh mount. State held in the
//          component would silently reset every time the window is resized
//          past a demotion point or the panel is moved. A tiny external store
//          read through `useSyncExternalStore` survives all of it, and every
//          mounted copy shows the same values at once.
//
//          Pure TypeScript, no React, no @api: this file is the "lib/" layer
//          of the Folder-as-Module layout (business logic you can unit-test
//          without rendering anything).

/** Where a run applies. */
export type TemplateScope = "selection" | "sheet" | "workbook";

/** Decimal places in the result. */
export type TemplatePrecision = 0 | 1 | 2;

export interface TemplateOptions {
  scope: TemplateScope;
  precision: TemplatePrecision;
  livePreview: boolean;
  skipHidden: boolean;
}

/** The factory state. Frozen so no caller can mutate the defaults in place. */
export const DEFAULT_TEMPLATE_OPTIONS: Readonly<TemplateOptions> = Object.freeze({
  scope: "selection",
  precision: 2,
  livePreview: false,
  skipHidden: true,
});

let current: Readonly<TemplateOptions> = DEFAULT_TEMPLATE_OPTIONS;
const listeners = new Set<() => void>();

function emit(): void {
  // Copy first: a listener that unsubscribes during the loop must not skip
  // the listener after it.
  for (const listener of Array.from(listeners)) listener();
}

/** The current options. The same object until something changes, which is
 *  what `useSyncExternalStore` needs from a snapshot. */
export function getTemplateOptions(): Readonly<TemplateOptions> {
  return current;
}

/** Merge a change into the options. A patch that changes nothing notifies
 *  nobody, so re-selecting the current value never re-renders the panel. */
export function setTemplateOptions(patch: Partial<TemplateOptions>): void {
  const next: TemplateOptions = { ...current, ...patch };
  const changed = (Object.keys(next) as Array<keyof TemplateOptions>).some(
    (key) => !Object.is(next[key], current[key]),
  );
  if (!changed) return;
  current = Object.freeze(next);
  emit();
}

/** Put every option back to its default. */
export function resetTemplateOptions(): void {
  if (current === DEFAULT_TEMPLATE_OPTIONS) return;
  current = DEFAULT_TEMPLATE_OPTIONS;
  emit();
}

/** Listen for option changes. Returns the unsubscribe function. */
export function subscribeTemplateOptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const SCOPE_TEXT: Record<TemplateScope, string> = {
  selection: "the selection",
  sheet: "the active sheet",
  workbook: "every sheet",
};

/**
 * One sentence saying what a run with these options does. The command the
 * "Run" hero executes shows it as a toast; replace it with your real work.
 */
export function describeTemplateRun(options: Readonly<TemplateOptions>): string {
  const places = options.precision === 1 ? "1 decimal" : `${options.precision} decimals`;
  const extras = [
    options.livePreview ? "live preview on" : "live preview off",
    options.skipHidden ? "hidden rows skipped" : "hidden rows included",
  ];
  return `Ran on ${SCOPE_TEXT[options.scope]}, rounded to ${places} (${extras.join(", ")}).`;
}
