// FILENAME: app/extensions/ModelEditor/cli/gateway.ts
// PURPOSE: The CLI's edit/read surface as an injectable interface — the SAME
//          typed @api gateway the visual editor uses (so every CLI command is
//          exactly as trusted and as undoable as a button click), made
//          mockable for executor tests.

import {
  biModelBatchBegin,
  biModelBatchCancel,
  biModelBatchEnd,
  biModelConnectSource,
  biModelDeleteCalcColumn,
  biModelDeleteCalcGroup,
  biModelDeleteContext,
  biModelDeleteContextColumn,
  biModelDeleteCulture,
  biModelDeleteGlobalVariable,
  biModelDeleteHierarchy,
  biModelDeleteKpi,
  biModelDeleteMeasure,
  biModelDeletePerspective,
  biModelDeleteRelationship,
  biModelDeleteRole,
  biModelDeleteScriptFunction,
  biModelDeleteSource,
  biModelDeleteTable,
  biModelDeleteTableVariable,
  biModelDeleteWritebackColumn,
  biModelExtensionDataDelete,
  biModelExtensionDataGet,
  biModelExtensionDataList,
  biModelExtensionDataSet,
  biModelGetOverview,
  biModelImportSqlSource,
  biModelImportTables,
  biModelListSourceTables,
  biModelMaterializeCalculatedTable,
  biModelRedo,
  biModelRefreshTable,
  biModelSetDateTable,
  biModelSetDefaultLookupResolution,
  biModelSetMetadata,
  biModelSetTableRefresh,
  biModelSetTableSourceBinding,
  biModelSetTableStorageMode,
  biModelUndo,
  biModelUpdateColumn,
  biModelUpdateTable,
  biModelUpsertCalcGroup,
  biModelUpsertContext,
  biModelUpsertCulture,
  biModelUpsertGlobalVariable,
  biModelUpsertHierarchy,
  biModelUpsertKpi,
  biModelUpsertMeasure,
  biModelUpsertModelColumn,
  biModelUpsertPerspective,
  biModelUpsertRelationship,
  biModelUpsertRole,
  biModelUpsertScriptFunction,
  biModelUpsertSource,
  biModelUpsertTableVariable,
  biModelUpsertWritebackColumn,
  biModelValidate,
} from "@api";
import type { ModelMeasureInfo, ModelOverview } from "@api";

type Params<F> = F extends (params: infer P) => unknown ? P : never;

/** Every backend call the executor makes. Method shapes mirror the @api
 *  wrappers 1:1 so the live gateway is pure delegation. */
export interface CliGateway {
  // batching
  batchBegin(connectionId: string): Promise<void>;
  batchEnd(connectionId: string, hadEdits: boolean): Promise<void>;
  batchCancel(connectionId: string): Promise<ModelOverview>;
  // reads
  getOverview(connectionId: string): Promise<ModelOverview>;
  listSourceTables: typeof biModelListSourceTables;
  validate: typeof biModelValidate;
  extensionDataGet: typeof biModelExtensionDataGet;
  extensionDataList: typeof biModelExtensionDataList;
  // undo/redo
  undo(connectionId: string): Promise<ModelOverview>;
  redo(connectionId: string): Promise<ModelOverview>;
  // measures
  upsertMeasure(p: Params<typeof biModelUpsertMeasure>): Promise<ModelMeasureInfo[]>;
  deleteMeasure(connectionId: string, name: string): Promise<ModelMeasureInfo[]>;
  // tables + columns
  updateTable: typeof biModelUpdateTable;
  deleteTable: typeof biModelDeleteTable;
  setTableStorageMode: typeof biModelSetTableStorageMode;
  setTableSourceBinding: typeof biModelSetTableSourceBinding;
  setTableRefresh: typeof biModelSetTableRefresh;
  refreshTable: typeof biModelRefreshTable;
  updateColumn: typeof biModelUpdateColumn;
  upsertModelColumn: typeof biModelUpsertModelColumn;
  deleteCalcColumn: typeof biModelDeleteCalcColumn;
  deleteContextColumn: typeof biModelDeleteContextColumn;
  // relationships
  upsertRelationship: typeof biModelUpsertRelationship;
  deleteRelationship: typeof biModelDeleteRelationship;
  // hierarchies / KPIs / roles / perspectives / cultures
  upsertHierarchy: typeof biModelUpsertHierarchy;
  deleteHierarchy: typeof biModelDeleteHierarchy;
  upsertKpi: typeof biModelUpsertKpi;
  deleteKpi: typeof biModelDeleteKpi;
  upsertRole: typeof biModelUpsertRole;
  deleteRole: typeof biModelDeleteRole;
  upsertPerspective: typeof biModelUpsertPerspective;
  deletePerspective: typeof biModelDeletePerspective;
  upsertCulture: typeof biModelUpsertCulture;
  deleteCulture: typeof biModelDeleteCulture;
  // calc groups / calculated tables / table variables / script functions
  upsertCalcGroup: typeof biModelUpsertCalcGroup;
  deleteCalcGroup: typeof biModelDeleteCalcGroup;
  upsertGlobalVariable: typeof biModelUpsertGlobalVariable;
  deleteGlobalVariable: typeof biModelDeleteGlobalVariable;
  materializeCalculatedTable: typeof biModelMaterializeCalculatedTable;
  upsertTableVariable: typeof biModelUpsertTableVariable;
  deleteTableVariable: typeof biModelDeleteTableVariable;
  upsertScriptFunction: typeof biModelUpsertScriptFunction;
  deleteScriptFunction: typeof biModelDeleteScriptFunction;
  // contexts
  upsertContext: typeof biModelUpsertContext;
  deleteContext: typeof biModelDeleteContext;
  // writeback columns
  upsertWritebackColumn: typeof biModelUpsertWritebackColumn;
  deleteWritebackColumn: typeof biModelDeleteWritebackColumn;
  // sources / import
  upsertSource: typeof biModelUpsertSource;
  deleteSource: typeof biModelDeleteSource;
  connectSource: typeof biModelConnectSource;
  importTables: typeof biModelImportTables;
  importSqlSource: typeof biModelImportSqlSource;
  // model settings
  setMetadata: typeof biModelSetMetadata;
  setDateTable: typeof biModelSetDateTable;
  setDefaultLookupResolution: typeof biModelSetDefaultLookupResolution;
  // extension data
  extensionDataSet: typeof biModelExtensionDataSet;
  extensionDataDelete: typeof biModelExtensionDataDelete;
}

