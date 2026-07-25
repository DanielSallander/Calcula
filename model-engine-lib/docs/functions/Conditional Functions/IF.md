# IF

Evaluates a logical condition and returns one value when true and another when false.

## Syntax

```
IF(condition, true_value, false_value)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `condition` | A logical expression that evaluates to true or false. Supports comparison operators and logical connectors AND/OR/NOT. |
| `true_value` | The value returned when the condition is true. Can be any expression — numeric, string, or another function call. |
| `false_value` | The value returned when the condition is false. Can be any expression. |

### Condition syntax

Conditions use comparison operators on expressions:

```
expression operator expression
```

Conditions can be combined with logical operators:

| Operator | Description | Example |
|----------|-------------|---------|
| `AND` | Both conditions must be true | `SUM(t[a]) > 0 AND SUM(t[b]) > 0` |
| `OR` | Either condition must be true | `SUM(t[a]) > 100 OR SUM(t[b]) > 100` |
| `NOT` | Negates a condition | `NOT SUM(t[a]) = 0` |

Comparison operators: `=`, `!=`, `>`, `>=`, `<`, `<=`

## Return value

The `true_value` if the condition evaluates to true, otherwise the `false_value`.

## Remarks

- IF generates a SQL `CASE WHEN ... THEN ... ELSE ... END` expression internally.
- The condition, true_value, and false_value can all contain aggregation functions like SUM, COUNT, etc.
- IF expressions always force local computation — they are not pushed down to the data source.
- For multiple conditions testing the same expression against different values, consider using [SWITCH](SWITCH.md) instead.
- IF can be nested: `IF(cond1, IF(cond2, a, b), c)`.

## Example 1: Categorize by threshold

Label revenue as "High" or "Low" based on a threshold.

```
DEFINE RevenueCategory = IF(SUM(fact_sales[linetotal]) > 1000000, "High", "Low")
```

## Example 2: Conditional calculation

Return different calculations based on order quantity.

```
DEFINE AdjustedRevenue = IF(
    SUM(fact_sales[orderqty]) > 100,
    SUM(fact_sales[linetotal]) * 0.9,
    SUM(fact_sales[linetotal])
)
```

## Example 3: Combined conditions with AND

```
DEFINE PremiumRevenue = IF(
    SUM(fact_sales[linetotal]) > 50000 AND COUNT(fact_sales[salesorderdetailid]) > 100,
    SUM(fact_sales[linetotal]),
    0
)
```

## Example 4: Nested IF

```
DEFINE Tier = IF(
    SUM(fact_sales[linetotal]) > 1000000,
    "Gold",
    IF(SUM(fact_sales[linetotal]) > 100000, "Silver", "Bronze")
)
```

## See also

- [SWITCH](SWITCH.md) — multi-way branching on a single expression
- [DIVIDE](DIVIDE.md) — safe division (alternative to IF for zero checks)
- [ISBLANK](ISBLANK.md) — test for NULL values in conditions
- [COALESCE](COALESCE.md) — provide fallback for NULL values
