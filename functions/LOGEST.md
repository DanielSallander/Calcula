# LOGEST function

## Introduction
The LOGEST function performs exponential regression and returns an array of statistics describing the best-fit exponential curve (y = b * m^x). It is the exponential counterpart of LINEST and is useful for data that grows or decays by a constant percentage.

## Syntax
```
=LOGEST(known_y's, [known_x's], [const], [stats])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| known_y's | Required | The set of known y-values. Must be positive. |
| known_x's | Optional | The set of known x-values. Defaults to {1, 2, 3, ...}. |
| const | Optional | TRUE or omitted = calculate b normally, FALSE = force b to 1. |
| stats | Optional | FALSE or omitted = return only m and b, TRUE = return full regression statistics. |

## Remarks
- With stats=FALSE, returns a 1-row array: {m, b} for the equation y = b * m^x.
- With stats=TRUE, returns a 5-row array of regression statistics (same layout as LINEST).
- All known_y's values must be positive.
- For multiple independent variables, known_x's can have multiple columns.

## Example

| | A | B |
|---|---|---|
| 1 | **X** | **Y** |
| 2 | 1 | 10 |
| 3 | 2 | 20 |
| 4 | 3 | 40 |
| 5 | **Result** | =LOGEST(B2:B4, A2:A4) |

**Result:** {2, 5} (m = 2, b = 5, i.e., y = 5 * 2^x)
