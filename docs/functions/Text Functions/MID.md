# MID

Returns a specified number of characters from the middle of a text string, starting at the position you specify.

## Syntax

```
MID(text, start_pos, num_chars)
```

### Parameters

| Parameter | Definition |
|-----------|------------|
| `text` | The text string from which to extract characters. |
| `start_pos` | The position of the first character to extract, 1-based. |
| `num_chars` | The number of characters to extract. |

## Return value

A text string of `num_chars` characters from `text`, starting at `start_pos`.

## Remarks

- Generates a SQL `SUBSTRING(text FROM start_pos FOR num_chars)` expression internally.
- Positions are 1-based, consistent with DAX conventions.
- If `start_pos` is greater than the length of `text`, an empty string is returned.
- If `start_pos` plus `num_chars` exceeds the length of `text`, all characters from `start_pos` to the end are returned.
- If `text` is NULL, the result is NULL.

## Example 1: Extract subcategory code

Extract 3 characters starting at position 4 from a product number.

```
DEFINE SubCode = MID(dim_product[productnumber], 4, 3)
```

## Example 2: Extract year from a date string

Pull the 4-digit year from a date formatted as "DD-MM-YYYY".

```
DEFINE YearPart = MID(dim_date[datestring], 7, 4)
```

## See also

- [LEFT](LEFT.md) -- extract characters from the start of text
- [RIGHT](RIGHT.md) -- extract characters from the end of text
- [FIND](FIND.md) -- find the position of text within another string
- [LEN](LEN.md) -- return the length of a text string
- [REPLACE](REPLACE.md) -- replace characters by position
