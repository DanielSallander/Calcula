# NULLIF

Returns BLANK if an expression equals a specified value, otherwise returns the expression.

## Syntax

```
NULLIF(expression, value)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | The expression to evaluate. |
| `value` | The value to compare against. If `expression` equals this value, BLANK is returned. |

## Return value

BLANK if `expression` equals `value`, otherwise `expression`.

## Remarks

- NULLIF generates the SQL `NULLIF(a, b)` function.
- NULLIF is commonly used to convert sentinel values (such as 0 or empty string) to BLANK, enabling safe division or meaningful aggregation.
- NULLIF is the inverse of [COALESCE](COALESCE.md): NULLIF turns known values into BLANK, while COALESCE replaces BLANK with known values.
- A common pattern is `DIVIDE(numerator, NULLIF(denominator, 0))` to avoid division by zero. This is equivalent to using [DIVIDE](DIVIDE.md) with its built-in zero-check, but NULLIF is more general and can guard against any sentinel value.
- NULLIF always forces local computation when either argument contains aggregation functions.

## Example 1: Safe division by converting zero to BLANK

Avoid division by zero by nullifying a zero denominator.

```
DEFINE RevenuePerUnit = SUM(fact_sales[linetotal]) / NULLIF(SUM(fact_sales[orderqty]), 0)
```

If total order quantity is 0, the denominator becomes BLANK and the result is BLANK instead of an error.

## Example 2: Exclude placeholder values from aggregation

Some data sources use -1 as a "not applicable" marker. Convert it to BLANK so it is excluded from AVG.

```
DEFINE AvgRating = AVG(NULLIF(dim_product[rating], -1))
```

## Example 3: Convert empty strings to BLANK

Treat empty-string product colors as BLANK for downstream COALESCE or ISBLANK checks.

```
DEFINE ProductColor = COALESCE(NULLIF(dim_product[color], ""), "No Color")
```

Returns the product color if it is a non-empty string, otherwise "No Color".

## See also

- [ISBLANK](ISBLANK.md) -- test whether a value is BLANK
- [COALESCE](COALESCE.md) -- returns the first non-BLANK value from a list
- [DIVIDE](DIVIDE.md) -- safe division with built-in alternate value
