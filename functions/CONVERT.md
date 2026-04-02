# CONVERT function

## Introduction
The CONVERT function converts a number from one measurement unit to another. It supports a wide range of unit categories including weight, distance, time, pressure, force, energy, power, magnetism, temperature, volume, area, information, and speed.

## Syntax
```
=CONVERT(number, from_unit, to_unit)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The value to convert. |
| from_unit | Required | The unit of **number**. A text string representing the source unit. |
| to_unit | Required | The unit to convert to. A text string representing the target unit. |

## Remarks
- If the input data types are incorrect, CONVERT returns a #VALUE! error.
- If the unit does not exist, CONVERT returns a #N/A error.
- If the units are in different categories (e.g., weight to distance), CONVERT returns a #N/A error.
- Unit strings are case-sensitive.
- Metric prefixes can be prepended to supported units (e.g., "km" for kilometers, "Mg" for megagrams).
- Common unit abbreviations include: "m" (meter), "kg" (kilogram), "lbm" (pound mass), "ft" (foot), "in" (inch), "mi" (mile), "C" (Celsius), "F" (Fahrenheit), "K" (Kelvin), "l" (liter), "gal" (gallon), "s" (second), "hr" (hour), "Pa" (Pascal), "atm" (atmosphere), "J" (Joule), "W" (Watt), "N" (Newton), "bit" (bit), "byte" (byte).

## Example

| | A | B |
|---|---|---|
| 1 | **Meters** | **Feet** |
| 2 | 100 | =CONVERT(A2, "m", "ft") |

**Result:** 328.0839895 (approximately)

The formula converts 100 meters to feet.