/** The production gateway: pure delegation to the @api wrappers. */
export function createLiveGateway(): CliGateway {
  return {
    batchBegin: biModelBatchBegin,
    batchEnd: biModelBatchEnd,
    batchCancel: biModelBatchCancel,
    getOverview: biModelGetOverview,
    listSourceTables: biModelListSourceTables,
    validate: biModelValidate,
    extensionDataGet: biModelExtensionDataGet,
    extensionDataList: biModelExtensionDataList,
    undo: biModelUndo,
    redo: biModelRedo,
    upsertMeasure: biModelUpsertMeasure,
    deleteMeasure: biModelDeleteMeasure,
    updateTable: biModelUpdateTable,
    deleteTable: biModelDeleteTable,
    setTableStorageMode: biModelSetTableStorageMode,
    setTableSourceBinding: biModelSetTableSourceBinding,
    setTableRefresh: biModelSetTableRefresh,
    refreshTable: biModelRefreshTable,
    updateColumn: biModelUpdateColumn,
    upsertModelColumn: biModelUpsertModelColumn,
    deleteCalcColumn: biModelDeleteCalcColumn,
    deleteContextColumn: biModelDeleteContextColumn,
    upsertRelationship: biModelUpsertRelationship,
    deleteRelationship: biModelDeleteRelationship,
    upsertHierarchy: biModelUpsertHierarchy,
    deleteHierarchy: biModelDeleteHierarchy,
    upsertKpi: biModelUpsertKpi,
    deleteKpi: biModelDeleteKpi,
    upsertRole: biModelUpsertRole,
    deleteRole: biModelDeleteRole,
    upsertPerspective: biModelUpsertPerspective,
    deletePerspective: biModelDeletePerspective,
    upsertCulture: biModelUpsertCulture,
    deleteCulture: biModelDeleteCulture,
    upsertCalcGroup: biModelUpsertCalcGroup,
    deleteCalcGroup: biModelDeleteCalcGroup,
    upsertGlobalVariable: biModelUpsertGlobalVariable,
    deleteGlobalVariable: biModelDeleteGlobalVariable,
    materializeCalculatedTable: biModelMaterializeCalculatedTable,
    upsertTableVariable: biModelUpsertTableVariable,
    deleteTableVariable: biModelDeleteTableVariable,
    upsertScriptFunction: biModelUpsertScriptFunction,
    deleteScriptFunction: biModelDeleteScriptFunction,
    upsertContext: biModelUpsertContext,
    deleteContext: biModelDeleteContext,
    upsertWritebackColumn: biModelUpsertWritebackColumn,
    deleteWritebackColumn: biModelDeleteWritebackColumn,
    upsertSource: biModelUpsertSource,
    deleteSource: biModelDeleteSource,
    connectSource: biModelConnectSource,
    importTables: biModelImportTables,
    importSqlSource: biModelImportSqlSource,
    setMetadata: biModelSetMetadata,
    setDateTable: biModelSetDateTable,
    setDefaultLookupResolution: biModelSetDefaultLookupResolution,
    extensionDataSet: biModelExtensionDataSet,
    extensionDataDelete: biModelExtensionDataDelete,
  };
}
