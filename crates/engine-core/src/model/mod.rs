//! Data model definitions: tables, columns, relationships, and the overall schema.

pub mod calculated_column;
pub mod calculation_group;
pub mod column;
pub mod context;
pub mod global_variable;
pub mod hierarchy;
pub mod kpi;
pub mod relationship;
pub mod schema;
pub mod security_role;
pub mod table;
pub mod table_variable;

pub use calculated_column::CalculatedColumn;
pub use calculation_group::{
    expand_calculation_group, synthetic_measure_name, CalculationGroup, CalculationItem,
};
pub use column::{Column, DateRole};
pub use context::{ClearTarget, ContextDefinition, ContextOp};
pub use global_variable::GlobalVariable;
pub use hierarchy::{Hierarchy, HierarchyLevel, RaggedBehavior};
pub use kpi::{Kpi, KpiStatus, KpiTarget, StatusBand};
pub use relationship::{Cardinality, FilterPropagation, JoinCondition, JoinOperator, Relationship};
pub use schema::{DataModel, DataModelBuilder};
pub use security_role::SecurityRole;
pub use table::{IncrementalRefresh, RefreshStrategy, StorageMode, Table};
pub use table_variable::TableVariable;
