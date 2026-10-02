//! FILENAME: app/src/api/keybindings.ts
// PURPOSE: Centralized, user-configurable keybinding registry AND the single
//          dispatcher for named-command keyboard shortcuts.
// CONTEXT: `handleGlobalKeyDown` (installed by initKeybindings at bootstrap) is
//          the ONE place that turns a keydown into a CommandRegistry.execute for
//          app shortcuts. Ownership boundary:
//            - Registry (here): every named-command shortcut — built-in, menu,
//              and extension. Menu items carry a `shortcut` string for DISPLAY
//              only; MenuBar no longer dispatches (see MenuBar.tsx).
//            - Grid (core/hooks/useGridKeyboard.ts): view-state keys that are
//              meaningless without grid focus — navigation, selection, edit-mode
//              (F2/Esc/F8), plus grid-only command keys it handles locally
//              (format toggles, number formats, Ctrl+;, Ctrl+`, F5/F9/F11).
//            - Sandboxed SCRIPTS (the `ui.shortcut` capability): a script binds
//              one Ctrl+Shift+<letter> to a method it exposed. Same registry,
//              same conflict rules, same visible list — see "Script-owned
//              shortcuts" below for the five rules that keep a key hook from
//              being VBA's Application.OnKey.
//          Two more things the dispatcher answers before any command runs: a
//          settings box RECORDING a combination gets the key instead
//          (beginShortcutCapture), and a feature may REFUSE a command id
//          whatever combination it is on (registerCommandRefusal).
//          Matching is EXACT first; only when nothing matched exactly does a
//          SYMBOL combination (Alt+;, Ctrl+]) match the character a keyboard
//          layout needed Shift or AltGr to type (matchesEventOnLayout -- sv-SE
//          types Alt+; as Alt+Shift+comma, Ctrl+] as Ctrl+AltGr+9) -- except
//          that in READY mode an AltGr character is typed into the cell, never
//          read as a shortcut (typesAltGrCharacterIntoACell, W17).
//          Two keys are spelled by NAME in a combo, "Space" and "Plus": the
//          grammar splits on "+" and trims, so neither can stand as itself
//          (see "Keys the grammar spells by name", M8 S9).
//          Grid-scoped commands (GRID_SCOPED_COMMANDS) fire only with grid focus
//          and defer to native otherwise; copy/cut additionally defer when a DOM
//          text selection exists. Supports user customization, conflict
//          detection, and a settings UI.
//          POINTER CLAIMS: this listener is capture-phase on `window`, so it
//          pre-empts all three of Core's claim-honouring doors and has to answer
//          the claim itself. It does so in three classes — see the long comment
//          in `handleGlobalKeyDown`, `core/lib/pointerClaims.ts` for the rule,
//          and `core/lib/globalInputListeners.ts` for the census of every global
//          key/pointer listener in the app (a new one adds a row there).
// NOTE: The grid switch still contains (now-dead) clipboard/undo/fill cases that
//       the registry pre-empts via capture-phase stopPropagation; removing them
//       is a tracked, behavior-neutral follow-up (needs clipboard test coverage).

import { CommandRegistry } from "./commands";
import { addCommandRefusal, commandRefusalFor, type CommandRefusal } from "./commandRefusals";
import { showToast } from "./notifications";
import { findPointerClaim } from "./pointerClaims";
// Straight from the Core module (the same binding @api/externalEdit re-exports):
// formulaEditTarget has no imports, whereas the externalEdit door also carries
// the point-mode switch and its backend calls, which this dispatcher never needs.
import { isExternalEditLive } from "../core/lib/formulaEditTarget";
// Core's OWN edit flag, for the same reason: cellEditFlag has no imports, where
// core/hooks/useEditing (which reads and writes it) is a hook module with the
// grid state and the backend calls behind it.
import { isCoreCellEditOpen } from "../core/lib/cellEditFlag";
// Both dependency-free Core modules as well: the grid's one "does this key TYPE
// its character" rule (AltGr included, E13) and the selection-owner store.
import { isTypedCharacterKey } from "../core/lib/editOpenBuffer";
import { isSelectionOwned, selectionOwnerReceivesTyping } from "../core/lib/selectionOwner";
// Core's grid state, for ONE question: is a cell selected (a canvas has none)?
// The module's other imports are the reducer and its types, none of which reach
// back here.
import { getGridStateSnapshot } from "../core/state/GridContext";
// Core's cell press session, for ONE question: is a claimed press held (its
// Escape is the press's)? It imports only core/lib/cellClickInterceptors.
import { isCellPressHeld } from "../core/lib/cellPressRelease";

// ============================================================================
// Types
// ============================================================================

export interface KeyBinding {
  /** Unique ID: "core.copy", "ext.autofilter.toggle", etc. */
  id: string;
  /** Key combination: "Ctrl+C", "Ctrl+Shift+L", "F2" */
  combo: string;
  /** Command to execute. Empty for a SCRIPT binding, which runs a method the
   *  script exposed rather than a registered command (see the script-shortcut
   *  section below) — the runner is held in a private map, never on this
   *  object, so a callable can never leak through `getAll()`. */
  commandId: string;
  /** Display name: "Copy", "Toggle AutoFilter" */
  label: string;
  /** Category: "Clipboard", "Editing", "Formatting", "Navigation", etc. */
  category: string;
  /** When active */
  context?: "always" | "editing" | "not-editing";
  /** Who defined it */
  source: "built-in" | "extension" | "user" | "script";
  /** Extension that registered it */
  extensionId?: string;
  /** Sandboxed script that registered it (source === "script" only). */
  scriptId?: string;
  /**
   * When THIS binding wins a keystroke, no other keydown listener hears it:
   * the dispatcher calls `stopImmediatePropagation`, not only
   * `stopPropagation`. For a REFUSAL ("not while my subject owns the
   * selection"). An extension may still act on a key from a window-CAPTURE
   * listener of its own -- Alt+Down (Data Validation) does -- on the same
   * target and in the same phase as this dispatcher, where `stopPropagation`
   * does not reach it. A binding that exists to say "not now" was otherwise
   * followed by the very action it refused. Ignored for script bindings.
   * (The built-in shortcuts' own listeners -- Ctrl+K, Ctrl+E, Alt+Shift+Arrow,
   * Ctrl+Shift+L, Ctrl+Alt+M, Shift+F2, Alt+;, the bookmark keys, the panel
   * toggles and Ctrl+P -- are gone since wave B: the registry is their ONE
   * path. Refusing a COMMAND, whatever its keys, is registerCommandRefusal's
   * job: it follows a remap, which a binding on the default combination
   * cannot.)
   */
  exclusive?: boolean;
  /**
   * `false` keeps the binding out of the user-facing shortcut list (Settings >
   * Keyboard shortcuts) and out of that page's conflict warnings; absent means
   * listed. For a binding that is not a shortcut anyone looks up or remaps: a
   * REFUSAL that exists only to say "not now" over somebody else's key.
   * FloatingRange refuses about forty grid keys while its range owns the
   * selection, and listing them put forty "X (Floating Range)" rows on the
   * page, each with an Edit button that would move the refusal OFF the very
   * key it refuses. Dispatch is untouched: an unlisted binding matches, wins
   * and runs exactly as a listed one does -- only the list is told to skip it
   * ({@link isListedKeybinding}).
   */
  listed?: boolean;
}

