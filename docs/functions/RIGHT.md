# RIGHT

Returns the specified number of characters from the end of a text string.

## Syntax

```
RIGHT(text [, num_chars])
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string from which to extract characters. |
| `num_chars` | Optional. The number of characters to extract from the right. Defaults to 1. |

## Return value

A text string containing the last `num_chars` characters from `text`.

## Remarks

- Generates a SQL `RIGHT(text, num_chars)` expression internally.
- If `num_chars` is greater than the length of `text`, the entire string is returned.
- If `num_chars` is 0, an empty string is returned.
- If `text` is NULL, the result is NULL.

## Example 1: Extract suffix from a product number

Get the last 4 characters of a product number.

```
DEFINE ProductSuffix = RIGHT(dim_product[productnumber], 4)
```

## Example 2: Get last character

Extract the last character of a product name (default num_chars = 1).

```
DEFINE LastChar = RIGHT(dim_product[name])
```

## See also

- [LEFT](LEFT.md) -- extract characters from the start of text
- [MID](MID.md) -- extract characters from the middle of text
- [LEN](LEN.md) -- return the length of a text string
- [FIND](FIND.md) -- find the position of text within another string
