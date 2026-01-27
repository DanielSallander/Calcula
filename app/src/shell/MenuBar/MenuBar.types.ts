//! FILENAME: app/src/shell/MenuBar/MenuBar.types.ts
export interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
  checked?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

export interface MenuHookDependencies {
  selection: {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
  } | null;
  dispatch: React.Dispatch<unknown>;
}