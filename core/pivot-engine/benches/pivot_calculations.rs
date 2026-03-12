//! Pivot engine benchmarks.
//!
//! Run with: cargo bench -p pivot-engine
//!
//! Benchmarks cover the full pipeline: cache build -> calculate -> view,
//! across different dataset sizes and field configurations.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use engine::CellValue;
use pivot_engine::{
    AggregationType, FieldIndex, PivotCache, PivotDefinition, PivotField, PivotId, ValueField,
    calculate_pivot,
};

// ============================================================================
// Data generators
// ============================================================================

/// Dimension pool used to generate synthetic data with realistic cardinality.
struct DimensionPool {
    regions: Vec<&'static str>,
    cities: Vec<&'static str>,
    products: Vec<&'static str>,
    categories: Vec<&'static str>,
    quarters: Vec<&'static str>,
}

impl DimensionPool {
    fn new() -> Self {
        DimensionPool {
            regions: vec![
                "North", "South", "East", "West", "Central",
                "North-East", "North-West", "South-East", "South-West", "Midwest",
            ],
            cities: vec![
                "Stockholm", "Gothenburg", "Malmo", "Uppsala", "Linkoping",
                "Orebro", "Vasteras", "Norrkoping", "Helsingborg", "Jonkoping",
                "Umea", "Lund", "Boras", "Sundsvall", "Gavle",
                "Halmstad", "Vaxjo", "Karlstad", "Lulea", "Trollhattan",
                "Kalmar", "Falun", "Skelleftea", "Kristianstad", "Karlskrona",
            ],
            products: vec![
                "Widget A", "Widget B", "Widget C", "Gadget X", "Gadget Y",
                "Gadget Z", "Tool Alpha", "Tool Beta", "Tool Gamma", "Part 100",
                "Part 200", "Part 300", "Part 400", "Part 500", "Part 600",
                "Module P1", "Module P2", "Module P3", "Assembly K1", "Assembly K2",
            ],
            categories: vec![
                "Electronics", "Hardware", "Software", "Services", "Accessories",
                "Consumables", "Industrial", "Automotive",
            ],
            quarters: vec!["Q1", "Q2", "Q3", "Q4"],
        }
    }

    fn region(&self, i: usize) -> &str {
        self.regions[i % self.regions.len()]
    }
    fn city(&self, i: usize) -> &str {
        self.cities[i % self.cities.len()]
    }
    fn product(&self, i: usize) -> &str {
        self.products[i % self.products.len()]
    }
    fn category(&self, i: usize) -> &str {
        self.categories[i % self.categories.len()]
    }
    fn quarter(&self, i: usize) -> &str {
        self.quarters[i % self.quarters.len()]
    }
}

/// Schema: Region | City | Product | Category | Quarter | Sales | Quantity | Cost
const COL_REGION: FieldIndex = 0;
const COL_CITY: FieldIndex = 1;
const COL_PRODUCT: FieldIndex = 2;
const COL_CATEGORY: FieldIndex = 3;
const COL_QUARTER: FieldIndex = 4;
const COL_SALES: FieldIndex = 5;
const COL_QUANTITY: FieldIndex = 6;
const COL_COST: FieldIndex = 7;
const FIELD_COUNT: usize = 8;

const HEADERS: [&str; FIELD_COUNT] = [
    "Region", "City", "Product", "Category", "Quarter", "Sales", "Quantity", "Cost",
];

/// Build a PivotCache with the given number of rows.
/// Uses deterministic pseudo-random data so benchmarks are reproducible.
fn build_cache(pivot_id: PivotId, row_count: usize) -> PivotCache {
    let pool = DimensionPool::new();
    let mut cache = PivotCache::new(pivot_id, FIELD_COUNT);

    for (i, name) in HEADERS.iter().enumerate() {
        cache.set_field_name(i, name.to_string());
    }
    cache.reserve(row_count);

    for r in 0..row_count {
        // Simple deterministic mixing to spread values across dimensions
        let mix = r.wrapping_mul(2654435761); // Knuth multiplicative hash
        let values = [
            CellValue::Text(pool.region(mix).to_string()),
            CellValue::Text(pool.city(mix >> 3).to_string()),
            CellValue::Text(pool.product(mix >> 5).to_string()),
            CellValue::Text(pool.category(mix >> 7).to_string()),
            CellValue::Text(pool.quarter(r).to_string()),
            CellValue::Number(100.0 + (r % 9999) as f64),
            CellValue::Number(1.0 + (r % 500) as f64),
            CellValue::Number(50.0 + (r % 4999) as f64),
        ];
        cache.add_record(r as u32, &values);
    }

    cache
}

