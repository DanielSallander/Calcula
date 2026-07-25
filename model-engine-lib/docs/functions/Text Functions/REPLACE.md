# REPLACE

Replaces part of a text string with a different text string, based on position and length.

## Syntax

```
REPLACE(old_text, start_pos, num_chars, new_text)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `old_text` | The original text string. |
| `start_pos` | The position (1-based) of the first character to replace. |
| `num_chars` | The number of characters to replace starting from `start_pos`. |
| `new_text` | The text string to insert in place of the removed characters. |

## Return value

A text string with `num_chars` characters removed starting at `start_pos` and `new_text` inserted in their place.

## Remarks

- Generates a SQL `OVERLAY(old_text PLACING new_text FROM start_pos FOR num_chars)` expression internally.
- This is a positional replacement. To replace by matching text patterns, use [SUBSTITUTE](SUBSTITUTE.md) instead.
- Positions are 1-based, consistent with DAX conventions.
- If `num_chars` is 0, `new_text` is inserted at `start_pos` without removing any characters.
- If `old_text` is NULL, the result is NULL.

## Example 1: Replace a prefix in a product number

Replace the first 2 characters of a product number with a new prefix.

```
DEFINE NewProductNumber = REPLACE(dim_product[productnumber], 1, 2, "XX")
```

## Example 2: Insert text at a position

Insert a separator at position 4 without removing any characters.

```
DEFINE FormattedCode = REPLACE(dim_product[productnumber], 4, 0, "-")
```

## See also

- [SUBSTITUTE](SUBSTITUTE.md) -- replace text by matching content, not position
- [MID](MID.md) -- extract characters from the middle of text
- [LEFT](LEFT.md) -- extract characters from the start of text
- [CONCATENATE](CONCATENATE.md) -- join text strings
