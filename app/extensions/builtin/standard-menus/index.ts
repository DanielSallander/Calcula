//! FILENAME: app/extensions/builtin/standard-menus/index.ts
export { useFileMenu } from './FileMenu';
export type { FileMenuHandlers } from './FileMenu';

export { registerEditMenu } from './EditMenu';

export { useViewMenu } from './ViewMenu';
export type { ViewMenuHandlers, FreezeState } from './ViewMenu';

export { useInsertMenu } from './InsertMenu';
export type { InsertMenuHandlers } from './InsertMenu';
