# SWITCH function

## Introduction

The SWITCH function evaluates an expression against a list of values and returns the result corresponding to the first matching value. If no match is found, an optional default value can be returned. SWITCH is a more readable alternative to deeply nested IF statements when you need to compare a single expression against multiple possible values.

Use SWITCH when mapping discrete values to specific outputs, such as converting department codes to department names, translating numeric month values to month names, or assigning pricing tiers based on membership levels. Unlike IFS, which tests arbitrary conditions, SWITCH compares one expression against a fixed set of values.

## Syntax

```
=SWITCH(expression, value1, result1, [value2, result2], ..., [default])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| expression | Required | The value or expression to compare against the list of values. |
| value1 | Required | The first value to compare against expression. |
| result1 | Required | The result to return if expression matches value1. |
| value2, result2 | Optional | Additional value/result pairs. Up to 126 pairs can be specified. |
| default | Optional | The value to return if no match is found. Must be the final argument with no corresponding result. If omitted and no match is found, #N/A is returned. |

## Remarks

- The expression is compared to each value in order. Only the first match is used.
- If no match is found and no default is provided, the function returns #N/A.
- SWITCH performs exact matching only; it does not support wildcards or partial matches.

## Example

| | A | B |
|---|---|---|
| 1 | **Day Number** | **Day Name** |
| 2 | 1 | =SWITCH(A2, 1, "Monday", 2, "Tuesday", 3, "Wednesday", 4, "Thursday", 5, "Friday", "Weekend") |
| 3 | 4 | =SWITCH(A3, 1, "Monday", 2, "Tuesday", 3, "Wednesday", 4, "Thursday", 5, "Friday", "Weekend") |
| 4 | 6 | =SWITCH(A4, 1, "Monday", 2, "Tuesday", 3, "Wednesday", 4, "Thursday", 5, "Friday", "Weekend") |

**Result:** Cell B2 returns **"Monday"**, cell B3 returns **"Thursday"**, and cell B4 returns **"Weekend"**.

The value 1 matches the first value/result pair, returning "Monday". The value 4 matches the fourth pair, returning "Thursday". The value 6 does not match any listed value, so the default value "Weekend" is returned.
