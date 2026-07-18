# NOT

Changes FALSE to TRUE, or TRUE to FALSE. Negates a logical value.

## Syntax

```
NOT(logical)
```

NOT can also be used as a **prefix operator**:

```
NOT condition
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `logical` | A logical expression to negate. |

## Return value

TRUE if the argument is FALSE, FALSE if the argument is TRUE.

## Remarks

- NOT is available both as a function `NOT(expr)` and as a prefix operator `NOT expr`. Both produce the same result.
- The function form wraps the entire argument in parentheses, making it useful for complex conditions: `NOT(a > 0 AND b > 0)`.
- NOT generates a SQL `(NOT expr)` expression internally.
- The argument can contain aggregation functions, comparisons, or other logical functions.

## Example 1: Function syntax

```
DEFINE NotZero = IF(NOT(SUM(fact_sales[linetotal]) = 0), SUM(fact_sales[linetotal]), BLANK())
```

## Example 2: Operator syntax

```
DEFINE NotZero = IF(NOT SUM(fact_sales[linetotal]) = 0, SUM(fact_sales[linetotal]), BLANK())
```

## Example 3: Combined with AND/OR

```
DEFINE Filtered = IF(
    AND(NOT(ISBLANK(SUM(t[a]))), SUM(t[a]) > 0),
    SUM(t[a]),
    0
)
```

## See also

- [AND](AND.md) — returns TRUE if both arguments are TRUE
- [OR](OR.md) — returns TRUE if either argument is TRUE
- [XOR](XOR.md) — exclusive OR
- [IF](IF.md) — conditional branching
- [ISBLANK](ISBLANK.md) — test for NULL values