/// Build a PivotDefinition with the given row/column/value fields.
fn build_definition(
    pivot_id: PivotId,
    row_count: usize,
    row_fields: &[(FieldIndex, &str)],
    col_fields: &[(FieldIndex, &str)],
    val_fields: &[(FieldIndex, &str, AggregationType)],
) -> PivotDefinition {
    let mut def = PivotDefinition::new(
        pivot_id,
        (0, 0),
        (row_count as u32, FIELD_COUNT as u32 - 1),
    );
    for &(idx, name) in row_fields {
        def.row_fields.push(PivotField::new(idx, name.to_string()));
    }
    for &(idx, name) in col_fields {
        def.column_fields.push(PivotField::new(idx, name.to_string()));
    }
    for &(idx, name, agg) in val_fields {
        def.value_fields.push(ValueField::new(idx, name.to_string(), agg));
    }
    def
}

// ============================================================================
// Benchmark: cache build
// ============================================================================

fn bench_cache_build(c: &mut Criterion) {
    let mut group = c.benchmark_group("cache_build");
    for &size in &[1_000, 10_000, 100_000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &n| {
            b.iter(|| {
                black_box(build_cache(1, n));
            });
        });
    }
    group.finish();
}

// ============================================================================
// Benchmark: full calculate (varying dataset size)
// ============================================================================

fn bench_calculate_by_size(c: &mut Criterion) {
    let mut group = c.benchmark_group("calculate_by_size");
    // Standard config: Region (row) x Quarter (col), Sum of Sales
    let row_f = &[(COL_REGION, "Region")];
    let col_f = &[(COL_QUARTER, "Quarter")];
    let val_f = &[(COL_SALES, "Sum of Sales", AggregationType::Sum)];

    for &size in &[1_000, 10_000, 100_000] {
        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, &n| {
            let mut cache = build_cache(1, n);
            let def = build_definition(1, n, row_f, col_f, val_f);
            b.iter(|| {
                cache.invalidate_aggregates();
                black_box(calculate_pivot(&def, &mut cache));
            });
        });
    }
    group.finish();
}

// ============================================================================
// Benchmark: calculate with varying field configurations
// ============================================================================

