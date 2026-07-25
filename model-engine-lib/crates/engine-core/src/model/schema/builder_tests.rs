//! Build-time validation tests: tables, relationships (incl. active /
//! inactive), calculated columns, contexts, and table variables.

use super::test_fixtures::*;
use super::*;
use crate::model::column::Column;
use crate::types::DataType;

// --- Existing tests ---

#[test]
fn build_model_with_two_tables() {
    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .build()
        .unwrap();

    assert_eq!(model.tables().len(), 2);
    assert!(model.table("Sales").is_ok());
    assert!(model.table("Products").is_ok());
    assert!(model.table("Missing").is_err());
}

#[test]
fn duplicate_table_names_rejected() {
    let t1 = Table::new("T", vec![Column::new("a", DataType::Int32)]).unwrap();
    let t2 = Table::new("T", vec![Column::new("b", DataType::Int32)]).unwrap();

    let result = DataModel::builder().add_table(t1).add_table(t2).build();
    assert!(result.is_err());
}

// --- Relationship tests ---

#[test]
fn build_model_with_relationship() {
    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(sales_products_relationship())
        .build()
        .unwrap();

    assert_eq!(model.relationships().len(), 1);
    assert_eq!(model.relationships()[0].name(), "Sales_Products");
}

#[test]
fn rejects_relationship_to_missing_from_table() {
    let rel = Relationship::many_to_one("Bad", "NonExistent", "id", "Products", "id");
    let result = DataModel::builder()
        .add_table(products_table())
        .add_relationship(rel)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("from_table"));
    assert!(err.contains("NonExistent"));
}

#[test]
fn rejects_relationship_to_missing_to_table() {
    let rel = Relationship::many_to_one("Bad", "Sales", "product_id", "NonExistent", "id");
    let result = DataModel::builder()
        .add_table(sales_table())
        .add_relationship(rel)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("to_table"));
    assert!(err.contains("NonExistent"));
}

#[test]
fn rejects_relationship_with_missing_from_column() {
    let rel = Relationship::many_to_one("Bad", "Sales", "nonexistent_col", "Products", "id");
    let result = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(rel)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("nonexistent_col"));
}

#[test]
fn rejects_relationship_with_missing_to_column() {
    let rel = Relationship::many_to_one("Bad", "Sales", "product_id", "Products", "nonexistent");
    let result = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(rel)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("nonexistent"));
}

#[test]
fn rejects_relationship_with_type_mismatch() {
    // Sales.product_id is Int64, but Products.name is String
    let rel = Relationship::many_to_one("Bad", "Sales", "product_id", "Products", "name");
    let result = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(rel)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("type mismatch"));
}

#[test]
fn rejects_duplicate_relationship_names() {
    let rel1 = sales_products_relationship();
    let rel2 = Relationship::many_to_one("Sales_Products", "Sales", "store_id", "Stores", "id");

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_table(stores_table())
        .add_relationship(rel1)
        .add_relationship(rel2)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Duplicate"));
    assert!(err.contains("Sales_Products"));
}

#[test]
fn lookup_relationship_by_name() {
    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(sales_products_relationship())
        .build()
        .unwrap();

    let rel = model.relationship("Sales_Products").unwrap();
    assert_eq!(rel.from_table(), "Sales");
    assert_eq!(rel.to_table(), "Products");
}

#[test]
fn relationship_not_found() {
    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .build()
        .unwrap();

    assert!(model.relationship("Missing").is_err());
}

#[test]
fn find_relationship_between_tables() {
    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(sales_products_relationship())
        .build()
        .unwrap();

    // Forward direction.
    let rel = model.find_relationship("Sales", "Products").unwrap();
    assert_eq!(rel.name(), "Sales_Products");

    // Reverse direction.
    let rel = model.find_relationship("Products", "Sales").unwrap();
    assert_eq!(rel.name(), "Sales_Products");

    // No relationship.
    assert!(model.find_relationship("Sales", "Stores").is_err());
}

