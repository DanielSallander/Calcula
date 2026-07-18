# LEN

Returns the number of characters in a text string.

## Syntax

```
LEN(text)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string whose length to determine. |

## Return value

An integer representing the number of characters in `text`.

## Remarks

- Generates a SQL `LENGTH(text)` expression internally.
- Spaces are counted as characters.
- If `text` is NULL, the result is NULL.
- Use [TRIM](TRIM.md) before LEN if you want to exclude leading and trailing spaces from the count.

## Example 1: Get product name length

Return the character count of product names.

```
DEFINE NameLength = LEN(dim_product[name])
```

## Example 2: Filter by string length

Identify short product numbers (fewer than 5 characters).

```
DEFINE IsShortCode = IF(LEN(dim_product[productnumber]) < 5, "Short", "Standard")
```

## See also

- [LEFT](LEFT.md) -- extract characters from the start of text
- [RIGHT](RIGHT.md) -- extract characters from the end of text
- [MID](MID.md) -- extract characters from the middle of text
- [TRIM](TRIM.md) -- remove leading and trailing spaces
- [FIND](FIND.md) -- find position of text within another string