fn bench_calculate_field_configs(c: &mut Criterion) {
    let size = 50_000;
    let mut group = c.benchmark_group("calculate_field_configs");

    // Config 1: Simple - 1 row field, 1 value
    group.bench_function("1row_0col_1val", |b| {
        let mut cache = build_cache(1, size);
        let def = build_definition(
            1,
            size,
            &[(COL_REGION, "Region")],
            &[],
            &[(COL_SALES, "Sum of Sales", AggregationType::Sum)],
        );
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    // Config 2: Two row fields (hierarchy) + column field
    group.bench_function("2row_1col_1val", |b| {
        let mut cache = build_cache(1, size);
        let def = build_definition(
            1,
            size,
            &[(COL_REGION, "Region"), (COL_CITY, "City")],
            &[(COL_QUARTER, "Quarter")],
            &[(COL_SALES, "Sum of Sales", AggregationType::Sum)],
        );
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    // Config 3: Three row fields (deep hierarchy) + column field
    group.bench_function("3row_1col_1val", |b| {
        let mut cache = build_cache(1, size);
        let def = build_definition(
            1,
            size,
            &[
                (COL_REGION, "Region"),
                (COL_CITY, "City"),
                (COL_PRODUCT, "Product"),
            ],
            &[(COL_QUARTER, "Quarter")],
            &[(COL_SALES, "Sum of Sales", AggregationType::Sum)],
        );
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    // Config 4: Multiple value fields
    group.bench_function("2row_1col_3val", |b| {
        let mut cache = build_cache(1, size);
        let def = build_definition(
            1,
            size,
            &[(COL_REGION, "Region"), (COL_CATEGORY, "Category")],
            &[(COL_QUARTER, "Quarter")],
            &[
                (COL_SALES, "Sum of Sales", AggregationType::Sum),
                (COL_QUANTITY, "Sum of Quantity", AggregationType::Sum),
                (COL_COST, "Avg Cost", AggregationType::Average),
            ],
        );
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    // Config 5: High-cardinality row field (City x Product = ~500 combos)
    group.bench_function("high_cardinality_2row_1col", |b| {
        let mut cache = build_cache(1, size);
        let def = build_definition(
            1,
            size,
            &[(COL_CITY, "City"), (COL_PRODUCT, "Product")],
            &[(COL_QUARTER, "Quarter")],
            &[(COL_SALES, "Sum of Sales", AggregationType::Sum)],
        );
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    // Config 6: Column-heavy (many column items)
    group.bench_function("1row_2col_1val", |b| {
        let mut cache = build_cache(1, size);
        let def = build_definition(
            1,
            size,
            &[(COL_REGION, "Region")],
            &[(COL_PRODUCT, "Product"), (COL_QUARTER, "Quarter")],
            &[(COL_SALES, "Sum of Sales", AggregationType::Sum)],
        );
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    group.finish();
}

// ============================================================================
// Benchmark: attribute (LOOKUP) fields
// ============================================================================

fn bench_calculate_with_attributes(c: &mut Criterion) {
    let size = 50_000;
    let mut group = c.benchmark_group("calculate_attributes");

    // Baseline: City as GROUP
    group.bench_function("city_group", |b| {
        let mut cache = build_cache(1, size);
        let def = build_definition(
            1,
            size,
            &[(COL_REGION, "Region"), (COL_CITY, "City")],
            &[(COL_QUARTER, "Quarter")],
            &[(COL_SALES, "Sum of Sales", AggregationType::Sum)],
        );
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    // With City as LOOKUP (attribute)
    group.bench_function("city_lookup", |b| {
        let mut cache = build_cache(1, size);
        let mut def = build_definition(
            1,
            size,
            &[(COL_REGION, "Region")],
            &[(COL_QUARTER, "Quarter")],
            &[(COL_SALES, "Sum of Sales", AggregationType::Sum)],
        );
        // Add City as an attribute field on rows
        def.row_fields.push(PivotField::new_attribute(COL_CITY, "City".to_string()));
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    group.finish();
}

// ============================================================================
// Benchmark: aggregation types
// ============================================================================

fn bench_aggregation_types(c: &mut Criterion) {
    let size = 50_000;
    let mut group = c.benchmark_group("aggregation_types");

    let row_f = &[(COL_REGION, "Region"), (COL_CITY, "City")];
    let col_f = &[(COL_QUARTER, "Quarter")];

    for agg in &[
        AggregationType::Sum,
        AggregationType::Average,
        AggregationType::Count,
        AggregationType::Min,
        AggregationType::Max,
        AggregationType::StdDev,
    ] {
        group.bench_with_input(BenchmarkId::from_parameter(format!("{:?}", agg)), agg, |b, &agg| {
            let mut cache = build_cache(1, size);
            let def = build_definition(1, size, row_f, col_f, &[(COL_SALES, "Sales", agg)]);
            b.iter(|| {
                cache.invalidate_aggregates();
                black_box(calculate_pivot(&def, &mut cache));
            });
        });
    }

    group.finish();
}

// ============================================================================
// Benchmark: large dataset (stress test)
// ============================================================================

fn bench_large_dataset(c: &mut Criterion) {
    let mut group = c.benchmark_group("large_dataset");
    group.sample_size(10); // Fewer samples for large datasets

    let size = 500_000;
    let mut cache = build_cache(1, size);

    // Simple pivot on 500K rows
    group.bench_function("500k_simple", |b| {
        let def = build_definition(
            1,
            size,
            &[(COL_REGION, "Region")],
            &[(COL_QUARTER, "Quarter")],
            &[(COL_SALES, "Sum of Sales", AggregationType::Sum)],
        );
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    // Complex pivot on 500K rows
    group.bench_function("500k_complex", |b| {
        let def = build_definition(
            1,
            size,
            &[
                (COL_REGION, "Region"),
                (COL_CITY, "City"),
                (COL_PRODUCT, "Product"),
            ],
            &[(COL_QUARTER, "Quarter")],
            &[
                (COL_SALES, "Sum of Sales", AggregationType::Sum),
                (COL_QUANTITY, "Sum of Qty", AggregationType::Sum),
            ],
        );
        b.iter(|| {
            cache.invalidate_aggregates();
            black_box(calculate_pivot(&def, &mut cache));
        });
    });

    group.finish();
}

// ============================================================================
// Main
// ============================================================================

criterion_group!(
    benches,
    bench_cache_build,
    bench_calculate_by_size,
    bench_calculate_field_configs,
    bench_aggregation_types,
    bench_calculate_with_attributes,
    bench_large_dataset,
);
criterion_main!(benches);
