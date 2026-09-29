//! FILENAME: app/extensions/BuiltIn/StandardMenus/StandardMenus.tsx
// PURPOSE: React component that activates hook-based menus and registers them
//          with the Menu Registry so the MenuBar can render them.
// CONTEXT: Must be rendered inside the React tree (e.g., in Layout.tsx).

import { useEffect } from 'react';
import { registerMenu, unregisterMenu } from '@api/ui';
import { useFileMenu } from './FileMenu';
import { useViewMenu } from './ViewMenu';
import { useInsertMenu } from './InsertMenu';

/**
 * Invisible component that activates hook-based standard menus
 * and keeps them registered/up-to-date in the Menu Registry.
 */
export function StandardMenus(): null {
  const { menu: fileMenu } = useFileMenu();
  const { menu: viewMenu } = useViewMenu();
  const { menu: insertMenu } = useInsertMenu();

  // Register/update menus whenever the hook output changes
  useEffect(() => { registerMenu(fileMenu); }, [fileMenu]);
  useEffect(() => { registerMenu(viewMenu); }, [viewMenu]);
  useEffect(() => { registerMenu(insertMenu); }, [insertMenu]);

  // ...and take them away when this component leaves the shell frame (the
  // extension's deactivate unregisters it): these menus are this component's,
  // and without it they would outlive the extension (W20). Items other
  // extensions added to them are kept by the registry and return with them.
  const fileId = fileMenu.id;
  const viewId = viewMenu.id;
  const insertId = insertMenu.id;
  useEffect(() => () => {
    for (const id of [fileId, viewId, insertId]) unregisterMenu(id);
  }, [fileId, viewId, insertId]);

  return null;
}
