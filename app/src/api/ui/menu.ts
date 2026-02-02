//! FILENAME: app/src/api/ui/menu.ts
export interface MenuItem {
  id: string;
  label: string;
  commandId: string; // Links to the Command Registry
  icon?: string;
  shortcut?: string;
}

export interface MenuDefinition {
  id: string;     // e.g., "file", "edit"
  label: string;  // e.g., "File", "Edit"
  order: number;  // To control sort order (File=10, Edit=20)
  items: MenuItem[];
}

export interface IMenuRegistry {
  registerMenu(menu: MenuDefinition): void;
  registerMenuItem(menuId: string, item: MenuItem): void;
  getMenus(): MenuDefinition[];
}