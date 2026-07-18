# REPT

Repeats a text string a specified number of times.

## Syntax

```
REPT(text, number_times)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string to repeat. |
| `number_times` | The number of times to repeat the text. Must be a non-negative integer. |

## Return value

A text string containing `text` repeated `number_times` times.

## Remarks

- Generates a SQL `REPEAT(text, number_times)` expression internally.
- If `number_times` is 0, an empty string is returned.
- If `text` is NULL, the result is NULL.
- Useful for building visual indicators or padding strings.

## Example 1: Build a simple bar indicator

Create a text bar of asterisks proportional to a value.

```
DEFINE Bar = REPT("*", ROUND(SUM(fact_sales[linetotal]) / 100000, 0))
```

## Example 2: Pad a string

Add leading zeros to create a fixed-width code.

```
DEFINE PaddedCode = CONCATENATE(REPT("0", 6 - LEN(dim_product[productnumber])), dim_product[productnumber])
```

## See also

- [CONCATENATE](CONCATENATE.md) -- join text strings
- [LEN](LEN.md) -- return the length of a text string
- [LEFT](LEFT.md) -- extract characters from the start of text
