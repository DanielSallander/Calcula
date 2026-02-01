//! FILENAME: app/src/core/registry/index.ts
// PURPOSE: DEPRECATED - Backward compatibility re-exports during migration.
// CONTEXT: Registries have been moved to shell/registries per microkernel architecture.
//          This file exists only for backward compatibility. New code should import
//          from shell/registries or api/extensions directly.
//
// TODO: Remove this file after all imports are updated to use shell/registries.

console.warn(
  "[DEPRECATED] Importing from core/registry is deprecated. " +
  "Use shell/registries or api/extensions instead."
);

// Re-export everything from shell/registries for backward compatibility
export * from "../../shell/registries";