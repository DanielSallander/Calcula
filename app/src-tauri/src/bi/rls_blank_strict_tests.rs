//! FILENAME: app/src-tauri/src/bi/rls_blank_strict_tests.rs
//! PURPOSE: Row-level security stays STRICT on BLANK in a BI pivot, end to end
//!          through the app (owner decision BUG-0759, 2026-11-06).
//!
//! A connection's "view as" role (`Connection.active_role`, applied on every
//! query by `apply_connection_role`) filters `Sales[tenant] = 0`, `<> 5`,
//! `< 1` or `Sales[code] = ""`. The rows whose filtered column is BLANK never
//! show, in the pivot's grid or its grand total: a deliberate, documented
//! difference from Power BI, whose DAX role filter would read BLANK as 0 / ""
//! and show them. The engine pins the same on its own routes
//! (`bi-engine`'s `rls_blank_strict_tests`); this pins the app's pivot path.
//!
//! Fixture (tenant, code, amount): (0, a, 1) (BLANK, BLANK, 10) (5, "", 100)
//! (2, b, 1000).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arrow::array::{Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bi_engine::{
    sum_measure, Column, ComparisonOp, DataModel, DataType, Engine, InMemoryConnector, QueryRequest,
    SecurityRole, SourceBinding, StorageMode, Table,
};
use tokio::sync::Mutex as TokioMutex;

use crate::bi::types::{BiState, Connection, ConnectionId, ConnectionType};
use crate::document_effect::test_seed_effect;
use crate::pivot::commands::{extract_bi_model_metadata, update_bi_pivot_fields_core, PivotCmdCtx};
use crate::pivot::types::{BiFieldRef, BiPivotMetadata, BiValueFieldRef, PivotState, UpdateBiPivotFieldsRequest};

/// (role, column, operator, value, the grand total strict RLS shows, Power
/// BI's answer for the record).
const ROLES: &[(&str, &str, ComparisonOp, &str, f64, f64)] = &[
    ("TenantZero", "tenant", ComparisonOp::Equal, "0", 1.0, 11.0),
    ("NotFive", "tenant", ComparisonOp::NotEqual, "5", 1001.0, 1011.0),
    ("BelowOne", "tenant", ComparisonOp::LessThan, "1", 1.0, 11.0),
    ("EmptyCode", "code", ComparisonOp::Equal, "", 100.0, 110.0),
];

fn new_id() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

fn model() -> DataModel {
    let mut builder = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("tenant", DataType::Int64),
                    Column::new("code", DataType::String),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"));
    for (role, column, op, value, _, _) in ROLES {
        builder = builder.add_security_role(SecurityRole::new(*role).with_filter("Sales", *column, *op, *value));
    }
    builder.build().unwrap()
}

fn sales() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("tenant", ArrowType::Int64, true),
            Field::new("code", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![Some(0), None, Some(5), Some(2)])),
            Arc::new(StringArray::from(vec![Some("a"), None, Some(""), Some("b")])),
            Arc::new(Float64Array::from(vec![1.0, 10.0, 100.0, 1000.0])),
        ],
    )
    .unwrap()
}

struct Fx {
    state: crate::AppState,
    file: crate::persistence::FileState,
    files: crate::persistence::UserFilesState,
    slicer: crate::slicer::SlicerState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
    bi: BiState,
    conn: ConnectionId,
}

impl Fx {
    async fn new(role: &str) -> Fx {
        let mut engine = Engine::new(model());
        let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", sales()));
        engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
        let _ = engine
            .query_auto_refresh(QueryRequest {
                measures: vec!["Revenue".into()],
                group_by: vec![bi_engine::ColumnRef::new("Sales", "code")],
                ..Default::default()
            })
            .await;
        let conn = new_id();
        let connection = Connection {
            id: conn,
            name: "Sales".into(),
            description: String::new(),
            connection_type: ConnectionType::PostgreSQL,
            connection_string: String::new(),
            server: String::new(),
            database: String::new(),
            preferred_auth: "Integrated".into(),
            model_path: None,
            engine: Some(Arc::new(TokioMutex::new(engine))),
            model_key: None,
            connector_index: Some(idx),
            bindings: vec![],
            last_refreshed: None,
            created_at: String::new(),
            is_connected: true,
            active_queries: HashMap::new(),
            package_data_source_id: None,
            active_role: Some(role.to_string()),
            base_model: None,
            calculated_measures: vec![],
        };
        let bi = BiState::new();
        bi.connections.lock().unwrap().insert(conn, connection);
        Fx {
            state: crate::create_app_state(),
            file: crate::persistence::FileState::default(),
            files: crate::persistence::UserFilesState::default(),
            slicer: crate::slicer::SlicerState::new(),
            pivots: PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            bi,
            conn,
        }
    }

