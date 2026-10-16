//! FILENAME: app/extensions/BuiltIn/ObjectPane/lib/tabMemory.ts
// PURPOSE: The object pane's per-family memory: the build tab (or Format) a
//          family's object was last shown on, and which half of the Format tab
//          (Visual | General) the reader last chose.
// CONTEXT: A per-VIEWER convenience, so it lives in localStorage -- never in
//          the document, never shared. Every read and write is wrapped: a
//          private window, blocked site data or a test environment without
//          storage gives an empty memory and the pane works the same, it only
//          forgets. The in-memory copy is the source of truth for the session;
//          storage only carries it across reloads.

const STORAGE_KEY = "calcula.objectPane.memory";

/** The two halves of the Format tab. */
export type FormatSection = "visual" | "general";

interface Memory {
  /** region type -> last tab id ("fields", "data", "format", ...). */
  tabs: Record<string, string>;
  /** region type -> last Format section. */
  sections: Record<string, FormatSection>;
}

let memory: Memory | null = null;

function emptyMemory(): Memory {
  return { tabs: {}, sections: {} };
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === "string")
  );
}

function load(): Memory {
  if (memory) return memory;
  memory = emptyMemory();
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { tabs?: unknown; sections?: unknown };
      if (isRecordOfStrings(parsed.tabs)) memory.tabs = { ...parsed.tabs };
      if (isRecordOfStrings(parsed.sections)) {
        for (const [type, s] of Object.entries(parsed.sections)) {
          if (s === "visual" || s === "general") memory.sections[type] = s;
        }
      }
    }
  } catch {
    // Unreadable storage: start empty.
  }
  return memory;
}

function save(): void {
  if (!memory) return;
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage refused (private window, quota): the session copy still works.
  }
}

/** The tab the reader last chose for objects of `regionType`, or null. */
export function rememberedTab(regionType: string): string | null {
  return load().tabs[regionType] ?? null;
}

/** Remember the tab the reader chose for objects of `regionType`. */
export function rememberTab(regionType: string, tabId: string): void {
  const m = load();
  if (m.tabs[regionType] === tabId) return;
  m.tabs[regionType] = tabId;
  save();
}

/** The Format section the reader last chose for objects of `regionType`, or null. */
export function rememberedFormatSection(regionType: string): FormatSection | null {
  return load().sections[regionType] ?? null;
}

/** Remember the Format section the reader chose for objects of `regionType`. */
export function rememberFormatSection(regionType: string, section: FormatSection): void {
  const m = load();
  if (m.sections[regionType] === section) return;
  m.sections[regionType] = section;
  save();
}

/** Test hook: forget the session copy (and, with `storage`, the stored one). */
export function resetTabMemory(storage = false): void {
  memory = null;
  if (!storage) return;
  try {
    window.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