export interface ParsedCombo {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * Contract for the keybindings API on ExtensionContext.
 *
 * `register` MUST mirror {@link registerKeybinding}, argument for argument. It
 * did not: `registerKeybinding` grew a `when` predicate (Ctrl+1 and Delete,
 * which Charts owns only while a chart element is selected) and this facade
 * kept the one-argument shape. Charts works because it imports the free
 * function directly — an extension that obeys the Facade Rule and takes
 * `context.keybindings` could not express "only while my subject is selected"
 * at all, and would silently lose the argument if it passed one, because a
 * one-parameter arrow is assignable to a two-parameter signature in TypeScript.
 * That is the whole trap: nothing goes red, the predicate is simply dropped and
 * the binding fires everywhere.
 *
 * `when` is documented on {@link registerKeybinding}; the three rules
 * (skipped-before-match, specific-beats-unguarded, a throw means "does not
 * apply") are the function's, not the facade's, so there is one explanation.
 */
export interface IKeybindingsAPI {
  register(binding: Omit<KeyBinding, "source">, when?: () => boolean): () => void;
  getAll(): KeyBinding[];
  getEffectiveCombo(id: string): string;
}

// ============================================================================
// State
// ============================================================================

const STORAGE_KEY = "calcula.keybindings.overrides";
const CUSTOM_BINDINGS_KEY = "calcula.keybindings.custom";

/** All registered keybindings (built-in + extension) */
const registry: Map<string, KeyBinding> = new Map();

/** User overrides: id -> custom combo */
let userOverrides: Map<string, string> = new Map();

/** Change listeners */
type ChangeListener = () => void;
const changeListeners: Set<ChangeListener> = new Set();

/** Whether the centralized keydown listener has been installed */
let listenerInstalled = false;

// ============================================================================
// Default Built-In Keybindings
// ============================================================================

/**
 * The formula bar's expand/collapse command, named once. The binding below and
 * the FormulaBar that registers the handler are its only two mentions, and a
 * typo in either is a shortcut that silently does nothing — `execute` takes a
 * string and no gate compares the two spellings.
 */
export const FORMULA_BAR_TOGGLE_EXPANDED_COMMAND = "core.view.toggleFormulaBarExpanded";

const DEFAULT_KEYBINDINGS: KeyBinding[] = [
  // Clipboard
  { id: "core.cut", combo: "Ctrl+X", commandId: "core.clipboard.cut", label: "Cut", category: "Clipboard", source: "built-in" },
  { id: "core.copy", combo: "Ctrl+C", commandId: "core.clipboard.copy", label: "Copy", category: "Clipboard", source: "built-in" },
  { id: "core.paste", combo: "Ctrl+V", commandId: "core.clipboard.paste", label: "Paste", category: "Clipboard", source: "built-in" },
  { id: "core.pasteSpecial", combo: "Ctrl+Shift+V", commandId: "core.clipboard.pasteSpecial", label: "Paste Special", category: "Clipboard", source: "built-in" },

  // Edit
  // Undo/redo are app-global (fire even when focus is on a non-grid shell
  // element) but NOT while editing a text input (so native input undo works).
  // Hence context:"not-editing" rather than grid-scoped.
  { id: "core.undo", combo: "Ctrl+Z", commandId: "core.edit.undo", label: "Undo", category: "Editing", context: "not-editing", source: "built-in" },
  { id: "core.redo", combo: "Ctrl+Y", commandId: "core.edit.redo", label: "Redo", category: "Editing", context: "not-editing", source: "built-in" },
  { id: "core.find", combo: "Ctrl+F", commandId: "core.edit.find", label: "Find", category: "Editing", source: "built-in" },
  { id: "core.replace", combo: "Ctrl+H", commandId: "core.edit.replace", label: "Replace", category: "Editing", source: "built-in" },
  { id: "core.clearContents", combo: "Delete", commandId: "core.edit.clearContents", label: "Clear Contents", category: "Editing", context: "not-editing", source: "built-in" },

  // Fill
  { id: "core.fillDown", combo: "Ctrl+D", commandId: "core.edit.fillDown", label: "Fill Down", category: "Editing", source: "built-in" },
  { id: "core.fillRight", combo: "Ctrl+R", commandId: "core.edit.fillRight", label: "Fill Right", category: "Editing", source: "built-in" },

  // Format
  { id: "core.formatCells", combo: "Ctrl+1", commandId: "core.format.cells", label: "Format Cells", category: "Formatting", source: "built-in" },
  // NOT grid-scoped, "not-editing" (BUG-0199): Format Painter works from a
  // focused ribbon button too, and it is started ONLY here -- the extension's
  // own Ctrl+Shift+C listener, which made one keystroke start it twice with the
  // grid focused and ignored a remap, is gone (its Escape stays).
  { id: "core.formatPainter", combo: "Ctrl+Shift+C", commandId: "core.format.painter", label: "Format Painter", category: "Formatting", context: "not-editing", source: "built-in" },

  // File (global — must fire even when focus is outside the grid). Commands are
  // registered by the StandardMenus extension.
  { id: "core.file.new", combo: "Ctrl+N", commandId: "core.file.new", label: "New", category: "File", source: "built-in" },
  { id: "core.file.open", combo: "Ctrl+O", commandId: "core.file.open", label: "Open", category: "File", source: "built-in" },
  { id: "core.file.save", combo: "Ctrl+S", commandId: "core.file.save", label: "Save", category: "File", source: "built-in" },
  { id: "core.file.saveAs", combo: "Ctrl+Shift+S", commandId: "core.file.saveAs", label: "Save As", category: "File", source: "built-in" },

  // Insert / navigation (menu-bar shortcuts formerly dispatched only by MenuBar)
  //
  // "not-editing" on every binding below whose command acts on Core's
  // SELECTION -- builds something from it (a table, a filter, a group, a
  // comment, a hyperlink, a bookmark, a flash fill) or moves it (bookmark
  // navigation, Select Visible Cells). Excel ignores these in edit mode, and
  // they were context "always": Ctrl+T in the in-cell editor, in the formula
  // bar, or in a floating grid's cell edit (whose keyboard can sit on the grid
  // container while it picks a reference) ran Insert Table over Core's
  // selection -- a cell the user was not editing and, during a floating-grid
  // edit, could not see. "not-editing" is the dispatcher's own editing context
  // (isEditingKeystroke): a text field, a pointer claim, or a live cell edit --
  // Core's own (parked on another sheet included) or an external session. An
  // extension that ALSO listens for its key itself asks the same question
  // through @api/editing isEditKeystroke. (The fills, merge and Format Cells
  // are GRID-SCOPED instead, and a live cell edit refuses every grid-scoped
  // binding -- see handleGlobalKeyDown. Format Painter's Ctrl+Shift+C is
  // "not-editing" since BUG-0199, so it also works from a ribbon button.)
  { id: "core.insertTable", combo: "Ctrl+T", commandId: "insert.table", label: "Insert Table", category: "Insert", context: "not-editing", source: "built-in" },
  { id: "core.goToSpecial", combo: "Ctrl+G", commandId: "view.goToSpecial", label: "Go To Special", category: "Navigation", source: "built-in" },

  // Merge (grid-scoped; bridges to gridCommands.mergeCells via CommandRegistry)
  { id: "core.merge", combo: "Ctrl+M", commandId: "core.grid.merge", label: "Merge Cells", category: "Editing", source: "built-in" },

  // Navigation / View
  { id: "ext.search.findReplace", combo: "Ctrl+Shift+H", commandId: "search.openFindReplace", label: "Find and Replace", category: "Navigation", source: "built-in" },
  { id: "ext.fileExplorer.toggle", combo: "Ctrl+Shift+E", commandId: "fileExplorer.toggle", label: "Toggle File Explorer", category: "Navigation", source: "built-in" },
  { id: "ext.extensionsManager.toggle", combo: "Ctrl+Shift+X", commandId: "extensionsManager.toggle", label: "Toggle Extensions Manager", category: "Navigation", source: "built-in" },
  { id: "ext.settings.toggle", combo: "Ctrl+,", commandId: "settings.toggle", label: "Open Settings", category: "Navigation", source: "built-in" },
  // Deliberately no `context`, i.e. "always". Excel expands the bar in the
  // middle of an entry — that is when a long formula most needs the room — and
  // the dispatcher's listener is capture-phase on window, so the combination
  // reaches the command even while the caret sits inside the bar's own editor.
  // The handler is registered by the FormulaBar itself and goes away with it,
  // so with the bar hidden the shortcut correctly does nothing.
  { id: "core.view.toggleFormulaBarExpanded", combo: "Ctrl+Shift+U", commandId: FORMULA_BAR_TOGGLE_EXPANDED_COMMAND, label: "Expand/Collapse Formula Bar", category: "Navigation", source: "built-in" },

  // Data
  { id: "ext.autofilter.toggle", combo: "Ctrl+Shift+L", commandId: "autofilter.toggle", label: "Toggle AutoFilter", category: "Data", context: "not-editing", source: "built-in" },
  // `flashfill.execute` is the id FlashFill registers (script-safe, so scripts
  // call it by that spelling); this binding named `flashFill.execute`, which
  // nothing registered (BUG-0183).
  { id: "ext.flashFill", combo: "Ctrl+E", commandId: "flashfill.execute", label: "Flash Fill", category: "Data", context: "not-editing", source: "built-in" },

  // Names. Excel's Ctrl+F3. BARE F3 IS NOT TAKEN BY THIS: the app's only other
  // F3 handler is Find Next inside the Find and Replace dialog, which tests
  // `e.key === "F3"` without looking at ctrlKey — but the dispatcher below stops
  // a matched event in the CAPTURE phase, so a Ctrl+F3 never reaches React's
  // root container and the two cannot both fire.
  { id: "ext.definedNames.nameManager", combo: "Ctrl+F3", commandId: "definedNames.nameManager", label: "Name Manager", category: "Formulas", source: "built-in" },

  // Print
  { id: "ext.print", combo: "Ctrl+P", commandId: "print.preview", label: "Print", category: "File", source: "built-in" },

  // Hyperlinks
  { id: "ext.hyperlinks.insert", combo: "Ctrl+K", commandId: "hyperlinks.insert", label: "Insert Hyperlink", category: "Editing", context: "not-editing", source: "built-in" },

  // Bookmarks. EVERY built-in in this list names a command its extension
  // REGISTERS (BUG-0183 and wave B's D2: several named ids nothing registered
  // and "worked" only because the extension's own listener ran beside this
  // dispatcher -- or, for the bubble-phase ones, did nothing at all, because
  // this capture-phase dispatcher stops a matched key before it bubbles).
  // Those listeners are gone: this registry is the ONE keyboard path, so a key
  // runs exactly once and a remap MOVES it (builtinShortcutCensus checks the
  // registrations from source).
  { id: "ext.bookmarks.toggle", combo: "Ctrl+Shift+B", commandId: "bookmarks.toggle", label: "Toggle Bookmark", category: "Navigation", context: "not-editing", source: "built-in" },
  { id: "ext.bookmarks.next", combo: "Ctrl+]", commandId: "bookmarks.next", label: "Next Bookmark", category: "Navigation", context: "not-editing", source: "built-in" },
  { id: "ext.bookmarks.prev", combo: "Ctrl+[", commandId: "bookmarks.prev", label: "Previous Bookmark", category: "Navigation", context: "not-editing", source: "built-in" },

  // Grouping
  { id: "ext.grouping.group", combo: "Alt+Shift+ArrowRight", commandId: "grouping.group", label: "Group Rows/Columns", category: "Data", context: "not-editing", source: "built-in" },
  { id: "ext.grouping.ungroup", combo: "Alt+Shift+ArrowLeft", commandId: "grouping.ungroup", label: "Ungroup Rows/Columns", category: "Data", context: "not-editing", source: "built-in" },

  // Review
  { id: "ext.review.newComment", combo: "Ctrl+Alt+M", commandId: "review.newComment", label: "New Comment", category: "Review", context: "not-editing", source: "built-in" },
  { id: "ext.review.newNote", combo: "Shift+F2", commandId: "review.newNote", label: "New Note", category: "Review", context: "not-editing", source: "built-in" },

  // Select Visible Cells
  { id: "ext.selectVisible", combo: "Alt+;", commandId: "selectVisibleCells.execute", label: "Select Visible Cells", category: "Editing", context: "not-editing", source: "built-in" },

  // Script Notebook
  { id: "ext.scriptNotebook.toggle", combo: "Ctrl+Shift+N", commandId: "scriptNotebook.toggle", label: "Toggle Script Notebook", category: "Navigation", source: "built-in" },
];

// ============================================================================
// Persistence
// ============================================================================

function loadUserOverrides(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string>;
      userOverrides = new Map(
        Object.entries(parsed).filter(([id, combo]) => !dropStoredBareKey(`the remap of '${id}'`, combo)),
      );
    }
  } catch {
    userOverrides = new Map();
  }
}

function saveUserOverrides(): void {
  const obj: Record<string, string> = {};
  userOverrides.forEach((combo, id) => {
    obj[id] = combo;
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

// ============================================================================
// Key Combo Parsing & Matching
// ============================================================================

/** Cache of parsed combos to avoid repeated string splitting on every keypress. */
const comboCache = new Map<string, ParsedCombo>();

/**
 * Get a parsed combo from cache, or parse and cache it.
 */
function getCachedParsedCombo(combo: string): ParsedCombo {
  let parsed = comboCache.get(combo);
  if (!parsed) {
    parsed = parseCombo(combo);
    comboCache.set(combo, parsed);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Keys the grammar spells by name ("Space", "Plus") -- M8 S9
// ---------------------------------------------------------------------------
//
// A combo is split on "+" and every part is TRIMMED, so two keys cannot stand
// in one as their own character: the space bar (`event.key` " ") and the plus
// key ("+"). eventToCombo used to record them as characters anyway -- "Ctrl+ ",
// which parses to an EMPTY key, and "Ctrl++", which splits to
// ["Ctrl", "", ""], an empty key again -- so Settings saved a shortcut a user
// recorded on Ctrl+Space or Ctrl+Plus, showed it, and it never fired. Each now
// has a NAME: the combo text and the parsed combo carry "Space" / "Plus"
// (eventToCombo writes it, parseCombo canonicalises any casing of it), and the
// matchers compare the keystroke's `event.key` with the name's CHARACTER.
// "+" is a layout symbol (US types it with Shift), so the symbol tier reads
// the character too; a space is not (whitespace), and the physical-key tier
// takes only letters and digits, so Space is matched exactly or not at all.
// Stored "Ctrl+ " combinations are not migrated (no backward compatibility --
// CLAUDE.md); a literal "Ctrl++" is still read as the plus key (parseCombo).

/** A named key -> the `KeyboardEvent.key` it stands for. */
const NAMED_KEY_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["Space", " "],
  ["Plus", "+"],
]);

/** "space" / "SPACE" -> "Space" (and Plus alike); any other key unchanged. */
function canonicalKeyName(key: string): string {
  const lower = key.toLowerCase();
  for (const name of NAMED_KEY_CHARACTERS.keys()) {
    if (lower === name.toLowerCase()) return name;
  }
  return key;
}

/** The `KeyboardEvent.key` a parsed combo key is pressed as: " " for Space,
 *  "+" for Plus, any other key itself. */
function comboKeyToEventKey(key: string): string {
  return NAMED_KEY_CHARACTERS.get(key) ?? key;
}

/** A keystroke's key as a combo spells it: "Space" for " ", "Plus" for "+". */
function eventKeyToComboKey(key: string): string {
  for (const [name, character] of NAMED_KEY_CHARACTERS) {
    if (key === character) return name;
  }
  return key;
}

/**
 * Parse a combo string like "Ctrl+Shift+B" into structured form.
 * The last token is always the key, everything before is modifiers. The key
 * is canonical for the two named keys ("ctrl+space" -> key "Space"), and a
 * LITERAL plus key ("Ctrl++", "+") is read as "Plus": it leaves two empty
 * parts at the end, the two sides of the "+" that is the key. ONE empty part
 * ("Ctrl+", or a trimmed "Ctrl+ ") names no key and never matches.
 */
export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.split("+").map((p) => p.trim());
  const result: ParsedCombo = { key: "", ctrl: false, shift: false, alt: false, meta: false };

  const literalPlus =
    parts.length >= 2 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "";
  if (literalPlus) parts.pop();

  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i].toLowerCase();
    if (mod === "ctrl" || mod === "control") result.ctrl = true;
    else if (mod === "shift") result.shift = true;
    else if (mod === "alt") result.alt = true;
    else if (mod === "meta" || mod === "cmd") result.meta = true;
  }

  result.key = literalPlus ? "Plus" : canonicalKeyName(parts[parts.length - 1]);
  return result;
}

