# LET function

## Introduction
The LET function assigns names to intermediate calculation results, allowing you to store values or expressions under meaningful names and then use those names in a final calculation. This improves formula readability and performance by avoiding repeated evaluation of the same sub-expression.

LET is particularly useful in complex formulas where the same value or lookup result is used multiple times. By calculating it once and assigning it a name, the formula becomes both faster and easier to understand.

## Syntax
```
=LET(name1, name_value1, calculation_or_name2, [name_value2, calculation_or_name3], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| name1 | Required | The first name to assign. Must begin with a letter. Cannot conflict with cell reference syntax. |
| name_value1 | Required | The value or expression to assign to name1. |
| calculation_or_name2 | Required | Either the final calculation that uses the defined names and returns a result, or a second name to define (which then requires name_value2 and a subsequent calculation). |
| name_value2 | Optional | The value or expression to assign to name2 (if calculation_or_name2 is a second name). |
| calculation_or_name3 | Optional | Either the final calculation or a third name, following the same pattern. |

## Remarks
- The last argument must always be a calculation that returns a result. It cannot be a name definition.
- The total number of arguments must be odd (pairs of name/value plus one final calculation).
- Up to 126 name/value pairs can be defined in a single LET function.
- Names defined inside LET are scoped to that specific LET call and do not affect other formulas or the Name Manager.
- Variable names must start with a letter and cannot look like cell references (e.g., "A1" is not a valid name).

## Example 1 - Simple variable

| | A | B |
|---|---|---|
| 1 | **Value** | **Result** |
| 2 | 5 | =LET(x, A2, x + 1) |

**Result:** 6

The formula assigns the value of A2 (which is 5) to the name `x`, then returns `x + 1`.

## Example 2 - Avoiding repeated calculation

| | A | B |
|---|---|---|
| 1 | **Sales** | |
| 2 | 100 | |
| 3 | 200 | |
| 4 | 300 | |
| 5 | 150 | |
| 6 | **Result** | =LET(total, SUM(A2:A5), IF(total > 500, "Over budget", "Within budget")) |

**Result:** "Over budget"

The formula calculates `SUM(A2:A5)` once and assigns it to `total`, then uses `total` in the IF condition. Without LET, you would need to write `SUM(A2:A5)` twice.

## Example 3 - Multiple variables

| | A | B | C |
|---|---|---|---|
| 1 | **Price** | **Qty** | **Result** |
| 2 | 25.00 | 10 | =LET(subtotal, A2*B2, tax, subtotal*0.25, subtotal + tax) |

**Result:** 312.50

The formula defines `subtotal` as the product of price and quantity (250), then defines `tax` as 25% of the subtotal (62.50), and finally returns the sum (312.50).
