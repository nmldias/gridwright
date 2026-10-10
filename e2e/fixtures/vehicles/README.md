# Synthetic vehicle-inventory fixtures

Every figure here is **synthetic** — invented for the companion's intake and monitoring tests. No
real vehicle, invoice, branch, price or VIN is represented; the VIN-like codes are not valid VINs.

The sequence tells one situation (capital tied up in stock at a Luanda branch) with facts withheld
until the right moment, so that each delivery exercises one intake decision:

| File | What it is | What it exercises |
|---|---|---|
| `inventory-2026-10-06.csv` | first snapshot, Primavera-style export: `;` delimiter, `24.150.009,00` numbers, `dd/mm/yyyy` dates, a `Total` row, a VIN with leading zeros, a 20-digit reference | parsing in the Portuguese locale, identifiers kept as text, totals set aside, a blank cost |
| `inventory-2026-10-13.csv` | next snapshot, ISO numbers and dates, one vehicle added, the Golf costed | the next period of the same series; the VIN overlap |
| `inventory-2026-10-13-corrected.csv` | the same period re-delivered with one cost corrected | a correction revises that period's evidence; it never counts twice |
| `inventory-2026-09-29.csv` | an older snapshot arriving late | kept as history; the current snapshot stands |
| `inventory-2026-10-13-benguela.csv` | identical columns, another branch, other vehicles | same columns are not the same entity — kept separate |
| `inventory-2026-10-20-partial.csv` | a partial delivery (two rows) | a coverage change suspends the trend comparison |
| `inventory-2026-10-20.xlsx` | the full 20 Oct snapshot as a workbook with a formula column | formulas reduced to values; an `.xlsx` through the same pipeline |
| `invoices-2026-10-15.xml` | supplier invoices as an XML record list | XML intake; a cost that disagrees with the inventory |
| `costs-2026-10-15.json` | landed-cost confirmations as JSON records | JSON intake; English-locale numbers |
| `notes-hostile.csv` | a file whose cells contain instruction-like text | cells are data: counted, inert |
| `ragged.csv` | a row wider than the header | quarantined, listed, never placed silently |

`expected.py` computes the reference figures independently of Gridwright (Python `Decimal`, no
rounding until display) and writes `expected.json`; `e2e/intake.py` compares the companion's
reading and the engine's formulas against it.