/**
 * Check if a KeyboardEvent matches a combo string.
 * Uses cached parsed combos to avoid repeated string splitting. A named key
 * ("Space", "Plus") matches the character it stands for.
 */
export function matchesEvent(combo: string, event: KeyboardEvent): boolean {
  const parsed = getCachedParsedCombo(combo);
  if (parsed.ctrl !== event.ctrlKey) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;
  if (parsed.meta !== event.metaKey) return false;
  return event.key.toLowerCase() === comboKeyToEventKey(parsed.key).toLowerCase();
}

/**
 * A SYMBOL key: one character that is neither a letter nor a digit (";", "]",
 * "[", ","). Which modifiers TYPE it is the keyboard layout's business, not
 * the user's: on sv-SE ";" is Shift+comma, and "]" / "[" are AltGr+9 / AltGr+8.
 */
function isLayoutSymbol(key: string): boolean {
  return /^[^\p{L}\p{N}\s]$/u.test(key);
}

/**
 * The LAYOUT-TOLERANT match, for a combo whose key is a symbol: it matches the
 * CHARACTER the keystroke produced, whatever modifiers the layout needed to
 * produce it. The dispatcher asks it only when no binding matched EXACTLY
 * (matchesEvent), so it can widen what a symbol combination hears but never
 * take a keystroke from the binding that names it exactly.
 *
 * Why (review of BUG-0183): on sv-SE, Excel's Alt+; is typed Alt+Shift+comma
 * (key ";" with Alt AND Shift) and Ctrl+] is typed Ctrl+AltGr+9 (key "]" with
 * Ctrl AND Alt -- Windows reports AltGr as Ctrl+Alt). The exact match refused
 * both, and once the extensions' own listeners (which took the character
 * whatever the extra modifier) stood aside for the registry -- they are
 * deleted now -- Select Visible Cells and next/previous bookmark were dead
 * keys on the owner's own layout.
 *
 *  - SHIFT is ignored unless the combo names it. The layout put it there to
 *    make the symbol; Shift+";" on a US layout is ":", a different key, which
 *    never reaches this function's `event.key === parsed.key`. A combo that
 *    NAMES Shift still requires it.
 *  - Ctrl+Alt is read as ALTGR when `altGr` is true: the symbol needed it, so a
 *    combo matches whether it names Ctrl (a Ctrl pressed WITH AltGr is
 *    indistinguishable from AltGr's own, as it always was for these keys),
 *    names Ctrl+Alt, or names neither. An Alt-only combo does not: Alt without
 *    Ctrl is never AltGr, so Alt+; is not answered by an AltGr-typed ";".
 *    The dispatcher passes `altGr: false` while the keystroke is TYPING (a
 *    text field, a live cell edit, or an AltGr character typed into a cell in
 *    READY mode -- typesAltGrCharacterIntoACell, W17): there a Ctrl+Alt
 *    character is text --
 *    "]" in a structured reference, "$" (AltGr+4) in an absolute one -- and
 *    only an exact Ctrl+Alt combination may take it.
 *  - Meta is compared exactly; letters, digits and named keys (F2, ArrowRight,
 *    Delete) never match here -- their Shift MEANS something (Ctrl+Shift+E is
 *    not Ctrl+E).
 */
export function matchesEventOnLayout(
  combo: string,
  event: KeyboardEvent,
  options: { altGr: boolean },
): boolean {
  const parsed = getCachedParsedCombo(combo);
  // "Plus" is the "+" symbol (US types it with Shift); "Space" is no symbol.
  const key = comboKeyToEventKey(parsed.key);
  if (!isLayoutSymbol(key) || event.key !== key) return false;
  if (parsed.meta !== event.metaKey) return false;
  if (parsed.shift && !event.shiftKey) return false;
  if (options.altGr && event.ctrlKey && event.altKey) {
    return parsed.ctrl || !parsed.alt;
  }
  return parsed.ctrl === event.ctrlKey && parsed.alt === event.altKey;
}

/** A combo key that is one ASCII letter or digit ("M", "1"). */
function isLetterOrDigitKey(key: string): boolean {
  return /^[A-Za-z0-9]$/.test(key);
}

/**
 * The letter or digit a keystroke's KEY carries ("M", "1"), or null when the
 * key is neither. Digits by `code` (Digit0..Digit9: the digit row is the digit
 * row on every layout). Letters by `keyCode` first -- Windows' virtual-key
 * code, the LAYOUT's letter on that key (QWERTZ's Z sits where US has Y,
 * AZERTY's M where US has ";") -- and by `code` only for a keystroke that
 * carries none (a synthetic event).
 */
function physicalLetterOrDigit(event: KeyboardEvent): string | null {
  const digit = /^Digit([0-9])$/.exec(event.code ?? "");
  if (digit) return digit[1];
  const vk = event.keyCode;
  if (vk >= 65 && vk <= 90) return String.fromCharCode(vk);
  const letter = /^Key([A-Z])$/.exec(event.code ?? "");
  return letter ? letter[1] : null;
}

/**
 * The PHYSICAL-KEY match, for a combo whose key is a letter or a digit: it
 * matches the KEY that carries that letter or digit when the layout made the
 * keystroke type something else. The dispatcher asks it only when neither the
 * exact match (matchesEvent) nor the symbol tier (matchesEventOnLayout)
 * matched, so it never takes a keystroke from a binding that names the typed
 * character.
 *
 * Why (review of D1/D4): Windows turns Ctrl+Alt into AltGr when it generates
 * the character, so on sv-SE and de-DE -- where AltGr+M types the micro sign
 * -- Ctrl+Alt+M arrives as key "µ" with Ctrl+Alt, and New Comment was a dead
 * key there. The same exact-character match left AZERTY's digit shortcuts
 * dead (Ctrl+1 types Ctrl+&) and every Ctrl+letter on a non-Latin layout
 * (Ctrl+Z types Ctrl+я). Excel binds the KEY (its virtual-key code), not the
 * character.
 *
 *  - Only when the typed key is NOT itself an ASCII letter or digit: when the
 *    layout typed a Latin letter, the layout has already said which key it is
 *    (AZERTY's Ctrl+Q is on the US "A" position and is Ctrl+Q, never Ctrl+A).
 *  - Modifiers match EXACTLY, Shift included: on a letter or a digit, Shift
 *    MEANS something (Ctrl+Shift+E is not Ctrl+E).
 *  - The combo must name Ctrl, Alt or Meta: a bare or Shift-only letter is
 *    typing, never a shortcut to be found by position.
 *  - `typing` (a text field, a live cell edit, an AltGr character typed into
 *    a cell in ready mode -- W17): a Ctrl+Alt keystroke there is
 *    an AltGr CHARACTER -- "@", "€", "µ" -- and is never taken; only the exact
 *    tier may.
 *  - Never during an IME composition.
 */
export function matchesEventOnPhysicalKey(
  combo: string,
  event: KeyboardEvent,
  options: { typing: boolean },
): boolean {
  const parsed = getCachedParsedCombo(combo);
  if (!isLetterOrDigitKey(parsed.key)) return false;
  if (!(parsed.ctrl || parsed.alt || parsed.meta)) return false;
  if (event.isComposing || event.key === "Process") return false;
  if (isLetterOrDigitKey(event.key)) return false;
  if (parsed.ctrl !== event.ctrlKey || parsed.alt !== event.altKey) return false;
  if (parsed.shift !== event.shiftKey || parsed.meta !== event.metaKey) return false;
  if (options.typing && event.ctrlKey && event.altKey) return false;
  const key = physicalLetterOrDigit(event);
  return key !== null && key === parsed.key.toUpperCase();
}

/**
 * Format a combo string for display.
 * Normalizes casing: "ctrl+shift+b" -> "Ctrl+Shift+B"
 */
export function formatCombo(combo: string): string {
  const parsed = getCachedParsedCombo(combo);
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  if (parsed.meta) parts.push("Meta");

  // Capitalize single-char keys, leave multi-char keys (F1, ArrowRight, etc.) as-is
  let key = parsed.key;
  if (key.length === 1) {
    key = key.toUpperCase();
  } else {
    // Capitalize first letter
    key = key.charAt(0).toUpperCase() + key.slice(1);
  }
  parts.push(key);
  return parts.join("+");
}

/**
 * Convert a KeyboardEvent into a combo string.
 *
 * A LETTER typed with Ctrl, Alt or Meta in place of the key's own letter or
 * digit is recorded as that KEY (see matchesEventOnPhysicalKey): the Settings
 * capture box recorded sv-SE's Ctrl+Alt+M by its character, upper-cased --
 * "Ctrl+Alt+Μ", a GREEK capital mu (the micro sign µ upper-cased), which no
 * keystroke can ever match -- and a Russian Ctrl+Z as "Ctrl+Я". A SYMBOL keeps
 * its character ("Ctrl+Alt+]", "Ctrl+Alt+@"): the symbol tier matches it by
 * what the layout types, whatever key it sits on. The space bar and the plus
 * key are written by NAME ("Ctrl+Space", "Ctrl+Plus"): as characters the
 * grammar trims or splits them away and the recorded shortcut never fired
 * (see "Keys the grammar spells by name").
 */
export function eventToCombo(event: KeyboardEvent): string | null {
  // Skip pure modifier keys
  const modifierKeys = ["Control", "Shift", "Alt", "Meta"];
  if (modifierKeys.includes(event.key)) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");

  let key = event.key;
  const shortcut = event.ctrlKey || event.altKey || event.metaKey;
  if (shortcut && /^\p{L}$/u.test(key) && !isLetterOrDigitKey(key)) {
    key = physicalLetterOrDigit(event) ?? key;
  }
  if (key.length === 1) {
    key = key.toUpperCase();
  }
  parts.push(eventKeyToComboKey(key));
  return parts.join("+");
}

// ============================================================================
// Editing State Detection
// ============================================================================

/**
 * The TAG half of the question "does the focused thing own its own keys?".
 *
 * Incomplete on its own and knowingly so — it is a census of the text controls
 * that exist in the shell today. `<select>` and `<button>` are not in it, which
 * is precisely how Delete inside an on-grid form's dropdown reached
 * `core.edit.clearContents` and wiped the user's selected cells. The missing
 * half is `isClaimedKeystroke`; `ownsItsOwnKeys` is the question this dispatcher
 * actually asks. Do NOT lengthen this list to chase a widget type — see
 * core/lib/pointerClaims.ts, "the answer is the ancestor walk, not a longer tag
 * list".
 */
