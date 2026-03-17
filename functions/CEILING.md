# CEILING function

## Introduction
The CEILING function rounds a number up to the nearest multiple of a specified significance value. It is the counterpart of FLOOR and is useful for packaging calculations (rounding up to the nearest case size), billing increments (rounding up to the nearest billing unit), and time allocation (rounding up to the nearest quarter-hour).

## Syntax
```
=CEILING(number, significance)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to round up. |
| significance | Required | The multiple to which you want to round up. |

## Remarks
- If **significance** is 0, CEILING returns 0.
- Both **number** and **significance** must have the same sign; otherwise, CEILING returns a #NUM! error.
- CEILING rounds away from zero: positive numbers get larger, negative numbers become more negative.
- CEILING(number, 1) rounds up to the nearest integer for positive numbers.

## Example

| | A | B |
|---|---|---|
| 1 | **Minutes Worked** | **Billed (15-min increments)** |
| 2 | 42 | =CEILING(A2, 15) |
| 3 | 60 | =CEILING(A3, 15) |
| 4 | 7 | =CEILING(A4, 15) |

**Results:**
- B2: 45 (42 minutes rounded up to the nearest 15-minute billing increment)
- B3: 60 (already a multiple of 15, no change)
- B4: 15 (7 minutes rounded up to a minimum 15-minute billing block)
