---
name: excel
description: Excel workbooks with openpyxl. Use when reading, creating, or editing .xlsx/.xlsm files, extracting spreadsheet data, or writing formulas, formatting, and charts.
---

The container has `openpyxl` 3.0.9 from Debian (`import openpyxl`). There is no LibreOffice, no `xlrd` and no Excel, so nothing can recalculate formulas or open legacy files.

## Formulas

- openpyxl stores formulas as strings and never evaluates them.
- `load_workbook(p)` returns the formula text (`"=A2+B2"`). `load_workbook(p, data_only=True)` returns the value Excel last cached when it saved the file.
- A file written by openpyxl has no cached values, so reading it back with `data_only=True` gives `None`. If you need the numbers, compute them in Python. Write the formula as well when the user expects a live sheet.
- Never save a workbook that was loaded with `data_only=True`. Saving replaces every formula with its cached value.

## Editing an existing file

- Save to a new path, and overwrite the original only when the user asks. Loading and saving drops what openpyxl cannot model: shapes, form controls, slicers, and external-link caches. Macros are dropped too, unless the file is `.xlsm` loaded with `keep_vba=True`.
- `.xls` raises `InvalidFileException`. Ask the user to re-save it as `.xlsx`.

## Reading data

- For large files, use `load_workbook(p, read_only=True)` with `ws.iter_rows(values_only=True)`, then `wb.close()`. For large writes, use `Workbook(write_only=True)` and `ws.append(row)`.
- Dates read back as `datetime`, even for date-only cells. Whether a cell displays as a date, percent or currency depends only on `cell.number_format` (`"yyyy-mm-dd"`, `"0.00%"`, `'#,##0.00 "€"'`).
- A merged range keeps its value in the top-left cell. The other cells read as `None`.
- `ws.max_row` and `ws.max_column` count formatted empty cells too, so find the real data extent by scanning.

## Layout

Column widths are not automatic: set `ws.column_dimensions["A"].width`. Freeze the header row with `ws.freeze_panes = "A2"`.

Verify by reloading the saved file and printing the cells you changed.
