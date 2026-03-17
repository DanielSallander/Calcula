# OR function

## Introduction

The OR function tests multiple conditions and returns TRUE if at least one of the conditions evaluates to TRUE. It returns FALSE only when all conditions are FALSE. This makes it the logical complement of the AND function, which requires all conditions to be TRUE.

OR is frequently used inside IF functions to trigger an action when any one of several criteria is met. For example, you might flag an order for review if it exceeds a dollar threshold OR comes from a new customer OR involves a restricted product. It is also commonly used in conditional formatting and data validation scenarios.

## Syntax

```
=OR(logical1, [logical2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| logical1 | Required | The first condition to evaluate. Must resolve to TRUE or FALSE. |
| logical2, ... | Optional | Additional conditions to evaluate. Up to 255 conditions can be provided. |

## Remarks

- All arguments must evaluate to logical values (TRUE or FALSE) or be references to cells containing logical values or numbers.
- Numeric values are interpreted as logical: 0 is FALSE, any non-zero value is TRUE.
- Text values that cannot be interpreted as logical values cause a #VALUE! error.
- If a range is provided, empty cells within the range are ignored.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Department** | **Overtime Hours** | **Review Needed** |
| 2 | Sales | 12 | =IF(OR(A2="Sales", B2>10), "Yes", "No") |
| 3 | Engineering | 4 | =IF(OR(A3="Sales", B3>10), "Yes", "No") |
| 4 | Engineering | 15 | =IF(OR(A4="Sales", B4>10), "Yes", "No") |

**Result:** Cell C2 returns **"Yes"** (Sales department), cell C3 returns **"No"** (neither condition met), and cell C4 returns **"Yes"** (overtime exceeds 10).

A review is needed if the employee is in the Sales department or has more than 10 overtime hours. Only the Engineering employee with 4 overtime hours in row 3 fails both conditions.
