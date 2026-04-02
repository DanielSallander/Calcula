# BITLSHIFT function

## Introduction
The BITLSHIFT function returns a number shifted left by the specified number of bits. Shifting left by n bits is equivalent to multiplying by 2^n. This is commonly used in low-level programming and binary data manipulation.

## Syntax
```
=BITLSHIFT(number, shift_amount)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | A non-negative integer. Must be greater than or equal to 0 and less than 2^48. |
| shift_amount | Required | An integer specifying the number of bits to shift left. A negative value shifts bits to the right instead. |

## Remarks
- If **number** is less than 0 or greater than or equal to 2^48 (281474976710656), BITLSHIFT returns a #NUM! error.
- If **shift_amount** causes the result to exceed 2^48, BITLSHIFT returns a #NUM! error.
- If **number** is not an integer, it is truncated.
- If either argument is non-numeric, BITLSHIFT returns a #VALUE! error.
- A negative **shift_amount** shifts bits to the right (equivalent to BITRSHIFT).

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Number** | **Shift** | **Result** |
| 2 | 4 | 2 | =BITLSHIFT(A2, B2) |

**Result:** 16

In binary, 4 is 100. Shifting left by 2 bits gives 10000, which equals 16 in decimal (equivalent to 4 * 2^2).
