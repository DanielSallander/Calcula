//! FILENAME: app/extensions/BusinessIntelligence/types.ts
// PURPOSE: TypeScript interfaces mirroring Rust BI types (via serde camelCase).

export type {
  ConnectionInfo,
  CreateConnectionRequest,
  UpdateConnectionRequest,
  BiModelInfo,
  BiTableInfo,
  BiColumnInfo,
  BiMeasureInfo,
  BiRelationshipInfo,
  BiSecurityRoleInfo,
  BiFilterPredicateInfo,
  BiQueryRequest,
  BiColumnRef,
  BiFilter,
  BiQueryResult,
  BiInsertRequest,
  BiInsertResponse,
  BiRegionInfo,
  BiConnectRequest,
  BiBindRequest,
} from "@api/backend";
