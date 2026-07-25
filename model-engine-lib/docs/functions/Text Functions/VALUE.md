# VALUE

Converts a text representation of a number to a numeric value.

## Syntax

```
VALUE(text)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | A text string that represents a number (e.g., `"123.45"`). |

## Return value

A numeric (double-precision floating point) value parsed from the text string.

## Remarks

- Generates a SQL `CAST(text AS DOUBLE)` expression internally (exact syntax varies by database: `DOUBLE PRECISION` in PostgreSQL, `FLOAT` in SQL Server).
- If `text` cannot be parsed as a number, the database will return an error.
- If `text` is NULL, the result is NULL.
- Use [FIXED](FIXED.md) for the reverse operation (number to text).
- Leading and trailing spaces are typically tolerated by the SQL CAST, but it is good practice to [TRIM](TRIM.md) first.

## Example 1: Convert a text column to a number

Parse a string-encoded quantity into a numeric value for aggregation.

```
DEFINE NumericQty = SUM(VALUE(fact_sales[quantity_text]))
```

## Example 2: Convert and compute

Parse a text price and multiply by quantity.

```
DEFINE ComputedTotal = VALUE(fact_sales[unitprice_text]) * fact_sales[orderqty]
```

## See also

- [FIXED](FIXED.md) -- convert a number to text with formatting
- [INT](../Math%20Functions/INT.md) -- truncate a number to an integer
- [ROUND](../Math%20Functions/ROUND.md) -- round a number to specified decimal places
- [TRIM](TRIM.md) -- remove leading and trailing spaces before conversion