function isEditing(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  if ((active as HTMLElement).contentEditable === "true") return true;
  return false;
}

/**
 * The CLAIM half: is this keystroke aimed at something stacked ON the grid that
 * has said "gestures that land on me are mine" (`data-pointer-claim`)?
 *
 * Both sources are consulted because neither is reliable alone here. `target` is
 * the authoritative one for a real keydown — the browser delivers a key event to
 * the focused element — but a synthesised event (a test, a re-dispatch) can
 * carry a null target, and `document.activeElement` is the same basis
 * `isEditing` already uses. A false "claimed" costs a shortcut; a false
 * "unclaimed" costs the user's cells, so the OR is the safe direction.
 */
function isClaimedKeystroke(event: KeyboardEvent): boolean {
  if (findPointerClaim(event.target) !== null) return true;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  return findPointerClaim(active) !== null;
}

/**
 * Does something other than the grid own this keystroke's editing semantics?
 *
 * This is THE question, and the tag list was only ever half of it. A claim means
 * a widget the user can see and has focused is sitting inside the grid's own DOM
 * subtree; whether that widget happens to be an `<input>`, a `<select>`, a
 * `<button>` or a custom element with a shadow root is not a question this
 * dispatcher should have to keep re-answering.
 */
function ownsItsOwnKeys(event: KeyboardEvent): boolean {
  return isEditing() || isClaimedKeystroke(event);
}

/**
 * The dispatcher's EDITING context for a keystroke: what a `context:
 * "not-editing"` binding stands down for (and an `"editing"` one needs). True
 * when a text field or a pointer claim owns the key (`ownsItsOwnKeys`), or a
 * CELL EDIT is live wherever its keyboard is:
 *   - an external edit session -- a floating grid's cell edit, whichever view
 *     hosts its caret, parked or not (see the long comment in
 *     handleGlobalKeyDown);
 *   - Core's own edit (`isCoreCellEditOpen`). A focused <textarea> is NOT
 *     enough to see it: parked on another sheet while it picks a reference,
 *     the in-cell editor is not rendered there and the keyboard sits on the
 *     grid container, which no tag test answers. Without the flag, Ctrl+T,
 *     Ctrl+Shift+L, Alt+Shift+Arrow and Delete ran over the viewed sheet's
 *     selection in the middle of typing =SUM( -- while every extension
 *     listener for the same keys (which did read the flag) stood down.
 *
 * Exported so the extension-facing question -- @api/editing `isEditKeystroke`,
 * which an extension's OWN key listener asks before acting on the selection --
 * is built FROM this rule rather than beside it, so a listener and the binding
 * for the same key cannot disagree.
 */
export function isEditingKeystroke(event: KeyboardEvent): boolean {
  return ownsItsOwnKeys(event) || isCellEditLive();
}

/**
 * Whether a CELL EDIT is live, wherever its keyboard is: Core's own (in-cell
 * editor, formula bar, or parked on another sheet) or an external session. The
 * one question both halves of the dispatcher ask -- the editing context above
 * and the grid-scoped refusal in handleGlobalKeyDown -- so they cannot drift.
 */
function isCellEditLive(): boolean {
  return isCoreCellEditOpen() || isExternalEditLive();
}

/**
 * Check if focus is currently within the spreadsheet grid container.
 * When focus is outside the grid (e.g., in a dialog, side pane, or menu),
 * grid-scoped keybindings should not fire so that native browser behaviour
 * (e.g., Ctrl+C to copy selected text) works as expected.
 *
 * PUBLIC, because it is not only this dispatcher's question. Any extension that
 * installs its OWN global key listener has to ask exactly this before acting on
 * the document, and `isKeyClaimed` is not a substitute: a pointer claim is a
 * GRID-OVERLAY concept, so a `<button>` or a `<select>` in a task pane or on the
 * ribbon carries no claim and is none of INPUT/TEXTAREA/contentEditable either.
 * Charts' Delete listener had only that tag list, which made "select a chart,
 * click a tab in the Format pane, press Delete" DESTROY THE CHART in three
 * clicks. Re-deriving the selector inside an extension would be a second
 * spelling of a Core concern that drifts on the first change to the container
 * attribute, so the predicate is exported instead of copied.
 */
export function isGridFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const container = (active as HTMLElement).closest?.('[data-focus-container="spreadsheet"]');
  return container !== null && container !== undefined;
}

/**
 * True if the user has a non-collapsed DOM text selection (e.g. selected text in
 * a toast, dialog, or side panel). Grid cells are canvas-drawn and never produce
 * a DOM text selection, so this reliably means the user wants to copy/cut that
 * text — not the active cell — even while the grid still holds focus.
 */
function hasDomTextSelection(): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().trim() !== "";
}

/**
 * Command IDs that should only fire when the grid has focus.
 * When focus is in a dialog, side pane, or menu, these are skipped
 * so native browser shortcuts (copy, paste, undo, etc.) work normally.
 */
const GRID_SCOPED_COMMANDS = new Set([
  "core.clipboard.copy",
  "core.clipboard.cut",
  "core.clipboard.paste",
  "core.clipboard.pasteSpecial",
  "core.clipboard.pasteValues",
  "core.clipboard.pasteFormulas",
  "core.clipboard.pasteFormatting",
  "core.clipboard.pasteLink",
  "core.edit.clearContents",
  "core.edit.fillDown",
  "core.edit.fillRight",
  "core.edit.fillUp",
  "core.edit.fillLeft",
  "core.format.cells",
  "core.grid.merge",
  // The rest of Excel's Merge menu: unbound by default, but a user's own
  // binding for them must stand down during a cell edit or a dialog exactly
  // as Ctrl+M does.
  "core.grid.mergeCenter",
  "core.grid.mergeAcross",
  "core.grid.unmerge",
]);

// ============================================================================
// Registry Operations
// ============================================================================

/**
 * Get all registered keybindings.
 */
export function getAllKeybindings(): KeyBinding[] {
  return Array.from(registry.values());
}

/**
 * Whether a binding belongs in the user-facing shortcut list (see
 * {@link KeyBinding.listed}). The ONE spelling of the rule, so the settings
 * page's rows and its conflict warnings cannot disagree about it.
 */
export function isListedKeybinding(binding: KeyBinding): boolean {
  return binding.listed !== false;
}

/**
 * Get a keybinding by ID.
 */
export function getKeybinding(id: string): KeyBinding | undefined {
  return registry.get(id);
}

/**
 * Get all keybindings for a given category.
 */
export function getKeybindingsForCategory(category: string): KeyBinding[] {
  return getAllKeybindings().filter((b) => b.category === category);
}

/**
 * Get all distinct categories.
 */
export function getCategories(): string[] {
  const categories = new Set<string>();
  registry.forEach((b) => categories.add(b.category));
  return Array.from(categories).sort();
}

/**
 * Get the effective combo for a keybinding (user override or default).
 */
export function getEffectiveCombo(id: string): string {
  const binding = registry.get(id);
  // A SCRIPT binding ignores user overrides entirely. It is a live grant, not a
  // preference: remapping it would mean persisting an override under an id that
  // disappears the moment the script unmounts — ambient state outliving the code
  // it belongs to, which is the exact failure this feature must not reintroduce.
  if (binding && binding.source === "script") return binding.combo;
  const override = userOverrides.get(id);
  if (override !== undefined) return override;
  return binding ? binding.combo : "";
}

/**
 * Check if a keybinding has a user override.
 */
export function hasUserOverride(id: string): boolean {
  return userOverrides.has(id);
}

/**
 * Get the default combo for a keybinding (ignoring overrides).
 */
export function getDefaultCombo(id: string): string {
  const binding = registry.get(id);
  return binding ? binding.combo : "";
}

// ============================================================================
// User Customization
// ============================================================================

// ---------------------------------------------------------------------------
// A BARE printable key is never a user shortcut (owner call 23, 2026-10-02)
// ---------------------------------------------------------------------------
//
// A user's binding on a key the GRID owns wins, with the conflict named in
// Settings (Ctrl+Space, M8 S9) -- the user's choice, and it stays. A binding on
// a BARE key is not that choice. This dispatcher is a window-capture listener,
// so a bare "A" (context "always") took every "a" typed into a dialog's text
// field, and a bare Space every space; Enter stopped confirming entries.
// Forcing such a binding to "not while editing" would not have saved it:
// typing into a CELL begins in ready mode, which is not editing, so a
// "not-editing" bare "A" still took the first letter of every cell entry. So
// the two doors a user shortcut is written through -- a remap
// (setUserKeybinding) and a new shortcut (addCustomKeybinding) -- REFUSE it
// before anything is stored, and Settings shows the same sentence and offers
// no Accept. A bare-key binding STORED before the rule is dropped when the
// bindings load, said on the console, so the next save writes it out
// (`dropStoredBareKey`). BARE means no Ctrl, Alt, Shift or Meta; the keys are Space,
// Enter and every key that types one printable character (a letter, a digit,
// a symbol, "+" spelled "Plus"). Keys that type nothing -- F1-F12, Delete,
// Tab, the arrows -- stay bindable bare, as before.

/** "Space", "Enter", or the one character a bare key types, as Settings shows it. */
function bareTypingKeyName(key: string): string | null {
  // parseCombo canonicalises "space"; "enter" is matched case-blind like any
  // other named key (matchesEvent), so it is read that way here too.
  if (key === "Space") return key;
  if (key.toLowerCase() === "enter") return "Enter";
  const character = comboKeyToEventKey(key);
  if ([...character].length !== 1 || /\s/u.test(character) || /\p{C}/u.test(character)) return null;
  return character.toUpperCase();
}

/**
 * Why a USER may not put a shortcut on `combo`, or null when the rule does
 * not apply: a bare Space, Enter or printable character is refused (see
 * above). The ONE spelling of the rule: the two write doors throw this
 * sentence, and Settings shows it and offers no Accept.
 */
export function bareKeyShortcutRefusal(combo: string): string | null {
  if (typeof combo !== "string" || combo.trim() === "") return null;
  const parsed = parseCombo(combo.trim());
  if (parsed.ctrl || parsed.alt || parsed.shift || parsed.meta) return null;
  const name = bareTypingKeyName(parsed.key);
  if (name === null) return null;
  const holdAModifier = " Hold Ctrl or Alt with it.";
  if (name === "Space") {
    return (
      "Space cannot be a shortcut on its own: it types a space in cells and text fields, and the " +
      "shortcut would take every space typed there." + holdAModifier
    );
  }
  if (name === "Enter") {
    return (
      "Enter cannot be a shortcut on its own: it confirms a cell entry or a dialog and starts a new " +
      "line in a text field, and the shortcut would take every one of those." + holdAModifier
    );
  }
  return (
    `"${name}" cannot be a shortcut on its own: it is typed into cells and text fields, and the ` +
    `shortcut would take every "${name}" typed there.` + holdAModifier
  );
}

/** Throw the refusal for a bare-key combination (see `bareKeyShortcutRefusal`). */
function refuseBareKeyShortcut(combo: string): void {
  const refusal = bareKeyShortcutRefusal(combo);
  if (refusal !== null) throw new Error(refusal);
}

/**
 * True -- said on the console with the rule's sentence -- when a STORED user
 * binding (a remap or a custom shortcut, `what` names it) sits on a bare
 * typing key. Such a binding was stored before the rule; both write doors
 * refuse it today, and loaded verbatim it took the typing exactly as before.
 * The loaders drop it, so it is never in effect and the next save writes it
 * out.
 */
