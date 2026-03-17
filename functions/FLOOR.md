# FLOOR function

## Introduction
The FLOOR function rounds a number down to the nearest multiple of a specified significance value. It is useful for pricing (rounding down to the nearest nickel or dollar), time bucketing (rounding to the nearest 15-minute interval), and inventory management (rounding down to the nearest case quantity). FLOOR always rounds toward zero.

## Syntax
```
=FLOOR(number, significance)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to round down. |
| significance | Required | The multiple to which you want to round down. |

## Remarks
- If **significance** is 0, FLOOR returns a #DIV/0! error.
- Both **number** and **significance** must have the same sign; otherwise, FLOOR returns a #NUM! error.
- FLOOR rounds toward zero: positive numbers get smaller, negative numbers become less negative.
- FLOOR(number, 1) is equivalent to INT(number) for positive numbers.

## Example

| | A | B |
|---|---|---|
| 1 | **Price** | **Rounded Down to $0.50** |
| 2 | 7.83 | =FLOOR(A2, 0.5) |
| 3 | 12.10 | =FLOOR(A3, 0.5) |

**Results:**
- B2: 7.50 (7.83 rounded down to the nearest $0.50)
- B3: 12.00 (12.10 rounded down to the nearest $0.50)

The formula ensures prices are rounded down to the nearest half-dollar increment.
