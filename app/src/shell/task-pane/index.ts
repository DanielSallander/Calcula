//! FILENAME: app/src/shell/task-pane/index.ts
// PURPOSE: Barrel exports for Task Pane module

export { TaskPaneContainer } from "./TaskPaneContainer";
export { TaskPaneHeader } from "./TaskPaneHeader";
export {
  useTaskPaneStore,
  useTaskPaneIsOpen,
  useTaskPaneWidth,
  useTaskPaneActiveViewId,
  useTaskPaneOpenPanes,
} from "./useTaskPaneStore";
export type { TaskPaneState, TaskPaneActions, OpenPaneInstance } from "./useTaskPaneStore";