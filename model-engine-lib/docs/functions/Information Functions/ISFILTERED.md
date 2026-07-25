# ISFILTERED

Returns TRUE when the column carries a direct filter in the current query context — it is on the group-by axis, or targeted by a query filter or slicer (DAX-compatible).

## Syntax

```
ISFILTERED(table[column])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `table[column]` | The column to test for a direct filter. |

## Return value

TRUE or FALSE. Typically used as an `IF` condition to switch a measure's logic based on how the user is slicing.

## Remarks

- "Direct" means the column itself is filtered: it is one of the query's group-by (axis) columns, or a query filter / IN slicer / OR slicer names it. A filter on a *different* column of the same table does NOT make this column filtered (matching DAX semantics).
- The check is resolved **once per query, before planning** — the whole query sees one consistent TRUE/FALSE, on every execution path.
- Supported inside conditions and the common measure shapes (`IF`/`SWITCH` conditions, `VAR ... RETURN` blocks, aggregate operands, `DIVIDE`, `IFERROR`, `COALESCE`). In unsupported positions it evaluates as FALSE.
- Compare [HASONEVALUE](HASONEVALUE.md), which answers a different question from the *data* ("does exactly one distinct value survive the filters?") — ISFILTERED answers from the *filter context* ("did the user filter this column at all?").
- See [ISINSCOPE](ISINSCOPE.md) for the axis-only check (group-by level detection in hierarchies/subtotals).

## Example

Show detail logic only when the user has sliced or grouped by category.

```
DEFINE Category Detail = IF(
    ISFILTERED(dim_product[categoryname]),
    SUM(fact_sales[linetotal]),
    BLANK()
)
```

Grouped by `dim_product[categoryname]` (or with a category slicer active), the measure computes; on an unsliced grand-total view it shows blank.

## See also

- [ISINSCOPE](ISINSCOPE.md)
- [HASONEVALUE](HASONEVALUE.md)
- [SELECTEDVALUE](SELECTEDVALUE.md)
