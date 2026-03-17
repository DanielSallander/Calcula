# IFS function

## Introduction

The IFS function checks multiple conditions in order and returns the value corresponding to the first condition that evaluates to TRUE. It eliminates the need for deeply nested IF statements, making your formulas easier to read, write, and maintain.

Use IFS when you have several mutually exclusive conditions to evaluate, such as assigning grade letters based on score ranges, categorizing data into tiers, or mapping status codes to descriptive labels. IFS evaluates conditions from left to right and stops at the first TRUE result.

## Syntax

```
=IFS(logical_test1, value_if_true1, [logical_test2, value_if_true2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| logical_test1 | Required | The first condition to evaluate. |
| value_if_true1 | Required | The value to return if logical_test1 is TRUE. |
| logical_test2, value_if_true2 | Optional | Additional condition/value pairs. Up to 127 pairs can be specified. |

## Remarks

- Arguments must be provided in pairs (condition, value). An odd number of arguments produces an error.
- If no condition evaluates to TRUE, the function returns a #N/A error. To provide a default value, use TRUE as the last condition (e.g., `TRUE, "Default"`).
- Conditions are evaluated in order; only the first TRUE condition's value is returned.

## Example

| | A | B |
|---|---|---|
| 1 | **Score** | **Grade** |
| 2 | 92 | =IFS(A2>=90, "A", A2>=80, "B", A2>=70, "C", A2>=60, "D", TRUE, "F") |
| 3 | 75 | =IFS(A3>=90, "A", A3>=80, "B", A3>=70, "C", A3>=60, "D", TRUE, "F") |
| 4 | 48 | =IFS(A4>=90, "A", A4>=80, "B", A4>=70, "C", A4>=60, "D", TRUE, "F") |

**Result:** Cell B2 returns **"A"**, cell B3 returns **"C"**, and cell B4 returns **"F"**.

The score 92 meets the first condition (>=90), so "A" is returned. The score 75 fails the first two conditions but meets >=70, returning "C". The score 48 fails all specific conditions, so the final TRUE catch-all returns "F".
