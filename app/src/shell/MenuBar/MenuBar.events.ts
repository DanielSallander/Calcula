export const MenuEvents = {
  CUT: 'menu:cut',
  COPY: 'menu:copy',
  PASTE: 'menu:paste',
  FIND: 'menu:find',
  REPLACE: 'menu:replace',
  FREEZE_CHANGED: 'menu:freezeChanged',
  CELLS_MERGED: 'menu:cellsMerged',
  CELLS_UNMERGED: 'menu:cellsUnmerged',
  PIVOT_CREATED: 'menu:pivotCreated',
} as const;

export function emitMenuEvent(eventName: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

export function restoreFocusToGrid(): void {
  setTimeout(() => {
    const focusContainer = document.querySelector('[tabindex="0"][style*="outline: none"]') as HTMLElement;
    if (focusContainer) {
      focusContainer.focus();
    }
  }, 0);
}