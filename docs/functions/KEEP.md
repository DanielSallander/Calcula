# KEEP

Adds filter conditions to the evaluation context of a measure. Filters are applied with AND semantics — they narrow the set of rows used by the aggregation.

## Syntax

```
SUM(table[column], KEEP(dimension_table, filter1 [, filter2, ...]))
```

Where each filter has the form:

```
table[column] operator value
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `dimension_table` | The name of the dimension table being filtered. This is the first argument and identifies which table the filters apply to. |
| `filter` | One or more filter conditions in the form `table[column] operator value`. Multiple filters are separated by commas and combined with AND. |

### Supported operators

| Operator | Description |
|----------|-------------|
| `=` | Equal to |
| `!=` | Not equal to |
| `>` | Greater than |
| `>=` | Greater than or equal to |
| `<` | Less than |
| `<=` | Less than or equal to |

### Value types

| Type | Syntax | Example |
|------|--------|---------|
| Numeric | Unquoted number | `dim_date[year] = 2024` |
| String | Double-quoted text | `dim_product[categoryname] = "Bikes"` |

## Return value

The result of the aggregation function, computed over only the rows that satisfy all KEEP filter conditions (in addition to any existing filters from the query context).

## Remarks

- KEEP is used in two ways: (1) as the **second argument** to an aggregation function for measure-level context filters, and (2) as a **standalone expression** in `VAR` definitions to create table variables.
- Multiple filters within a single KEEP are combined with AND. All conditions must be true for a row to be included.
- KEEP filters are applied **per-measure** using a SQL `CASE WHEN` pattern internally. This means different measures in the same query can have different KEEP filters without interfering with each other.
- KEEP filters AND with the existing evaluation context. If the query already filters on a column, and KEEP also filters on the same column, both conditions apply (narrowing the result).
- To **replace** an existing filter instead of narrowing, first use [CLEAR](CLEAR.md) then KEEP. See Example 4.
- A measure using KEEP is always computed locally (not pushed down to the data source) because per-measure context operations require local aggregation.
- The dimension table specified in KEEP must be related to the fact table through a relationship in the data model.

## Example 1: Filter by year

Calculate revenue for the year 2014 only.

```
DEFINE Revenue 2014 = SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))
```

| Revenue 2014 |
|-------------|
| $32,427,616.47 |

## Example 2: Multiple filters

Calculate revenue for Bikes sold in 2014.

```
DEFINE Bikes 2014 = SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014, dim_product[categoryname] = "Bikes"))
```

Note: Even though `dim_product` is a different table than the first argument `dim_date`, the filter still works because the filter predicates carry their own table references.

## Example 3: Side-by-side comparison

Compare total revenue with filtered revenue in a grouped query.

```
DEFINE Revenue = SUM(fact_sales[linetotal])
DEFINE Revenue 2014 = SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))
QUERY: Revenue, Revenue 2014 BY dim_product[categoryname]
```

| categoryname | Revenue | Revenue 2014 |
|-------------|---------|-------------|
| Bikes | $94,620,526.47 | $28,318,144.65 |
| Components | $11,799,076.67 | $3,205,751.28 |
| Clothing | $2,120,542.60 | $590,216.45 |
| Accessories | $1,306,235.66 | $313,504.09 |

Each measure has its own context: Revenue sees all years, while Revenue 2014 sees only 2014 — even in the same query.

## Example 4: Override a filter (CLEAR + KEEP)

When the query context already filters by year (e.g., grouped by year), you can override it to always show a specific year:

```
DEFINE Always 2014 = SUM(fact_sales[linetotal], CLEAR(dim_date), KEEP(dim_date, dim_date[year] = 2014))
```

The [CLEAR](CLEAR.md) removes any existing year filter, then KEEP applies the 2014 filter. Without CLEAR, the KEEP would AND with the existing year filter from the group-by context.

## Example 5: Define a table variable

KEEP can be used standalone to define a table variable — a pre-filtered subset of a table:

```
VAR bikes = KEEP(dim_product, dim_product[categoryname] = "Bikes")
DEFINE Bike Count = DISTINCTCOUNT(bikes[productid])
```

Table variables are composable. A variable can reference another variable as its source:

```
VAR road_bikes = KEEP(bikes, dim_product[productline] = "R")
DEFINE Road Bike Count = DISTINCTCOUNT(road_bikes[productid])
```

The engine chains the filters: `categoryname = "Bikes"` AND `productline = "R"`.

## See also

- [CLEAR](CLEAR.md) — remove specific filters from the evaluation context
- [RESET](RESET.md) — remove all filters from the evaluation context
- [SUM](SUM.md), [COUNT](COUNT.md), [AVG](AVG.md) — aggregation functions that accept KEEP
