# USERELATIONSHIP

Activates an inactive relationship for the evaluation of a measure or filter context. This allows different measures to use different relationships between the same two tables — for example, joining a Date dimension to a fact table on `OrderDate` in one measure and on `ShipDate` in another.

## Syntax

As a context argument to an aggregation function:

```
SUM(table[column], USERELATIONSHIP("relationship_name"))
```

As a standalone wrapper around an expression:

```
USERELATIONSHIP(SUM(table[column]), "relationship_name")
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `relationship_name` | A string literal (double-quoted) naming the inactive relationship to activate. The relationship must exist in the data model and must connect the fact table to a dimension table involved in the measure's evaluation. |

## Return value

The result of the inner expression, evaluated using the specified relationship instead of the default active relationship between the same table pair.

## Remarks

- **Active vs. inactive relationships**: Each pair of tables can have multiple relationships defined between them, but at most one can be marked as *active*. The active relationship is used by default for all measures. Inactive relationships are only used when explicitly activated via USERELATIONSHIP.
- **Per-measure isolation**: USERELATIONSHIP only affects the measure it is applied to. Other measures in the same query continue to use the default active relationship. The engine achieves this through aliased JOINs — each relationship gets its own SQL alias, so measures see independent sets of matched rows.
- **Non-equi relationships**: USERELATIONSHIP works with any relationship type, including range joins (e.g., `>=`, `<=`). Be aware that non-equi relationships can produce many-to-many joins, which may inflate aggregation results. Design measures carefully when using range-based inactive relationships.
- **Combinable with other context operations**: USERELATIONSHIP can be combined with [KEEP](KEEP.md), [CLEAR](CLEAR.md), [RESET](RESET.md), and other context operations in the same measure. It can also appear in named context definitions.
- **Named context definitions**: USERELATIONSHIP can be included in a named context, allowing reuse across multiple measures without repetition.
- **Filter/slicer use**: Unlike Power BI (where USERELATIONSHIP is limited to measures), this engine supports USERELATIONSHIP in filter contexts too — including [KEEP](KEEP.md) filters and named context definitions. This enables scenarios where a slicer-equivalent filter uses an alternate relationship.
- **IN-filter optimization**: When a measure uses USERELATIONSHIP, the engine's IN-filter propagation optimization (which pre-filters fact tables based on dimension filters) is conservatively skipped for the affected dimension. The dimension is still JOINed correctly in the local aggregation — only the optimization is bypassed.
- **Local aggregation**: Like other context operations, measures using USERELATIONSHIP are always computed locally (not pushed down to the data source).

## Defining inactive relationships

Before using USERELATIONSHIP, the data model must contain an inactive relationship. Create one by chaining `.with_active(false)` on the relationship builder:

```rust
// Active relationship: Sales joined to Dates on order_date
let active = Relationship::many_to_one(
    "Sales_Dates_Order", "Sales", "order_date_id", "Dates", "id"
);

// Inactive relationship: Sales joined to Dates on ship_date
let inactive = Relationship::many_to_one(
    "Sales_Dates_Ship", "Sales", "ship_date_id", "Dates", "id"
).with_active(false);
```

Both relationships connect Sales to Dates, but only `Sales_Dates_Order` is active by default.

## Example 1: Order date vs. ship date

Two measures using different date relationships:

```
DEFINE Revenue by Order Date = SUM(fact_sales[linetotal])
DEFINE Revenue by Ship Date = SUM(fact_sales[linetotal], USERELATIONSHIP("Sales_Dates_Ship"))
```

When grouped by `dim_date[year]`:

| year | Revenue by Order Date | Revenue by Ship Date |
|------|----------------------|---------------------|
| 2013 | $32,427,616.47 | $30,125,891.22 |
| 2014 | $49,515,794.44 | $51,817,519.69 |

The same rows are counted differently because the date dimension is joined on different columns. Revenue by Ship Date attributes sales to when they were shipped, not when they were ordered.

## Example 2: Combined with KEEP

Filter revenue by ship date year:

```
DEFINE Shipped 2014 = SUM(
    fact_sales[linetotal],
    USERELATIONSHIP("Sales_Dates_Ship"),
    KEEP(dim_date, dim_date[year] = 2014)
)
```

This calculates revenue for items shipped in 2014, using the ship date relationship. The KEEP filter applies to the `dim_date` table joined via the ship date relationship.

## Example 3: Named context with USERELATIONSHIP

Define a reusable context that activates the ship date relationship:

```
CONTEXT ship_date_context
    USERELATIONSHIP("Sales_Dates_Ship")
```

Then use it in multiple measures:

```
DEFINE Shipped Revenue = SUM(fact_sales[linetotal], ship_date_context)
DEFINE Shipped Count = COUNT(fact_sales[orderid], ship_date_context)
```

Both measures use the ship date relationship without repeating the USERELATIONSHIP call.

## Example 4: Side-by-side with different relationships

Compare order-based and ship-based metrics in the same query:

```
DEFINE Order Revenue = SUM(fact_sales[linetotal])
DEFINE Ship Revenue = SUM(fact_sales[linetotal], USERELATIONSHIP("Sales_Dates_Ship"))
DEFINE Diff = Order Revenue - Ship Revenue
QUERY: Order Revenue, Ship Revenue, Diff BY dim_date[year]
```

Each measure operates independently. `Order Revenue` uses the active order date relationship, `Ship Revenue` uses the inactive ship date relationship, and `Diff` computes the difference. There is no interference between the two — each sees the rows matched by its own relationship.

## Example 5: Non-equi inactive relationship

An inactive relationship using a range join (e.g., for date ranges):

```rust
let range_rel = Relationship::many_to_many(
    "Sales_Periods",
    "Sales", "Periods",
    vec![
        JoinCondition::new("order_date", "start_date", JoinOperator::GreaterThanOrEqual),
        JoinCondition::new("order_date", "end_date", JoinOperator::LessThanOrEqual),
    ],
).with_active(false);
```

```
DEFINE Period Revenue = SUM(fact_sales[linetotal], USERELATIONSHIP("Sales_Periods"))
```

This joins each sale to the period it falls within. Because this is a many-to-many join (one sale can match multiple periods, and one period can contain multiple sales), take care to avoid double-counting.

## See also

- [KEEP](KEEP.md) — add filter conditions to the evaluation context
- [CLEAR](CLEAR.md) — remove specific filters from the evaluation context
- [RESET](RESET.md) — remove all filters from the evaluation context
- [SUM](SUM.md), [COUNT](COUNT.md), [AVG](AVG.md) — aggregation functions that accept USERELATIONSHIP
