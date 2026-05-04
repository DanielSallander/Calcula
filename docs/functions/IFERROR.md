# IFERROR

Returns the expression result if it evaluates successfully, otherwise returns an alternate value. Used to handle errors such as division by zero or invalid computations.

## Syntax

```
IFERROR(expression, alternate_value)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `expression` | The expression to evaluate. If this produces an error (e.g., division by zero), the alternate value is returned instead. |
| `alternate_value` | The value to return when the expression produces an error. Can be a literal, column reference, or expression. |

## Return value

The result of `expression` if it evaluates without error, otherwise `alternate_value`.

## Remarks

- IFERROR is a convenience wrapper. In SQL context it maps to `COALESCE(expression, alternate_value)`, which catches NULL results from failed operations.
- For explicit division safety, prefer [DIVIDE](DIVIDE.md) which handles division by zero directly.
- IFERROR catches NULL-producing errors but does not catch all runtime exceptions. Use it for arithmetic edge cases, not general error handling.
- IFERROR forces local computation when arguments contain aggregation functions.

## Example 1: Safe ratio with fallback

Return 0 when the denominator is zero.

```
DEFINE SafeRatio = IFERROR(SUM(fact_sales[linetotal]) / SUM(fact_sales[orderqty]), 0)
```

## Example 2: Fallback to alternate measure

```
DEFINE Price = IFERROR(SUM(fact_sales[linetotal]) / SUM(fact_sales[orderqty]), AVG(fact_sales[unitprice]))
```

## See also

- [DIVIDE](DIVIDE.md) — safe division with built-in zero handling
- [IF](IF.md) — conditional logic based on a boolean test
- [ISBLANK](ISBLANK.md) — test whether a value is blank/null
- [COALESCE](COALESCE.md) — return the first non-blank value from a list