#[test]
fn relationships_for_table() {
    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_table(stores_table())
        .add_relationship(sales_products_relationship())
        .add_relationship(sales_stores_relationship())
        .build()
        .unwrap();

    let sales_rels = model.relationships_for_table("Sales");
    assert_eq!(sales_rels.len(), 2);

    let products_rels = model.relationships_for_table("Products");
    assert_eq!(products_rels.len(), 1);

    let stores_rels = model.relationships_for_table("Stores");
    assert_eq!(stores_rels.len(), 1);
}

#[test]
fn star_schema_with_multiple_dimensions() {
    let dates = Table::new(
        "Dates",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("year", DataType::Int32),
        ],
    )
    .unwrap();

    let sales = Table::new(
        "Sales",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("product_id", DataType::Int64),
            Column::new("store_id", DataType::Int64),
            Column::new("date_id", DataType::Int64),
            Column::new("amount", DataType::Float64),
        ],
    )
    .unwrap();

    let model = DataModel::builder()
        .add_table(sales)
        .add_table(products_table())
        .add_table(stores_table())
        .add_table(dates)
        .add_relationship(Relationship::many_to_one(
            "Sales_Products",
            "Sales",
            "product_id",
            "Products",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Stores",
            "Sales",
            "store_id",
            "Stores",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Dates",
            "Sales",
            "date_id",
            "Dates",
            "id",
        ))
        .build()
        .unwrap();

    assert_eq!(model.tables().len(), 4);
    assert_eq!(model.relationships().len(), 3);
    assert_eq!(model.relationships_for_table("Sales").len(), 3);
}

// --- Active/inactive relationship tests ---

#[test]
fn find_relationship_skips_inactive() {
    let active = Relationship::many_to_one("Active", "Sales", "product_id", "Products", "id");
    let inactive = Relationship::many_to_one("Inactive", "Sales", "store_id", "Stores", "id")
        .with_active(false);

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_table(stores_table())
        .add_relationship(active)
        .add_relationship(inactive)
        .build()
        .unwrap();

    // Active relationship is found.
    assert!(model.find_relationship("Sales", "Products").is_ok());
    // Inactive relationship is NOT found via find_relationship.
    assert!(model.find_relationship("Sales", "Stores").is_err());
    // But IS found via find_any_relationship.
    assert!(model.find_any_relationship("Sales", "Stores").is_ok());
}

#[test]
fn find_relationship_prefers_active_when_multiple_exist() {
    let active =
        Relationship::many_to_one("Sales_Dates_Order", "Sales", "product_id", "Products", "id");
    let inactive =
        Relationship::many_to_one("Sales_Dates_Ship", "Sales", "store_id", "Products", "id")
            .with_active(false);

    // Need a Products table with both id columns for the join
    let products = Table::new(
        "Products",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("name", DataType::String),
            Column::new("category", DataType::String),
        ],
    )
    .unwrap();

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products)
        .add_relationship(active)
        .add_relationship(inactive)
        .build()
        .unwrap();

    let rel = model.find_relationship("Sales", "Products").unwrap();
    assert_eq!(rel.name(), "Sales_Dates_Order");
}

#[test]
fn rejects_multiple_active_relationships_between_same_tables() {
    let rel1 = Relationship::many_to_one("Sales_Prod_1", "Sales", "product_id", "Products", "id");
    let rel2 = Relationship::many_to_one("Sales_Prod_2", "Sales", "store_id", "Products", "id");

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(rel1)
        .add_relationship(rel2)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("multiple active"));
}

#[test]
fn allows_multiple_inactive_relationships_between_same_tables() {
    let active =
        Relationship::many_to_one("Sales_Prod_Active", "Sales", "product_id", "Products", "id");
    let inactive1 =
        Relationship::many_to_one("Sales_Prod_Alt1", "Sales", "store_id", "Products", "id")
            .with_active(false);
    let inactive2 = Relationship::many_to_one("Sales_Prod_Alt2", "Sales", "id", "Products", "id")
        .with_active(false);

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(active)
        .add_relationship(inactive1)
        .add_relationship(inactive2)
        .build()
        .unwrap();

    assert_eq!(model.relationships().len(), 3);
}

