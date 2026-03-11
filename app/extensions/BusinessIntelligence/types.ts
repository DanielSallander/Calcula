//! FILENAME: app/extensions/BusinessIntelligence/types.ts
// PURPOSE: TypeScript interfaces mirroring Rust BI types (via serde camelCase).

export type {
  BiModelInfo,
  BiTableInfo,
  BiColumnInfo,
  BiMeasureInfo,
  BiRelationshipInfo,
  BiQueryRequest,
  BiColumnRef,
  BiFilter,
  BiQueryResult,
  BiInsertRequest,
  BiInsertResponse,
  BiRegionInfo,
  BiConnectRequest,
  BiBindRequest,
} from "../../src/api/backend";