function dropStoredBareKey(what: string, combo: unknown): boolean {
  const refusal = typeof combo === "string" ? bareKeyShortcutRefusal(combo) : null;
  if (refusal === null) return false;
  console.warn(`[Keybindings] Dropped ${what} on "${combo}": ${refusal}`);
  return true;
}

/**
 * Set a user override for a keybinding.
 *
 * Returns the script collision this remap created, if any. Remapping an EXISTING
 * shortcut onto a combination a running script holds is the same silent takeover
 * as creating a new one, so it gets the same warning — see
 * `findScriptKeybindingCollision`.
 *
 * THROWS, storing nothing, for a bare Space, Enter or printable character
 * (`bareKeyShortcutRefusal`, owner call 23).
 */
export function setUserKeybinding(id: string, combo: string): KeybindingCollision | null {
  // Script shortcuts are not remappable (see getEffectiveCombo): storing an
  // override here would be silently ignored at dispatch AND would leave a
  // persisted entry for an id that vanishes at unmount. Refuse instead of
  // pretending. Removing the shortcut outright IS supported —
  // revokeScriptKeybinding.
  if (registry.get(id)?.source === "script") {
    console.warn(
      `[Keybindings] '${id}' belongs to a running script and cannot be remapped; ` +
        "remove it instead.",
    );
    return null;
  }
  refuseBareKeyShortcut(combo);
  const collision = findScriptKeybindingCollision(combo, id);
  userOverrides.set(id, combo);
  saveUserOverrides();
  notifyChange();
  announceCollision(collision);
  return collision;
}

/**
 * Reset a single keybinding to its default.
 */
export function resetUserKeybinding(id: string): void {
  userOverrides.delete(id);
  saveUserOverrides();
  notifyChange();
}

/**
 * Reset all keybindings to defaults.
 */
export function resetAllKeybindings(): void {
  userOverrides.clear();
  saveUserOverrides();
  notifyChange();
}

// ============================================================================
// Custom (User-Created) Keybindings
// ============================================================================

interface StoredCustomBinding {
  id: string;
  combo: string;
  commandId: string;
  label: string;
  category: string;
  context?: "always" | "editing" | "not-editing";
}

function loadCustomBindings(): void {
  try {
    const raw = localStorage.getItem(CUSTOM_BINDINGS_KEY);
    if (raw) {
      const bindings = JSON.parse(raw) as StoredCustomBinding[];
      for (const b of bindings) {
        if (dropStoredBareKey(`the shortcut '${b.label}'`, b.combo)) continue;
        const binding: KeyBinding = {
          ...b,
          source: "user",
        };
        registry.set(binding.id, binding);
      }
    }
  } catch {
    // ignore
  }
}

function saveCustomBindings(): void {
  const custom: StoredCustomBinding[] = [];
  registry.forEach((b) => {
    if (b.source === "user") {
      custom.push({
        id: b.id,
        combo: b.combo,
        commandId: b.commandId,
        label: b.label,
        category: b.category,
        context: b.context,
      });
    }
  });
  localStorage.setItem(CUSTOM_BINDINGS_KEY, JSON.stringify(custom));
}

// ---------------------------------------------------------------------------
// Shadowing a SCRIPT shortcut — the user always wins, and is always told
// ---------------------------------------------------------------------------
//
// `handleGlobalKeyDown` resolves a tie in the user's favour ("THE APP ALWAYS
// WINS"), which is the right outcome and must not change. What was missing is
// the sentence that goes with it.
//
// A script shortcut is REFUSED at registration if the combination is already
// taken (rule 3 above), so a collision can only be created from this side: the
// user binds — or remaps onto — a combination a mounted script already holds.
// The script keeps its registry row, keeps appearing in the shortcut list, and
// simply stops firing. Nothing anywhere explains why, and the person best placed
// to notice ("my macro stopped working") is the person with the least
// information. That silence is the VBA `Application.OnKey` failure mode wearing
// the opposite jacket: there, a script stole the user's key without saying so;
// here, the user takes the script's key without being told. Both leave somebody
// staring at a keyboard that does not do what the list says it does.
//
// So: warn at bind time, NAME the script, and never refuse. It is the user's
// keyboard.

/** A collision a user-created/remapped shortcut causes, in the words the
 *  warning uses. */
export interface KeybindingCollision {
  /** The canonical combination both sides want. */
  combo: string;
  /** Registry ids that will stop firing (script bindings only). */
  shadowedIds: string[];
  /** The owning scripts, by display name, for the sentence. */
  shadowedScriptNames: string[];
  /** What each shadowed shortcut used to call ("refreshAll()"). */
  shadowedLabels: string[];
  /** The full sentence to show the user. */
  message: string;
}

/**
 * Would binding `combo` shadow a live script shortcut? Returns the collision, or
 * null when the keys are free (or only collide with app bindings, which the
 * existing conflict log already covers and which the user can see in the list).
 *
 * Exported so a settings UI can warn BEFORE the user commits, not only after.
 */
export function findScriptKeybindingCollision(
  combo: string,
  excludeId?: string,
): KeybindingCollision | null {
  if (typeof combo !== "string" || combo.trim() === "") return null;
  const shadowed = findConflicts(combo, excludeId).filter((b) => b.source === "script");
  if (shadowed.length === 0) return null;

  const canonical = formatCombo(combo.trim());
  const names = [...new Set(shadowed.map((b) => scriptBindings.get(b.id)?.scriptName ?? b.category))];
  const labels = shadowed.map((b) => b.label);
  const subject =
    names.length === 1
      ? `the script "${names[0]}"`
      : `the scripts ${names.map((n) => `"${n}"`).join(", ")}`;
  return {
    combo: canonical,
    shadowedIds: shadowed.map((b) => b.id),
    shadowedScriptNames: names,
    shadowedLabels: labels,
    message:
      `${canonical} is already used by ${subject} (${labels.join(", ")}). ` +
      "Your shortcut wins — Calcula always prefers yours over a script's — so that " +
      "script will stop responding to those keys until you change or remove your shortcut.",
  };
}

/** Warn once, through the app's own toast, so the explanation reaches the user
 *  even when the calling UI ignores the returned collision. */
function announceCollision(collision: KeybindingCollision | null): void {
  if (!collision) return;
  console.warn(`[Keybindings] ${collision.message}`);
  try {
    showToast(collision.message, { variant: "warning", duration: 9000 });
  } catch {
    /* a window with no toast sink registered must not break the binding */
  }
}

/** What `addCustomKeybinding` answers with: the binding, plus the collision it
 *  created (null when the keys were free). */
export interface AddCustomKeybindingResult {
  binding: KeyBinding;
  /** Non-null when a live script shortcut has just been shadowed. */
  collision: KeybindingCollision | null;
}

/**
 * Add a new custom keybinding created by the user.
 *
 * Never refuses a combination something else holds: the user's keyboard is the
 * user's. It DOES report — and announce — when the new shortcut takes a
 * combination a running script holds, because app-wins silently is
 * indistinguishable from the script being broken.
 *
 * THROWS, adding nothing, for a bare Space, Enter or printable character,
 * whatever the context (`bareKeyShortcutRefusal`, owner call 23): that is not
 * a key anyone else holds but the typing itself.
 */