#[test]
fn allows_zero_active_relationships_between_tables() {
    // Both inactive — valid (no default path, must always use USERELATIONSHIP)
    let inactive1 =
        Relationship::many_to_one("Sales_Prod_1", "Sales", "product_id", "Products", "id")
            .with_active(false);
    let inactive2 =
        Relationship::many_to_one("Sales_Prod_2", "Sales", "store_id", "Products", "id")
            .with_active(false);

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(inactive1)
        .add_relationship(inactive2)
        .build()
        .unwrap();

    // find_relationship should fail (no active)
    assert!(model.find_relationship("Sales", "Products").is_err());
    // but find_any_relationship should succeed
    assert!(model.find_any_relationship("Sales", "Products").is_ok());
}

#[test]
fn relationship_by_name_finds_inactive() {
    let inactive =
        Relationship::many_to_one("Sales_Prod_Ship", "Sales", "product_id", "Products", "id")
            .with_active(false);

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(inactive)
        .build()
        .unwrap();

    // Lookup by name always works regardless of active status.
    let rel = model.relationship("Sales_Prod_Ship").unwrap();
    assert!(!rel.is_active());
}

#[test]
fn serde_backward_compat_no_active_field_in_model() {
    // JSON model without "active" field in relationships should deserialize as active.
    let json = r#"{
        "tables": [],
        "relationships": [{
            "name": "R",
            "from_table": "Sales",
            "to_table": "Products",
            "conditions": [{"from_column": "pid", "to_column": "id", "operator": "Equal"}],
            "cardinality": "ManyToOne",
            "propagation": "Auto"
        }],
        "measures": [],
        "calculated_columns": [],
        "measure_groups": []
    }"#;
    let model: DataModel = serde_json::from_str(json).unwrap();
    assert!(model.relationships()[0].is_active());
}

// --- Calculated column tests ---

#[test]
fn calculated_column_added_to_model() {
    use crate::compute::expression as expr;

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_calculated_column(CalculatedColumn::new(
            "double_amount",
            "Sales",
            expr::col("amount").multiply(expr::lit(2.0)),
            DataType::Float64,
        ))
        .build()
        .unwrap();

    assert_eq!(model.calculated_columns().len(), 1);
    assert_eq!(model.calculated_columns_for_table("Sales").len(), 1);
    assert!(model.calculated_columns_for_table("Products").is_empty());
}

#[test]
fn rejects_calculated_column_on_missing_table() {
    use crate::compute::expression as expr;

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_calculated_column(CalculatedColumn::new(
            "x",
            "NonExistent",
            expr::col("a"),
            DataType::Float64,
        ))
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("NonExistent"));
}

#[test]
fn rejects_calculated_column_referencing_missing_column() {
    use crate::compute::expression as expr;

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_calculated_column(CalculatedColumn::new(
            "bad",
            "Sales",
            expr::col("nonexistent"),
            DataType::Float64,
        ))
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("nonexistent"));
}

#[test]
fn rejects_calculated_column_with_aggregate() {
    use crate::compute::aggregate::AggregateOp;
    use crate::compute::expression as expr;

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_calculated_column(CalculatedColumn::new(
            "total",
            "Sales",
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            DataType::Float64,
        ))
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("aggregate"));
}

#[test]
fn rejects_calculated_column_name_conflicts_with_physical_column() {
    use crate::compute::expression as expr;

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_calculated_column(CalculatedColumn::new(
            "amount", // conflicts with physical column
            "Sales",
            expr::col("id"),
            DataType::Float64,
        ))
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts"));
}

#[test]
fn rejects_calculated_column_with_context_ops() {
    use crate::compute::expression as expr;

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_calculated_column(CalculatedColumn::new(
            "filtered",
            "Sales",
            expr::keep(expr::col("amount"), vec![]),
            DataType::Float64,
        ))
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("context operations"));
}

