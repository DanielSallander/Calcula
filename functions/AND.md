# AND function

## Introduction

The AND function tests multiple conditions and returns TRUE only if all conditions evaluate to TRUE. If any single condition is FALSE, the function returns FALSE. This allows you to combine several logical tests into a single expression.

AND is most commonly used inside an IF function to apply multiple criteria simultaneously. For example, you might check whether a salesperson met their quota AND has been employed for more than one year before awarding a bonus. It is also useful in conditional formatting rules and data validation formulas where multiple criteria must be satisfied at once.

## Syntax

```
=AND(logical1, [logical2], ...)
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
| 1 | **Sales** | **Tenure (Years)** | **Bonus Eligible** |
| 2 | 120000 | 3 | =IF(AND(A2>=100000, B2>=2), "Yes", "No") |
| 3 | 95000 | 5 | =IF(AND(A3>=100000, B3>=2), "Yes", "No") |
| 4 | 110000 | 1 | =IF(AND(A4>=100000, B4>=2), "Yes", "No") |

**Result:** Cell C2 returns **"Yes"**, cell C3 returns **"No"**, and cell C4 returns **"No"**.

Only Alice (row 2) meets both conditions: sales of at least 100,000 and tenure of at least 2 years. Row 3 fails the sales condition, and row 4 fails the tenure condition.
