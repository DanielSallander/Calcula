# SIGN function

## Introduction
The SIGN function returns the sign of a number, indicating whether it is positive, negative, or zero. It returns 1 for positive numbers, -1 for negative numbers, and 0 for zero. SIGN is useful in conditional logic, determining the direction of a change (increase vs. decrease), and normalizing values to their directional component without magnitude.

## Syntax
```
=SIGN(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number whose sign you want to determine. |

## Remarks
- SIGN returns only three possible values: 1, 0, or -1.
- If **number** is non-numeric, SIGN returns a #VALUE! error.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Month** | **Profit/Loss** | **Trend** |
| 2 | January | 12500 | =SIGN(B2) |
| 3 | February | -3400 | =SIGN(B3) |
| 4 | March | 0 | =SIGN(B4) |

**Results:**
- C2: 1 (positive -- profit)
- C3: -1 (negative -- loss)
- C4: 0 (break-even)

The SIGN function quickly classifies each month's result as profit (1), loss (-1), or break-even (0), which can then be used in conditional formatting or further analysis.