#[test]
fn rejects_duplicate_context_names() {
    use crate::model::context::{ContextDefinition, ContextOp};

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_context(ContextDefinition::new("ctx", vec![ContextOp::Reset]))
        .add_context(ContextDefinition::new("ctx", vec![ContextOp::Reset]))
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Duplicate"));
    assert!(err.contains("ctx"));
}

#[test]
fn rejects_context_inheriting_unknown() {
    use crate::model::context::{ContextDefinition, ContextOp};

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_context(ContextDefinition::new(
            "child",
            vec![ContextOp::Inherit("nonexistent".into())],
        ))
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("nonexistent"));
}

// --- Table variable tests ---

#[test]
fn table_variable_added_to_model() {
    use crate::compute::expression::{ComparisonOp, FilterPredicate};

    let var = TableVariable::new(
        "premium",
        "Products",
        vec![FilterPredicate::new(
            "Products",
            "category",
            ComparisonOp::Equal,
            "Premium",
        )],
    );

    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_table_variable(var)
        .build()
        .unwrap();

    assert_eq!(model.table_variables().len(), 1);
    assert!(model.table_variable("premium").is_ok());
    assert!(model.table_variable("missing").is_err());
}

#[test]
fn rejects_duplicate_table_variable_names() {
    let v1 = TableVariable::new("v", "Products", vec![]);
    let v2 = TableVariable::new("v", "Products", vec![]);

    let result = DataModel::builder()
        .add_table(products_table())
        .add_table_variable(v1)
        .add_table_variable(v2)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Duplicate"));
}

#[test]
fn rejects_table_variable_name_collision_with_table() {
    let var = TableVariable::new("Products", "Products", vec![]);

    let result = DataModel::builder()
        .add_table(products_table())
        .add_table_variable(var)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("conflicts with table"));
}

#[test]
fn rejects_table_variable_with_missing_source() {
    let var = TableVariable::new("v", "NonExistent", vec![]);

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_table_variable(var)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("NonExistent"));
}

#[test]
fn rejects_table_variable_with_invalid_filter_column() {
    use crate::compute::expression::{ComparisonOp, FilterPredicate};

    let var = TableVariable::new(
        "v",
        "Products",
        vec![FilterPredicate::new(
            "Products",
            "nonexistent",
            ComparisonOp::Equal,
            "x",
        )],
    );

    let result = DataModel::builder()
        .add_table(products_table())
        .add_table_variable(var)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("nonexistent"));
}

#[test]
fn rejects_circular_table_variable_references() {
    let v1 = TableVariable::new("a", "b", vec![]);
    let v2 = TableVariable::new("b", "a", vec![]);

    let result = DataModel::builder()
        .add_table(sales_table())
        .add_table_variable(v1)
        .add_table_variable(v2)
        .build();

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("circular"));
}

#[test]
fn composed_table_variable_valid() {
    use crate::compute::expression::{ComparisonOp, FilterPredicate};

    let v1 = TableVariable::new(
        "premium",
        "Products",
        vec![FilterPredicate::new(
            "Products",
            "category",
            ComparisonOp::Equal,
            "Premium",
        )],
    );
    let v2 = TableVariable::new(
        "expensive_premium",
        "premium",
        vec![FilterPredicate::new(
            "Products",
            "name",
            ComparisonOp::NotEqual,
            "",
        )],
    );

    let model = DataModel::builder()
        .add_table(products_table())
        .add_table_variable(v1)
        .add_table_variable(v2)
        .build()
        .unwrap();

    assert_eq!(model.table_variables().len(), 2);
}

#[test]
fn serde_backward_compat_no_table_variables() {
    // JSON without table_variables field should deserialize with empty vec.
    let json = r#"{
        "tables": [],
        "relationships": [],
        "measures": [],
        "calculated_columns": [],
        "measure_groups": []
    }"#;
    let model: DataModel = serde_json::from_str(json).unwrap();
    assert!(model.table_variables().is_empty());
}
