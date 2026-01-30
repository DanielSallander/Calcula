//! FILENAME: app/src/api/filesystem.ts
// PURPOSE: Filesystem operations API for extensions.
// CONTEXT: Extensions call these functions instead of importing core/lib/file-api directly.
// This ensures extensions only depend on the API facade, not Core internals.

export {
  newFile,
  openFile,
  saveFile,
  saveFileAs,
  isFileModified,
  markFileModified,
  getCurrentFilePath,
} from "../core/lib/file-api";
