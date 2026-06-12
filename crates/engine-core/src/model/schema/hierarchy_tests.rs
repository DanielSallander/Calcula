//! Hierarchy validation and serialization tests.

use super::test_fixtures::*;
use super::*;
use crate::model::column::Column;
use crate::model::hierarchy::Hierarchy;
use crate::types::DataType;

// --- Hierarchy tests ---

fn dim_geography_table() -> Table {
    Table::new(
        "dim_geography",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("country", DataType::String),
            Column::new("state", DataType::String),
            Column::new("city", DataType::String),
        ],
    )
    .unwrap()
}

fn geography_hierarchy() -> Hierarchy {
    use crate::model::hierarchy::HierarchyLevel;
    Hierarchy::new(
        "Geography",
        "dim_geography",
        vec![
            HierarchyLevel::new("country"),
            HierarchyLevel::new("state"),
            HierarchyLevel::new("city"),
        ],
    )
}

#[test]
fn hierarchy_added_to_model() {
    let model = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(geography_hierarchy())
        .build()
        .unwrap();

    assert_eq!(model.hierarchies().len(), 1);
    assert!(model.hierarchy("Geography").is_ok());
    assert!(model.hierarchy("Missing").is_err());
}

#[test]
fn hierarchies_for_table() {
    use crate::model::hierarchy::HierarchyLevel;

    let h2 = Hierarchy::new(
        "Region",
        "dim_geography",
        vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
    );

    let model = DataModel::builder()
        .add_table(dim_geography_table())
        .add_table(sales_table())
        .add_hierarchy(geography_hierarchy())
        .add_hierarchy(h2)
        .build()
        .unwrap();

    assert_eq!(model.hierarchies_for_table("dim_geography").len(), 2);
    assert!(model.hierarchies_for_table("Sales").is_empty());
}

#[test]
fn rejects_duplicate_hierarchy_names() {
    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(geography_hierarchy())
        .add_hierarchy(geography_hierarchy())
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Duplicate"));
    assert!(err.contains("Geography"));
}

#[test]
fn rejects_hierarchy_name_collision_with_table() {
    use crate::model::hierarchy::HierarchyLevel;

    let h = Hierarchy::new(
        "Sales",
        "dim_geography",
        vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
    );

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_table(sales_table())
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts with table"));
}

#[test]
fn rejects_hierarchy_name_collision_with_context() {
    use crate::model::context::{ContextDefinition, ContextOp};
    use crate::model::hierarchy::HierarchyLevel;

    let ctx = ContextDefinition::new("my_ctx", vec![ContextOp::Reset]);
    let h = Hierarchy::new(
        "my_ctx",
        "dim_geography",
        vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
    );

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_context(ctx)
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts with context"));
}

#[test]
fn rejects_hierarchy_name_collision_with_table_variable() {
    use crate::model::hierarchy::HierarchyLevel;

    let var = TableVariable::new("my_var", "dim_geography", vec![]);
    let h = Hierarchy::new(
        "my_var",
        "dim_geography",
        vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
    );

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_table_variable(var)
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts with table variable"));
}

#[test]
fn rejects_hierarchy_name_collision_with_global_variable() {
    use crate::compute::expression as expr;
    use crate::model::global_variable::GlobalVariable;
    use crate::model::hierarchy::HierarchyLevel;

    let gv = GlobalVariable::new("my_gv", "dim_geography", expr::col("country"));
    let h = Hierarchy::new(
        "my_gv",
        "dim_geography",
        vec![HierarchyLevel::new("country"), HierarchyLevel::new("state")],
    );

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_global_variable(gv)
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts with global variable"));
}

#[test]
fn rejects_hierarchy_on_missing_table() {
    use crate::model::hierarchy::HierarchyLevel;

    let h = Hierarchy::new(
        "H",
        "NonExistent",
        vec![HierarchyLevel::new("a"), HierarchyLevel::new("b")],
    );

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("NonExistent"));
}

#[test]
fn rejects_hierarchy_with_missing_column() {
    use crate::model::hierarchy::HierarchyLevel;

    let h = Hierarchy::new(
        "H",
        "dim_geography",
        vec![
            HierarchyLevel::new("country"),
            HierarchyLevel::new("nonexistent"),
        ],
    );

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("nonexistent"));
}

#[test]
fn rejects_hierarchy_with_fewer_than_two_levels() {
    use crate::model::hierarchy::HierarchyLevel;

    let h = Hierarchy::new("H", "dim_geography", vec![HierarchyLevel::new("country")]);

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("at least 2 levels"));
}

#[test]
fn rejects_hierarchy_with_duplicate_columns() {
    use crate::model::hierarchy::HierarchyLevel;

    let h = Hierarchy::new(
        "H",
        "dim_geography",
        vec![
            HierarchyLevel::new("country"),
            HierarchyLevel::new("country"),
        ],
    );

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("duplicate level column"));
}

