# BITRSHIFT function

## Introduction
The BITRSHIFT function returns a number shifted right by the specified number of bits. Shifting right by n bits is equivalent to integer division by 2^n. This is commonly used in low-level programming and binary data manipulation.

## Syntax
```
=BITRSHIFT(number, shift_amount)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | A non-negative integer. Must be greater than or equal to 0 and less than 2^48. |
| shift_amount | Required | An integer specifying the number of bits to shift right. A negative value shifts bits to the left instead. |

## Remarks
- If **number** is less than 0 or greater than or equal to 2^48 (281474976710656), BITRSHIFT returns a #NUM! error.
- If **number** is not an integer, it is truncated.
- If either argument is non-numeric, BITRSHIFT returns a #VALUE! error.
- A negative **shift_amount** shifts bits to the left (equivalent to BITLSHIFT).

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Number** | **Shift** | **Result** |
| 2 | 16 | 2 | =BITRSHIFT(A2, B2) |

**Result:** 4

In binary, 16 is 10000. Shifting right by 2 bits gives 100, which equals 4 in decimal (equivalent to 16 / 2^2).
