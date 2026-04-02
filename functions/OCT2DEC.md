# OCT2DEC function

## Introduction
The OCT2DEC function converts an octal (base 8) number to its decimal (base 10) equivalent. This is commonly used in computing contexts where octal values need to be interpreted as standard decimal numbers.

## Syntax
```
=OCT2DEC(number)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The octal number you want to convert. Must not contain more than 10 characters (30 bits). The most significant bit is the sign bit; the remaining 29 bits are the magnitude. Negative numbers are represented using two's-complement notation. |

## Remarks
- If **number** is not a valid octal number (contains digits 8 or 9), OCT2DEC returns a #NUM! error.
- If **number** contains more than 10 characters, OCT2DEC returns a #NUM! error.

## Example

| | A | B |
|---|---|---|
| 1 | **Octal** | **Decimal** |
| 2 | 144 | =OCT2DEC(A2) |

**Result:** 100

The formula converts octal 144 to its decimal equivalent, 100.