#[test]
fn rejects_hierarchy_with_optional_first_level() {
    use crate::model::hierarchy::HierarchyLevel;

    let h = Hierarchy::new(
        "H",
        "dim_geography",
        vec![
            HierarchyLevel::new("country").with_optional(true),
            HierarchyLevel::new("state"),
        ],
    );

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("first level cannot be optional"));
}

#[test]
fn rejects_hierarchy_with_optional_last_level() {
    use crate::model::hierarchy::HierarchyLevel;

    let h = Hierarchy::new(
        "H",
        "dim_geography",
        vec![
            HierarchyLevel::new("country"),
            HierarchyLevel::new("city").with_optional(true),
        ],
    );

    let result = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("last level cannot be optional"));
}

#[test]
fn accepts_hierarchy_with_optional_middle_level() {
    use crate::model::hierarchy::{HierarchyLevel, RaggedBehavior};

    let h = Hierarchy::new(
        "Geography",
        "dim_geography",
        vec![
            HierarchyLevel::new("country"),
            HierarchyLevel::new("state").with_optional(true),
            HierarchyLevel::new("city"),
        ],
    )
    .with_ragged_behavior(RaggedBehavior::RepeatParent);

    let model = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build()
        .unwrap();

    assert_eq!(model.hierarchies().len(), 1);
    assert!(model.hierarchies()[0].levels()[1].is_optional());
}

#[test]
fn hierarchy_ragged_behavior_survives_build() {
    use crate::model::hierarchy::{HierarchyLevel, RaggedBehavior};

    let h = Hierarchy::new(
        "H",
        "dim_geography",
        vec![HierarchyLevel::new("country"), HierarchyLevel::new("city")],
    )
    .with_ragged_behavior(RaggedBehavior::HideMembers);

    let model = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build()
        .unwrap();

    assert_eq!(
        model.hierarchy("H").unwrap().ragged_behavior(),
        RaggedBehavior::HideMembers
    );
}

#[test]
fn accepts_hierarchy_with_stopper_value_on_optional_level() {
    use crate::model::hierarchy::HierarchyLevel;

    let h = Hierarchy::new(
        "Geography",
        "dim_geography",
        vec![
            HierarchyLevel::new("country"),
            HierarchyLevel::new("state")
                .with_optional(true)
                .with_stopper_value("#"),
            HierarchyLevel::new("city"),
        ],
    );

    let model = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build()
        .unwrap();

    assert_eq!(
        model.hierarchies()[0].levels()[1].stopper_value(),
        Some("#")
    );
}

#[test]
fn rejects_hierarchy_with_stopper_value_on_required_level() {
    use crate::model::hierarchy::HierarchyLevel;

    let h = Hierarchy::new(
        "Geography",
        "dim_geography",
        vec![
            HierarchyLevel::new("country").with_stopper_value("#"),
            HierarchyLevel::new("state"),
            HierarchyLevel::new("city"),
        ],
    );

    let err = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build()
        .unwrap_err();

    assert!(
        err.to_string().contains("stopper_value") && err.to_string().contains("not optional"),
        "unexpected error: {err}"
    );
}

#[test]
fn serde_backward_compat_no_hierarchies() {
    let json = r#"{
        "tables": [],
        "relationships": [],
        "measures": [],
        "calculated_columns": [],
        "measure_groups": []
    }"#;
    let model: DataModel = serde_json::from_str(json).unwrap();
    assert!(model.hierarchies().is_empty());
}

#[test]
fn hierarchy_json_roundtrip() {
    use crate::model::hierarchy::{HierarchyLevel, RaggedBehavior};

    let h = Hierarchy::new(
        "Geography",
        "dim_geography",
        vec![
            HierarchyLevel::new("country"),
            HierarchyLevel::new("state")
                .with_display_name("State/Province")
                .with_optional(true),
            HierarchyLevel::new("city"),
        ],
    )
    .with_ragged_behavior(RaggedBehavior::RepeatParent);

    let model = DataModel::builder()
        .add_table(dim_geography_table())
        .add_hierarchy(h)
        .build()
        .unwrap();

    let json = serde_json::to_string_pretty(&model).unwrap();
    let restored: DataModel = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.hierarchies().len(), 1);
    let rh = &restored.hierarchies()[0];
    assert_eq!(rh.name(), "Geography");
    assert_eq!(rh.table(), "dim_geography");
    assert_eq!(rh.levels().len(), 3);
    assert_eq!(rh.levels()[1].display_name(), Some("State/Province"));
    assert!(rh.levels()[1].is_optional());
    assert_eq!(rh.ragged_behavior(), RaggedBehavior::RepeatParent);
    assert!(restored.validate().is_ok());
}