    fn ctx(&self) -> PivotCmdCtx<'_> {
        PivotCmdCtx {
            state: &self.state,
            file_state: &self.file,
            pivot_state: &self.pivots,
            pane_control_state: &self.pane,
            ribbon_filter_state: &self.filters,
            user_files_state: &self.files,
            bi_state: &self.bi,
            slicer_state: &self.slicer,
            record_undo: true,
        }
    }

    /// A BI pivot of Revenue by `rows` (a Sales column), rendered.
    async fn pivot(&self, rows: &str) -> identity::EntityId {
        let engine_arc = self.bi.connections.lock().unwrap()[&self.conn].engine.clone().unwrap();
        let (model_tables, measures, hierarchies, calculation_groups, perspectives, cultures) = {
            let engine = engine_arc.lock().await;
            extract_bi_model_metadata(&engine)
        };
        let meta = BiPivotMetadata {
            connection_id: self.conn,
            data_source_id: Some(self.conn.to_string()),
            model_tables,
            measures,
            hierarchies,
            calculation_groups,
            data_as_of: None,
            last_query: None,
            lookup_columns: HashSet::new(),
            drill_through: None,
            perspectives,
            selected_perspective: None,
            cultures,
        };
        let id = new_id();
        let sheet_name = self.state.sheet_names.read().unwrap()[0].clone();
        let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
        def.destination_sheet = Some(sheet_name);
        def.name = Some(format!("Pivot{}", id));
        let seed = test_seed_effect();
        self.pivots.pivot_tables.write(&seed).unwrap().insert(id, (def, pivot_engine::PivotCache::new(id, 0)));
        self.pivots.bi_metadata.write(&seed).unwrap().insert(id, meta);
        let request = UpdateBiPivotFieldsRequest {
            pivot_id: id,
            row_fields: vec![BiFieldRef { table: "Sales".into(), column: rows.into(), is_lookup: false, hidden_items: None }],
            column_fields: vec![],
            value_fields: vec![BiValueFieldRef { measure_name: "Revenue".into(), custom_name: None, number_format: None }],
            filter_fields: vec![],
            slicer_fields: None,
            row_hierarchies: vec![],
            column_hierarchies: vec![],
            layout: None,
            lookup_columns: vec![],
            calculated_fields: None,
            value_column_order: None,
            force_requery: false,
        };
        update_bi_pivot_fields_core(&self.ctx(), request).await.expect("lay the pivot out");
        id
    }

    /// The grand total and the data rows' sum the last render showed.
    fn shown(&self, pivot: identity::EntityId) -> (Option<f64>, f64, Vec<String>) {
        let views = self.pivots.views.lock().unwrap();
        let view = views.get(&pivot).expect("the pivot was rendered");
        let number = |row: usize| {
            view.cells[row].iter().find_map(|c| match (c.value_field_index, &c.value) {
                (Some(0), pivot_engine::PivotCellValue::Number(n)) => Some(*n),
                _ => None,
            })
        };
        let mut data_sum = 0.0;
        let mut labels = Vec::new();
        let mut grand = None;
        for d in &view.rows {
            match d.row_type {
                pivot_engine::PivotRowType::Data => {
                    data_sum += number(d.view_row).unwrap_or(0.0);
                    labels.push(view.cells[d.view_row][0].formatted_value.clone());
                }
                pivot_engine::PivotRowType::GrandTotal => grand = number(d.view_row),
                _ => {}
            }
        }
        (grand, data_sum, labels)
    }
}

/// Under each role the pivot (by Sales[code], whose BLANK member would be a
/// "(Blank)" row) shows the strict total: the BLANK-keyed rows never count.
#[tokio::test]
async fn a_bi_pivot_under_a_role_never_shows_a_blank_row() {
    for (role, _, _, _, strict, power_bi) in ROLES {
        let fx = Fx::new(role).await;
        let pivot = fx.pivot("code").await;
        let (grand, data_sum, labels) = fx.shown(pivot);
        assert_eq!(
            grand,
            Some(*strict),
            "{role}: the grand total (Power BI would show {power_bi}; RLS stays strict, BUG-0759); rows {labels:?}"
        );
        assert_eq!(data_sum, *strict, "{role}: the data rows; rows {labels:?}");
    }
}
