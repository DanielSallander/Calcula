//! FILENAME: app/src/core/lib/fillLists.ts
// PURPOSE: Registry for custom auto-fill lists (built-in and user-defined).
// CONTEXT: Used by useFillHandle to detect cyclic list patterns during drag-to-fill.
//          Built-in lists include weekdays and months in full/short variants.
//          User-defined lists are persisted to localStorage.

// ============================================================================
// Types
// ============================================================================

export interface FillList {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** The ordered list items (case-sensitive canonical form) */
  items: string[];
  /** Whether this is a built-in list (cannot be deleted/edited) */
  builtIn: boolean;
}

/** Result from matching a set of values against all registered lists. */
export interface FillListMatch {
  /** The matched list */
  list: FillList;
  /** Index of the first value in the list */
  startIndex: number;
  /** Step between consecutive values (for multi-value selections) */
  step: number;
}

// ============================================================================
// Built-in Lists
// ============================================================================

const BUILTIN_LISTS: FillList[] = [
  {
    id: "builtin.weekday.short",
    name: "Weekdays (Short)",
    items: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    builtIn: true,
  },
  {
    id: "builtin.weekday.full",
    name: "Weekdays (Full)",
    items: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    builtIn: true,
  },
  {
    id: "builtin.month.short",
    name: "Months (Short)",
    items: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    builtIn: true,
  },
  {
    id: "builtin.month.full",
    name: "Months (Full)",
    items: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    builtIn: true,
  },
];

// ============================================================================
// Storage Key
// ============================================================================

const STORAGE_KEY = "calcula.customFillLists";

// ============================================================================
// Fill List Registry (Singleton)
// ============================================================================

class FillListRegistryImpl {
  private userLists: FillList[] = [];
  private subscribers: Set<() => void> = new Set();
  private loaded = false;

  /** Load user-defined lists from localStorage. */
  load(): void {
    if (this.loaded) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.userLists = parsed.map((item: FillList, idx: number) => ({
            id: item.id || `user.${idx}`,
            name: item.name || `Custom List ${idx + 1}`,
            items: Array.isArray(item.items) ? item.items : [],
            builtIn: false,
          }));
        }
      }
    } catch (err) {
      console.warn("[FillLists] Failed to load from localStorage:", err);
    }
    this.loaded = true;
  }

  /** Persist user-defined lists to localStorage. */
  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.userLists));
    } catch (err) {
      console.warn("[FillLists] Failed to save to localStorage:", err);
    }
  }

  /** Get all lists (built-in first, then user-defined). */
  getAllLists(): FillList[] {
    this.load();
    return [...BUILTIN_LISTS, ...this.userLists];
  }

  /** Get only built-in lists. */
  getBuiltInLists(): FillList[] {
    return [...BUILTIN_LISTS];
  }

  /** Get only user-defined lists. */
  getUserLists(): FillList[] {
    this.load();
    return [...this.userLists];
  }

  /** Add a new user-defined list. Returns the created list. */
  addList(name: string, items: string[]): FillList {
    this.load();
    const id = `user.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const list: FillList = { id, name, items: [...items], builtIn: false };
    this.userLists.push(list);
    this.save();
    this.notify();
    return list;
  }

  /** Update an existing user-defined list. Returns true if found. */
  updateList(id: string, name: string, items: string[]): boolean {
    this.load();
    const list = this.userLists.find((l) => l.id === id);
    if (!list) return false;
    list.name = name;
    list.items = [...items];
    this.save();
    this.notify();
    return true;
  }

  /** Remove a user-defined list. Returns true if found and removed. */
  removeList(id: string): boolean {
    this.load();
    const idx = this.userLists.findIndex((l) => l.id === id);
    if (idx < 0) return false;
    this.userLists.splice(idx, 1);
    this.save();
    this.notify();
    return true;
  }

  /**
   * Try to match an array of values against all registered fill lists.
   * Returns the best match (user-defined lists are checked first for priority),
   * or null if no match is found.
   *
   * Matching is case-insensitive.
   */
  matchValues(values: string[]): FillListMatch | null {
    if (values.length === 0) return null;
    this.load();

    // Check user lists first (higher priority), then built-in
    const allLists = [...this.userLists, ...BUILTIN_LISTS];

    for (const list of allLists) {
      const match = this.tryMatchList(values, list);
      if (match) return match;
    }

    return null;
  }

  /**
   * Try to match values against a single list.
   */
  private tryMatchList(values: string[], list: FillList): FillListMatch | null {
    if (list.items.length === 0) return null;

    // Build lowercase lookup
    const lowerItems = list.items.map((item) => item.toLowerCase());

    // Find the first value in the list
    const firstLower = values[0].trim().toLowerCase();
    const startIndex = lowerItems.indexOf(firstLower);
    if (startIndex < 0) return null;

    if (values.length === 1) {
      // Single value match: step = 1
      return { list, startIndex, step: 1 };
    }

    // Multi-value: find all indices and check for consistent step
    const indices: number[] = [startIndex];
    for (let i = 1; i < values.length; i++) {
      const lower = values[i].trim().toLowerCase();
      const idx = lowerItems.indexOf(lower);
      if (idx < 0) return null;
      indices.push(idx);
    }

    // Check for consistent step (with wrapping)
    const len = list.items.length;
    const steps: number[] = [];
    for (let i = 1; i < indices.length; i++) {
      let diff = indices[i] - indices[i - 1];
      if (diff <= 0) diff += len; // wrap around
      steps.push(diff);
    }

    if (steps.length > 0 && steps.every((s) => s === steps[0])) {
      return { list, startIndex: indices[0], step: steps[0] };
    }

    return null;
  }

  /**
   * Generate the next value in a matched list at the given offset.
   * @param match The match result from matchValues
   * @param lastIndex The index of the last source value in the list
   * @param offset How many steps beyond the last source value (1-based)
   */
  generateValue(match: FillListMatch, lastIndex: number, offset: number): string {
    const len = match.list.items.length;
    const newIdx = ((lastIndex + match.step * offset) % len + len) % len;
    return match.list.items[newIdx];
  }

  /** Subscribe to changes. Returns unsubscribe function. */
  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      try {
        cb();
      } catch (err) {
        console.error("[FillLists] Subscriber error:", err);
      }
    }
  }

  /** Reset for testing. */
  _reset(): void {
    this.userLists = [];
    this.loaded = false;
    this.subscribers.clear();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore in test environments
    }
  }
}

/** Global fill list registry singleton. */
export const FillListRegistry = new FillListRegistryImpl();