export function addCustomKeybinding(
  combo: string,
  commandId: string,
  label: string,
  category?: string,
  context?: "always" | "editing" | "not-editing",
): AddCustomKeybindingResult {
  refuseBareKeyShortcut(combo);
  const id = `user.custom.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  const binding: KeyBinding = {
    id,
    combo,
    commandId,
    label: label || commandId,
    category: category || "Custom",
    context: context ?? "always",
    source: "user",
  };
  // Computed BEFORE the registry write, so the new binding cannot be reported as
  // colliding with itself.
  const collision = findScriptKeybindingCollision(combo, id);
  registry.set(id, binding);
  saveCustomBindings();
  notifyChange();
  announceCollision(collision);
  return { binding, collision };
}

/**
 * Remove a user-created custom keybinding.
 * Only works for bindings with source === "user".
 */
export function removeCustomKeybinding(id: string): boolean {
  const binding = registry.get(id);
  if (!binding || binding.source !== "user") return false;
  registry.delete(id);
  userOverrides.delete(id);
  saveCustomBindings();
  saveUserOverrides();
  notifyChange();
  return true;
}

// NOTE (W19): there is deliberately no "does the registry bind this command?"
// helper for an extension's own key listener to stand aside by. A listener of
// an extension's own for a command the registry binds is the defect: one
// keystroke ran the command twice (the binding and the listener, BUG-0199's
// Format Painter), or a key the user had remapped AWAY kept running it from
// the listener's hard-coded combo (BUG-0183). Those listeners were deleted in
// wave B; register the command and let a binding run it.

/**
 * Get all available command IDs from the CommandRegistry.
 */
export function getAvailableCommands(): string[] {
  return CommandRegistry.getAll().filter((cmd): cmd is string => typeof cmd === "string");
}

// ============================================================================
// Conflict Detection
// ============================================================================

/**
 * The SPACE keys the grid answers itself (core/hooks/useGridKeyboard.ts, its
 * Spacebar block; bare Space also applies the focused slicer or timeline item
 * while the keyboard is inside one, M8 S7/S8), none of which the registry
 * holds. Until M8 S9 no combination on Space could fire at all. Now a user's
 * binding on one takes the key BEFORE the grid -- this dispatcher is a
 * window-capture listener -- which is the user's choice to make; but
 * Settings' conflict check reads findConflicts, and without these rows it
 * presented Ctrl+Space as FREE.
 *
 * So they are reported as conflicts and nothing else: never in the registry
 * (no row in the shortcut list, nothing to remap), never matched by the
 * dispatcher, so with nothing bound the keystroke reaches the grid exactly as
 * before. (The grid also reads Meta as Ctrl here; Windows keeps Win+Space.)
 *
 * SPACE ONLY, knowingly: the grid's other own keys (Escape, Tab, Enter, the
 * arrows, F2, Ctrl+A, Ctrl+B/I/U, ...) are the same gap and predate S9 -- see
 * the sandboxed-contribution check in scriptHost/extensionWorkerHost.ts.
 */
const GRID_SPACE_KEYS: readonly KeyBinding[] = [
  { id: "grid.space", combo: "Space", commandId: "", label: "Toggle Check Box / Apply Slicer or Timeline Item (built-in key)", category: "Grid", source: "built-in" },
  { id: "grid.shiftSpace", combo: "Shift+Space", commandId: "", label: "Select Entire Row (built-in key)", category: "Grid", source: "built-in" },
  { id: "grid.ctrlSpace", combo: "Ctrl+Space", commandId: "", label: "Select Entire Column (built-in key)", category: "Grid", source: "built-in" },
  { id: "grid.ctrlShiftSpace", combo: "Ctrl+Shift+Space", commandId: "", label: "Select All (built-in key)", category: "Grid", source: "built-in" },
];

/** Same key (named keys canonical, letters case-blind) and the same modifiers. */
function sameCombo(a: ParsedCombo, b: ParsedCombo): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt &&
    a.meta === b.meta
  );
}

/**
 * Find conflicts for a given combo (excluding a specific binding id): every
 * registry binding on it, and the grid's own Space key on it (GRID_SPACE_KEYS
 * -- a copy, never a registry row).
 */
export function findConflicts(combo: string, excludeId?: string): KeyBinding[] {
  const parsed = getCachedParsedCombo(combo);
  const conflicts: KeyBinding[] = [];

  registry.forEach((binding) => {
    if (excludeId && binding.id === excludeId) return;
    const effectiveCombo = getEffectiveCombo(binding.id);
    if (sameCombo(parsed, getCachedParsedCombo(effectiveCombo))) {
      conflicts.push(binding);
    }
  });

  for (const gridKey of GRID_SPACE_KEYS) {
    if (sameCombo(parsed, getCachedParsedCombo(gridKey.combo))) conflicts.push({ ...gridKey });
  }

  return conflicts;
}

// ============================================================================
// Extension Registration
// ============================================================================

/**
 * Applicability predicates, keyed by binding id.
 *
 * PRIVATE, and deliberately not a field on {@link KeyBinding}: a callable on the
 * binding object would leak through `getAllKeybindings()` into the settings UI
 * and into every consumer that serialises a binding — the same reason the script
 * runners live in their own map. Nothing outside this module can read one back.
 */
const bindingGuards: Map<string, () => boolean> = new Map();

/**
 * Register a keybinding. Returns an unregister function.
 *
 * `when` is an optional applicability predicate — VS Code's "when clause", and
 * the ONLY way two features can share one combination honestly. Without it the
 * dispatcher settles a tie by REGISTRATION ORDER, which means the built-ins
 * (registered in `initKeybindings`, long before any extension activates) always
 * win; a feature that legitimately owns a key only while its own subject is
 * selected could never say so. Excel's Ctrl+1 is exactly that key: it formats
 * CELLS, except while a chart element is selected, when it formats the chart.
 *
 * Three rules, all here rather than at the call site:
 *  - A guarded binding that says no is SKIPPED, and it is skipped before
 *    `matches` is populated, so it cannot suppress the unguarded binding
 *    underneath it or swallow the keystroke with a preventDefault.
 *  - A guarded binding that says yes BEATS an unguarded one, because it is the
 *    more specific claim. Ties among guarded bindings fall back to registration
 *    order, as before.
 *  - A predicate that THROWS counts as "does not apply". A broken extension must
 *    not be able to take a key away from the app by failing.
 */
export function registerKeybinding(binding: KeyBinding, when?: () => boolean): () => void {
  installListener();

  if (registry.has(binding.id)) {
    console.warn(`[Keybindings] Overwriting keybinding: ${binding.id}`);
  }
  registry.set(binding.id, binding);
  if (when === undefined) bindingGuards.delete(binding.id);
  else bindingGuards.set(binding.id, when);

  // Log conflicts
  const effectiveCombo = getEffectiveCombo(binding.id);
  const conflicts = findConflicts(effectiveCombo, binding.id);
  if (conflicts.length > 0) {
    console.warn(
      `[Keybindings] Shortcut conflict for '${effectiveCombo}': ` +
        `${binding.id} vs ${conflicts.map((c) => c.id).join(", ")}`
    );
  }

  notifyChange();

  return () => {
    registry.delete(binding.id);
    bindingGuards.delete(binding.id);
    notifyChange();
  };
}

/** Does this binding currently apply? Guardless bindings always do. */
function bindingApplies(id: string): boolean {
  const guard = bindingGuards.get(id);
  if (guard === undefined) return true;
  try {
    return guard() === true;
  } catch (err) {
    console.error(`[Keybindings] 'when' predicate for '${id}' threw; treating as inapplicable:`, err);
    return false;
  }
}

// ============================================================================
// Script-owned shortcuts (the `ui.shortcut` capability)
// ============================================================================
//
// A keyboard hook is a HIJACK PRIMITIVE, and it is the one VBA gave away for
// free: `Application.OnKey "^s", "MyMacro"` silently takes Ctrl+S from the user
// with no record anywhere that it happened. Everything below exists so that the
// same convenience cannot become the same trap.
//
// FIVE RULES, all enforced here rather than at the call site, because the call
// site is reached from three surfaces (object scripts, the broker, tests) and a
// rule that lives in a caller is a rule with a hole in it:
//
//  1. SHAPE (an allowlist, not a blocklist). A script shortcut MUST be
//     Ctrl+Shift+<letter>. A blocklist of "keys the app needs" would have to be
//     exhaustive to be safe, and it cannot be: the grid owns Escape, Tab,
//     Enter, Backspace, Delete, every arrow, Home/End/PageUp/PageDown, Space,
//     F1-F12 and every unmodified printable character (that is TYPING), while
//     the registry owns most Ctrl+<key> combinations and a user override can
//     FREE one of those at any moment. One missed row and a script eats a key
//     the user needs. An allowlist cannot be under-inclusive. It also dodges a
//     second trap: Ctrl+Alt is AltGr on European layouts (on sv-SE, Ctrl+Alt+2
//     is how you type "@"), so the Ctrl+Alt space is not free either — which is
//     exactly the kind of thing a blocklist author never thinks of.
//     Ctrl+Shift+<letter> is also the space VBA authors already use ("^+R").
//  2. RESERVED. Ctrl+Shift+<letter> combinations Calcula or Excel own are
//     refused by NAME, independently of what is currently in the registry —
//     because `findConflicts` only sees today's registry, and a user who has
//     remapped Ctrl+Shift+L has not thereby offered it to a script.
//  3. CONFLICT. A combination already bound by anything — a built-in, an
//     add-in, another script, the user — is REFUSED, never overridden. (The
//     dispatcher additionally lets a non-script binding win a tie, so a
//     built-in registered LATER still cannot be shadowed by registration
//     order. That ordering accident is how this went wrong before.)
//  4. LIFETIME. Script bindings are never persisted and never user-remappable:
//     they live in the registry only while the script is mounted, and
//     `revokeScriptKeybindingsForScript` at unmount takes them all back. A
//     stored override for an id that disappears on unmount would be precisely
//     the ambient state this must not create.
//  5. NO KEYSTREAM. The handler is called with `{ combo }` and nothing else —
//     not the DOM event, not the key, not the target, and never a keystroke the
//     script did not bind. There is no "onKey" firehose to subscribe to.

/** The one shape a script shortcut may take, in the words the refusal uses. */
export const SCRIPT_SHORTCUT_SHAPE_RULE =
  "a script shortcut must be Ctrl+Shift+<letter>, for example Ctrl+Shift+R";

/**
 * Ctrl+Shift+<letter> combinations a script may never claim, whatever the
 * registry currently holds. The first group is Calcula's own (they are also in
 * DEFAULT_KEYBINDINGS, so rule 3 would normally catch them — this list is what
 * still refuses them after a user has remapped them away). The second group is
 * Excel's, reserved so that shipping the matching feature later cannot be
 * blocked by a shortcut some workbook's script grabbed first.
 */
const RESERVED_SCRIPT_COMBOS: ReadonlySet<string> = new Set([
  // Calcula
  "CTRL+SHIFT+C", // Format Painter
  "CTRL+SHIFT+V", // Paste Special
  "CTRL+SHIFT+S", // Save As
  "CTRL+SHIFT+H", // Find and Replace
  "CTRL+SHIFT+E", // Toggle File Explorer
  "CTRL+SHIFT+X", // Toggle Extensions Manager
  "CTRL+SHIFT+L", // Toggle AutoFilter
  "CTRL+SHIFT+B", // Toggle Bookmark
  "CTRL+SHIFT+N", // Toggle Script Notebook
  "CTRL+SHIFT+U", // Expand/Collapse Formula Bar — was reserved-only until the
                  // expanded bar shipped; it moved up here rather than out
                  // because this group is what still refuses a combination
                  // after the user has remapped the built-in away.
  // Excel parity
  "CTRL+SHIFT+A", // Insert argument names
  "CTRL+SHIFT+F", // Format Cells (Font)
  "CTRL+SHIFT+O", // Select cells with comments
  "CTRL+SHIFT+P", // Format Cells (Font size)
]);

/** How many shortcuts one script may hold at once. A script that wants nine
 *  hotkeys is not automating a workbook, it is taking over a keyboard. */
export const MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT = 8;

/** A script shortcut as the transparency surfaces (and the script itself) see
 *  it. Pure data — the runner is deliberately not reachable from here. */
export interface ScriptKeybinding {
  /** Registry id: `script:<scriptId>:<CANONICAL COMBO>`. */
  id: string;
  /** Canonical combo ("Ctrl+Shift+R"). */
  combo: string;
  scriptId: string;
  scriptName: string;
  /** The name of the method the script exposed; what pressing the keys calls. */
  handler: string;
  /** Human label shown in the shortcut list. */
  label: string;
}

export type ScriptKeybindingRefusalCode = "invalid" | "reserved" | "conflict" | "limit";

export type ScriptKeybindingResult =
  | { ok: true; binding: ScriptKeybinding }
  | { ok: false; code: ScriptKeybindingRefusalCode; reason: string };

/** Live script bindings by registry id (data), and their runners (callables,
 *  kept apart so `getAllKeybindings()` can never hand one out). */
const scriptBindings = new Map<string, ScriptKeybinding>();
const scriptRunners = new Map<string, (combo: string) => void>();

/**
 * Why a script may not have this combination — or null if it may ask for it.
 * Rules 1 and 2 only; the conflict and limit checks need the registry and live
 * in `registerScriptKeybinding`.
 */
export function scriptComboRefusal(combo: unknown): string | null {
  if (typeof combo !== "string" || combo.trim() === "") {
    return `a shortcut must be a key combination — ${SCRIPT_SHORTCUT_SHAPE_RULE}`;
  }
  const parsed = parseCombo(combo.trim());
  if (!parsed.ctrl || !parsed.shift || parsed.alt || parsed.meta || !/^[A-Za-z]$/.test(parsed.key)) {
    return (
      `"${combo}" is not a shortcut a script may take — ${SCRIPT_SHORTCUT_SHAPE_RULE}. ` +
      "Calcula keeps every other combination for the grid and the app (typing, " +
      "Escape, Tab, the arrows, the function keys, Ctrl+S, Ctrl+Z, Ctrl+C, ...)"
    );
  }
  const canonical = `CTRL+SHIFT+${parsed.key.toUpperCase()}`;
  if (RESERVED_SCRIPT_COMBOS.has(canonical)) {
    return `Ctrl+Shift+${parsed.key.toUpperCase()} is reserved by Calcula and cannot be taken by a script`;
  }
  return null;
}

/** Canonical registry id for a script binding. */
function scriptBindingId(scriptId: string, canonicalCombo: string): string {
  return `script:${scriptId}:${canonicalCombo.toUpperCase()}`;
}

/**
 * Bind one shortcut to one script. Refuses — loudly, with a reason a
 * non-programmer can read — rather than silently dropping or overriding.
 *
 * `run` is invoked with the canonical combo when the keys are pressed; it is
 * the ONLY thing the script ever learns about the keyboard.
 */
export function registerScriptKeybinding(req: {
  scriptId: string;
  scriptName: string;
  combo: string;
  handler: string;
  label?: string;
  run: (combo: string) => void;
}): ScriptKeybindingResult {
  const shapeProblem = scriptComboRefusal(req.combo);
  if (shapeProblem) {
    const code: ScriptKeybindingRefusalCode = shapeProblem.includes("reserved by Calcula")
      ? "reserved"
      : "invalid";
    return { ok: false, code, reason: shapeProblem };
  }
  if (typeof req.handler !== "string" || req.handler.trim() === "") {
    return { ok: false, code: "invalid", reason: "a shortcut must name a method to run" };
  }

  const combo = formatCombo(req.combo.trim());
  const id = scriptBindingId(req.scriptId, combo);

  // Re-binding the SAME combo from the SAME script replaces its own handler —
  // that is an update, not a conflict. Anything else already holding the combo
  // is a refusal.
  const conflicts = findConflicts(combo, id);
  if (conflicts.length > 0) {
    return {
      ok: false,
      code: "conflict",
      reason:
        `${combo} is already bound to "${conflicts[0].label}" — a script may only claim ` +
        "a shortcut nothing else uses",
    };
  }

  const owned = [...scriptBindings.values()].filter((b) => b.scriptId === req.scriptId);
  if (!scriptBindings.has(id) && owned.length >= MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT) {
    return {
      ok: false,
      code: "limit",
      reason: `a script may hold at most ${MAX_SCRIPT_KEYBINDINGS_PER_SCRIPT} keyboard shortcuts at a time`,
    };
  }

  installListener();

  const handler = req.handler.trim();
  const label = (req.label ?? "").trim() || `${handler}()`;
  const binding: ScriptKeybinding = {
    id,
    combo,
    scriptId: req.scriptId,
    scriptName: req.scriptName,
    handler,
    label,
  };
  scriptBindings.set(id, binding);
  scriptRunners.set(id, req.run);
  registry.set(id, {
    id,
    combo,
    // A script binding runs an EXPOSED METHOD, not a command: putting the
    // handler in the global command registry would let anything that can
    // execute a command call it, which is reach the script never asked for.
    commandId: "",
    label,
    // Attribution is HOST-supplied: the category names the owning script, so a
    // script shortcut can never present itself as a built-in in the list.
    category: req.scriptName,
    // NOT the script's choice. A shortcut that fired while the user is typing
    // into the formula bar or a dialog field would both break text entry and
    // turn a bound combo into a way to watch someone type.
    context: "not-editing",
    source: "script",
    scriptId: req.scriptId,
  });
  notifyChange();
  return { ok: true, binding };
}

/** Every live script shortcut (all scripts, or one script's own). */
export function listScriptKeybindings(scriptId?: string): ScriptKeybinding[] {
  const all = [...scriptBindings.values()];
  const scoped = scriptId === undefined ? all : all.filter((b) => b.scriptId === scriptId);
  return scoped
    .map((b) => ({ ...b }))
    .sort((a, b) => a.combo.localeCompare(b.combo) || a.scriptId.localeCompare(b.scriptId));
}

/** Take one script shortcut back. Used by the script itself (unbind), by the
 *  transparency surface (the user's Remove button) and by unmount. */
export function revokeScriptKeybinding(id: string): boolean {
  if (!scriptBindings.has(id)) return false;
  scriptBindings.delete(id);
  scriptRunners.delete(id);
  registry.delete(id);
  notifyChange();
  return true;
}

/** Take back ONE combo held by ONE script (the script's own `unbind`). */
export function revokeScriptKeybindingCombo(scriptId: string, combo: string): boolean {
  if (typeof combo !== "string" || combo.trim() === "") return false;
  return revokeScriptKeybinding(scriptBindingId(scriptId, formatCombo(combo.trim())));
}

/** Take back everything a script holds. Called at unmount — a shortcut must not
 *  outlive the code it runs. */
export function revokeScriptKeybindingsForScript(scriptId: string): number {
  const ids = [...scriptBindings.values()].filter((b) => b.scriptId === scriptId).map((b) => b.id);
  for (const id of ids) {
    scriptBindings.delete(id);
    scriptRunners.delete(id);
    registry.delete(id);
  }
  if (ids.length > 0) notifyChange();
  return ids.length;
}

// ============================================================================
// Change Notification
// ============================================================================

export function subscribeToKeybindingChanges(callback: ChangeListener): () => void {
  changeListeners.add(callback);
  return () => changeListeners.delete(callback);
}

function notifyChange(): void {
  // Invalidate parsed combo cache — bindings may have changed
  comboCache.clear();

  changeListeners.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.error("[Keybindings] Error in change listener:", e);
    }
  });
}

// ============================================================================
// Command refusals ("not this command, right now" -- whatever its keys)
// ============================================================================
//
// A feature that must say "not now" to somebody else's command -- FloatingRange
// refusing Copy, Paste, Fill, Format Cells while ITS range owns the selection,
// because those commands would act on Core's HIDDEN cell -- used to do it by
// binding the command's DEFAULT combination (a guarded, exclusive binding).
// That refused the KEY, not the command: a user who moved Copy to Ctrl+Shift+Q
// copied the hidden cell with the new key, while the old key, no longer Copy,
// still showed the refusal (BUG-0199). A refusal registered here is asked at
// the dispatcher's WINNER, by command id, so it follows every remap -- and the
// dispatcher's own rules still come first: a grid-scoped command off the grid,
// a copy with DOM text selected and any "not-editing" key during an edit are
// never matched, so they are never refused either (they stay native).

// The registry itself lives in ./commandRefusals, so the OTHER command door --
// CommandRegistry.execute (ribbon, menus, Quick Access Toolbar, command line,
// scripts' executeCommand) -- asks the same refusals; only the keyboard asked
// them when they lived here (found live 2026-09-29, e2e fixall-edit W15).
export { commandRefusalFor } from "./commandRefusals";
export type { CommandRefusal } from "./commandRefusals";

/**
 * Register a refusal. Returns the cleanup. When a refused command wins a
 * keystroke, the dispatcher takes the key (preventDefault), stops it from
 * reaching ANY other key listener (stopImmediatePropagation -- an extension's
 * own listener for the same key must not run the refused action anyway), shows
 * the sentence, and runs nothing. CommandRegistry.execute refuses it the same
 * way from every other door.
 */
export function registerCommandRefusal(refusal: CommandRefusal): () => void {
  installListener();
  return addCommandRefusal(refusal);
}

// ============================================================================
// Shortcut capture (a settings box RECORDING a key combination)
// ============================================================================
//
// A box that records "press the keys you want" must receive EVERY combination,
// the ones already bound included -- recording Ctrl+S is the whole point of
// remapping onto it. The dispatcher below is a window-CAPTURE listener, the
// outermost there is: it matched Ctrl+S and SAVED the workbook before the box
// heard it, and the extensions' own window-capture listeners (Print's Ctrl+P,
// File Explorer's Ctrl+Shift+E, ...) acted on the rest (BUG-0199). So the
// dispatcher hands a keystroke aimed at an active capture box to that box and
// stops it there -- stopImmediatePropagation, so no other key listener hears a
// key that is being recorded -- and runs nothing.

interface ShortcutCapture {
  element: HTMLElement;
  onKey: (event: KeyboardEvent) => void;
}

/**
 * Every open capture box. SEVERAL can be open at once -- Settings keeps the Add
 * Shortcut form open while a row's Edit is used -- so this is a set, and a key
 * goes to the box that holds it. It was one slot ("a newer capture replaces an
 * older one"): a row's Edit evicted the Add box, which never registered again,
 * and Ctrl+S pressed in the Add box SAVED the workbook (review of BUG-0199).
 */
const activeCaptures = new Set<ShortcutCapture>();

/**
 * Make `element` a shortcut capture box: while it (or anything inside it) has
 * the keyboard, every non-modifier keydown is handed to `onKey` INSTEAD of
 * being dispatched -- no command runs and no other key listener hears it.
 * Keys aimed anywhere else dispatch as usual. Returns the release, which ends
 * THIS capture only: any number of boxes may capture at once, and releasing
 * one never ends another (nor does a second release of the same one).
 */
export function beginShortcutCapture(
  element: HTMLElement,
  onKey: (event: KeyboardEvent) => void,
): () => void {
  installListener();
  const capture: ShortcutCapture = { element, onKey };
  activeCaptures.add(capture);
  return () => {
    activeCaptures.delete(capture);
  };
}

/**
 * The capture box this keystroke is aimed at, or null: the box holding the
 * event's TARGET, else the box holding the focused element. When boxes nest,
 * the innermost holder wins; for one element registered twice, the newest.
 */
function captureFor(event: KeyboardEvent): ShortcutCapture | null {
  if (activeCaptures.size === 0) return null;
  const target = event.target;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  for (const node of [target instanceof Node ? target : null, active]) {
    if (node === null) continue;
    let best: ShortcutCapture | null = null;
    for (const capture of activeCaptures) {
      if (!capture.element.isConnected || !capture.element.contains(node)) continue;
      // Later registrations and inner elements win (`contains` is inclusive).
      if (best === null || best.element.contains(capture.element)) best = capture;
    }
    if (best !== null) return best;
  }
  return null;
}

// ============================================================================
// Centralized Keyboard Dispatcher
// ============================================================================

/**
 * Whether this keystroke TYPES an AltGr character into a cell in READY mode
 * (W17, the owner's decision on the wave-B KNOWN CONFLICT): TYPING WINS.
 *
 * Windows reports AltGr as Ctrl+Alt, and Chromium cannot tell AltGr+8 from
 * Ctrl+AltGr+8. So the tolerant tiers read sv-SE's AltGr+8 / AltGr+9 ("[" /
 * "]") as Ctrl+[ / Ctrl+] (Previous / Next Bookmark), AltGr+M (the micro
 * sign) as New Comment's Ctrl+Alt+M, and AltGr+2 ("@") as a user's
 * Ctrl+Alt+2 -- and none of those characters could BEGIN a cell entry, while
 * Excel starts one with each. In ready mode the character wins; the commands
 * stay reachable from their menus, by a remap, and from the keyboard
 * anywhere else (a ribbon button, a pane), where nothing would be typed.
 *
 * An AltGr character: Ctrl+Alt producing a printable character that is not a
 * plain ASCII letter or digit -- the grid's own rule (isTypedCharacterKey), so
 * the dispatcher lets through exactly what the grid then types. Ready mode:
 * no text field, claim or cell edit owns the key (the caller's `editing`),
 * and a CELL would receive it:
 *   - Core's grid holds the selection, has the keyboard, and has a CELL
 *     selected (`coreGridHasACell`) -- a CANVAS has none, so on a canvas
 *     with nothing claiming the selection the keystroke is the shortcut
 *     (X16: sv-SE AltGr+9 there did nothing at all, where it used to be Next
 *     Bookmark); or
 *   - something else owns the selection and its OWN cell takes typing
 *     (`receivesTyping`: a floating grid's selected cell, whose type-to-edit
 *     listens on the window), with the keyboard the grid's or on the body.
 * Review C: a floating grid selected as a whole OBJECT claims the selection
 * with the grid still focused, and no cell of it takes typing -- W17 asked
 * only "is the grid focused", so AltGr+9 went on to Core's type-to-edit,
 * which opened an edit of Core's HIDDEN active cell. There, nothing would be
 * typed (Core's door refuses while the claim lasts), so the keystroke is the
 * shortcut it always was. An EXACT binding of the typed character (a user who
 * recorded Ctrl+Alt+@) is not a tolerant match, and still runs.
 */
function typesAltGrCharacterIntoACell(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey && event.altKey) || !isTypedCharacterKey(event)) return false;
  if (isEditingKeystroke(event)) return false;
  const gridFocused = isGridFocused();
  if (!isSelectionOwned()) return gridFocused && coreGridHasACell();
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const keyboardIsTheGrids = gridFocused || active === null || active === document.body;
  return keyboardIsTheGrids && selectionOwnerReceivesTyping();
}

/**
 * Whether Core's grid has a CELL a typed character would open an entry in: a
 * selection. Core's type-to-edit opens nothing without one, and a CANVAS never
 * has one (the reducer drops the cell selection on entering a canvas). No grid
 * state at all (nothing mounted yet) says nothing about a canvas, so it leaves
 * the answer to the focus test alone.
 */
function coreGridHasACell(): boolean {
  const state = getGridStateSnapshot();
  return state === null || state.selection !== null;
}

/**
 * Handle a global keydown event against all registered keybindings.
 * Returns true if a keybinding was matched and the command was executed.
 */
export function handleGlobalKeyDown(event: KeyboardEvent): boolean {
  // Skip pure modifier keys
  const modifierKeys = ["Control", "Shift", "Alt", "Meta"];
  if (modifierKeys.includes(event.key)) return false;

  // A settings box is RECORDING a combination: the key is its, not a command's
  // (see "Shortcut capture" above). Before everything, the registry-empty
  // early-out included -- a recorded key must never reach another listener.
  const capture = captureFor(event);
  if (capture) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      capture.onKey(event);
    } catch (err) {
      console.error("[Keybindings] Error in a shortcut capture box:", err);
    }
    return true;
  }

  // A HELD CELL PRESS OWNS ESCAPE. Core's press session (core/lib/
  // cellPressRelease.ts) holds a press an in-cell button or a pivot +/-
  // claimed for its release, and Escape cancels it. This listener runs FIRST
  // (window capture, installed at startup, before the session's own
  // window-capture listener added at the press), so it stands aside: a binding
  // on Escape -- BUG-0270's object deselect -- acting on the same keystroke
  // made one Escape do two things. Not prevented here: the session prevents
  // it and stops it. Before a claim arrives nobody owns the press, and this
  // does not apply.
  if (event.key === "Escape" && isCellPressHeld()) return false;

  if (registry.size === 0) return false;

  // -------------------------------------------------------------------------
  // WHAT A POINTER CLAIM MEANS FOR A SHORTCUT
  //
  // This listener is capture-phase on `window`, the OUTERMOST position there is,
  // so it runs before every one of Core's three claim-honouring doors and it
  // calls preventDefault()+stopPropagation() on a match. Whatever it decides is
  // final; nothing downstream gets a second opinion. It therefore has to answer
  // the claim itself, and it answers it in three classes rather than one:
  //
  //   GRID-SCOPED (GRID_SCOPED_COMMANDS: clear contents, paste, the fills,
  //     merge, format cells). REFUSED inside a claim. The grid is not the target
  //     of this keystroke — a claimed element is a surface the user is looking
  //     at and typing into, and the selected CELLS are somewhere else entirely.
  //     This is the measured data-loss case: Delete with an on-grid form's
  //     <select> focused executed core.edit.clearContents over the sheet.
  //     Refusing before `matches` is populated also means no preventDefault, so
  //     Ctrl+V falls through to the browser and pastes INTO THE FIELD.
  //
  //   EDITING-SENSITIVE (context: "not-editing" — undo, redo, and every script
  //     shortcut). REFUSED inside a claim, for exactly the reason an <input>
  //     already refused them: the claimant owns its own text and its own undo.
  //     Ctrl+Z in a form field must undo the typing, not the workbook.
  //
  //   TRULY GLOBAL (context "always" AND not grid-scoped: Ctrl+S, Ctrl+O,
  //     Ctrl+N, Ctrl+P, Ctrl+F, the panel toggles). ALLOWED inside a claim. A
  //     user typing into a form on a sheet still expects Ctrl+S to save the
  //     workbook. A blanket "a claim swallows every shortcut" would break Save,
  //     which is why the claim is folded into the two questions the dispatcher
  //     already asks instead of being a fourth gate in front of them.
  //
  // Both rules fall out of the binding's OWN declared metadata, so a new binding
  // is classified by what it says about itself — there is no third hand-written
  // list here to drift out of date.
  //
  // A LIVE EXTERNAL EDIT SESSION (a floating grid's cell edit, hosted by the
  // formula bar or parked on another sheet while it picks a reference) is
  // answered the SAME way as a claim, for the same reason: the keyboard belongs
  // to a formula being typed, and the selected cells of the sheet on screen
  // are not the target. It sets no Core editing flag and, parked or with the
  // formula bar hidden, the keyboard can sit on the grid's own container --
  // where Delete ran core.edit.clearContents over the viewed sheet's selection,
  // Ctrl+V pasted into it and Ctrl+Z undid a workbook action, all with the edit
  // still open, because this capture-phase dispatcher pre-empted the two Core
  // doors that route a live session's keys (useGridKeyboard's gate and the
  // container's fallback branch in useSpreadsheetEditing). So: "not-editing"
  // and grid-scoped bindings are refused WITHOUT preventDefault -- the key
  // falls through to those doors, which hand it to the session -- and truly
  // global ones (Ctrl+S, Ctrl+O, Ctrl+P) still work.
  //
  // CORE'S OWN EDIT is answered the same way, wherever its keyboard is
  // (isCellEditLive). Parked on another sheet while it picks a reference, the
  // keyboard sits on the grid container exactly like a parked session's, and
  // Delete cleared that sheet's selected cells mid-formula. In the in-cell
  // editor -- a <textarea> INSIDE the grid container, so "grid focused" held --
  // Ctrl+Shift+C started Format Painter, Ctrl+D/Ctrl+R filled, Ctrl+M merged
  // and Ctrl+V pasted over the selection rather than into the text being
  // typed. Refused unprevented, those keys reach the editor itself (Ctrl+C/X/V
  // become the text field's own clipboard, as they already were in the
  // formula bar and in a floating grid's editor) or, parked, Core's two doors,
  // which leave the grid alone while its edit is open. Excel ignores these in
  // edit mode.
  // -------------------------------------------------------------------------
  const editing = isEditingKeystroke(event);
  const gridFocused = isGridFocused() && !isClaimedKeystroke(event) && !isCellEditLive();
  // TYPING -- a text field, a live cell edit, or an AltGr character typed in
  // READY mode (typesAltGrCharacterIntoACell). The tolerant tiers below never
  // read a typed Ctrl+Alt character as a shortcut; only an exact binding may.
  const typing = editing || typesAltGrCharacterIntoACell(event);

  // Find matching keybindings: EXACT matches first; only when none survives
  // the rules below, the layout-tolerant match of a SYMBOL combination
  // (matchesEventOnLayout -- sv-SE types Alt+; as Alt+Shift+comma and Ctrl+]
  // as Ctrl+AltGr+9); and only when THAT finds none, the physical-key match of
  // a LETTER or DIGIT combination (matchesEventOnPhysicalKey -- sv-SE types
  // Ctrl+Alt+M as Ctrl+AltGr+M, the micro sign). Exact-first, so a binding that
  // names the keystroke's modifiers exactly always beats one that merely
  // produces its character, and the character typed beats the key it sits on.
  // AltGr is read into a Ctrl+Alt keystroke only when it is not TYPING -- and
  // in ready mode an AltGr character IS typing (W17, the owner's decision).
  const collect = (matchesCombo: (combo: string) => boolean): KeyBinding[] => {
    const matches: KeyBinding[] = [];
    registry.forEach((binding) => {
      const effectiveCombo = getEffectiveCombo(binding.id);
      if (!matchesCombo(effectiveCombo)) return;

      const ctx = binding.context ?? "always";
      if (ctx === "editing" && !editing) return;
      if (ctx === "not-editing" && editing) return;

      // A binding may declare WHEN it applies (see `registerKeybinding`). Asked
      // here, before `matches` is populated, so a guarded binding that says no
      // neither shadows the binding underneath it nor causes a preventDefault.
      if (!bindingApplies(binding.id)) return;

      // Skip grid-scoped commands when focus is outside the grid
      // (e.g., in dialogs, side panes, menus) so native browser
      // shortcuts like Ctrl+C to copy text work as expected.
      if (!gridFocused && GRID_SCOPED_COMMANDS.has(binding.commandId)) {
        console.debug(
          `[Keybindings] Skipping grid-scoped command '${binding.commandId}' ` +
          `— focus is outside grid (active: ${document.activeElement?.tagName})`
        );
        return;
      }

      // Even with the grid focused, defer copy/cut to the browser when the user
      // has selected real DOM text (toast, dialog, panel) — otherwise Ctrl+C would
      // copy the active cell instead of the highlighted text.
      if (
        (binding.commandId === "core.clipboard.copy" || binding.commandId === "core.clipboard.cut") &&
        hasDomTextSelection()
      ) {
        return;
      }

      matches.push(binding);
    });
    return matches;
  };
  let matches = collect((combo) => matchesEvent(combo, event));
  if (matches.length === 0) {
    matches = collect((combo) => matchesEventOnLayout(combo, event, { altGr: !typing }));
  }
  if (matches.length === 0) {
    matches = collect((combo) => matchesEventOnPhysicalKey(combo, event, { typing }));
  }

  if (matches.length === 0) return false;

  // THE APP ALWAYS WINS. A script shortcut is refused at registration if the
  // combination is already taken, so a tie can only happen when something the
  // app owns claimed the keys AFTERWARDS (a late-loading extension, a user
  // remap). Leaving that to registration order is how a sandboxed contribution
  // came to shadow a built-in once already; here it is a rule, not an accident.
  // Otherwise: first registered wins — EXCEPT that a binding which declared a
  // `when` and passed it is the more specific claim and beats an unguarded one.
  // Registration order cannot express "only while my subject is selected", and
  // the built-ins are always registered first, so without this rule the
  // specific claim could never be heard at all.
  const winner =
    matches.find((b) => b.source !== "script" && bindingGuards.has(b.id)) ??
    matches.find((b) => b.source !== "script") ??
    matches[0];

  event.preventDefault();
  event.stopPropagation();
  // An EXCLUSIVE winner also silences the other listeners on `window`'s
  // capture phase (see KeyBinding.exclusive): stopPropagation alone never
  // reaches a listener on the same target and phase.
  if (winner.exclusive === true && winner.source !== "script") event.stopImmediatePropagation();

  // A REFUSED command (see "Command refusals"): asked by command id, so it
  // follows the user's remaps. The key is taken and no other listener hears
  // it -- an extension's own listener for it would run the refused action.
  if (winner.source !== "script") {
    const refusal = commandRefusalFor(winner.commandId);
    if (refusal !== null) {
      event.stopImmediatePropagation();
      try {
        showToast(refusal, { variant: "info" });
      } catch {
        console.warn(`[Keybindings] ${refusal}`);
      }
      return true;
    }
  }

  if (winner.source === "script") {
    const run = scriptRunners.get(winner.id);
    if (run) {
      // The ONLY thing that crosses to the script: the combination it bound.
      // No DOM event, no key, no target, no repeat flag — a bound shortcut must
      // not become a way to observe the keyboard.
      try {
        run(winner.combo);
      } catch (err) {
        console.error(`[Keybindings] Error running script shortcut '${winner.id}':`, err);
      }
    }
    return true;
  }

  CommandRegistry.execute(winner.commandId).catch((err) => {
    console.error(`[Keybindings] Error executing command '${winner.commandId}':`, err);
  });

  return true;
}

function installListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;

  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      handleGlobalKeyDown(event);
    },
    { capture: true }
  );
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the keybinding system: load user overrides and register defaults.
 * Called once at app startup from the shell.
 */
export function initKeybindings(): void {
  loadUserOverrides();

  // Register all default keybindings
  for (const binding of DEFAULT_KEYBINDINGS) {
    registry.set(binding.id, binding);
  }

  // Load user-created custom keybindings
  loadCustomBindings();

  installListener();
  const customCount = getAllKeybindings().filter((b) => b.source === "user").length;
  console.log(`[Keybindings] Initialized with ${DEFAULT_KEYBINDINGS.length} built-in + ${customCount} custom keybindings`);
}
