//! FILENAME: app/extensions/Charts/lib/__tests__/schemaValidate.ts
// PURPOSE: Re-export of the production JSON-Schema checker for the test suites
//          (schema drift guard, example-corpus validity, snippet validity).
// CONTEXT: The checker moved to ../jsonSchemaCheck.ts so the runtime chart-write
//          gate (B8) and the tests share ONE implementation. Kept as a thin
//          re-export so existing `from "./schemaValidate"` imports keep working.

export { schemaViolations, collectRefs } from "../jsonSchemaCheck";
