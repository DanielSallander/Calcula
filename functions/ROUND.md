# ROUND function

## Introduction
The ROUND function rounds a number to a specified number of decimal places. It uses standard rounding rules: digits 5 and above round up, digits below 5 round down. ROUND is essential for financial reporting, invoice calculations, and any scenario where you need to control decimal precision.

## Syntax
```
=ROUND(number, num_digits)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to round. |
| num_digits | Required | The number of decimal places to round to. |

### num_digits behavior
- **Positive:** Rounds to the specified number of decimal places (e.g., 2 rounds to two decimal places).
- **Zero:** Rounds to the nearest integer.
- **Negative:** Rounds to the left of the decimal point (e.g., -1 rounds to the nearest 10, -2 to the nearest 100).

## Remarks
- ROUND always rounds 5 away from zero (e.g., 2.5 rounds to 3, -2.5 rounds to -3).
- For rounding that always goes up or always goes down, see ROUNDUP and ROUNDDOWN.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Rounded** |
| 2 | 3456.789 | =ROUND(A2, 2) |
| 3 | 3456.789 | =ROUND(A3, 0) |
| 4 | 3456.789 | =ROUND(A4, -2) |

**Results:**
- B2: 3456.79 (rounded to 2 decimal places)
- B3: 3457 (rounded to nearest integer)
- B4: 3500 (rounded to nearest hundred)
