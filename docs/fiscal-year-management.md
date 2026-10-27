# Fiscal-year management

## Model
* **Fiscal year**: name, code (used in document numbers, e.g. `2083/84`), start and end (stored AD, entered in AD
  or BS), period type, status, opening-balance status, closing status, created/approved/closed by and when.
* **Accounting periods** are generated from the fiscal year: BS months (default, Nepali practice), AD months or a
  single period. They can be regenerated only while no journal has been posted.
* Statuses: `DRAFT` → `ACTIVE` → (`CLOSING` when the next year is activated) → `CLOSED` → (`REOPENED`).
  Postings are allowed only in ACTIVE, CLOSING or REOPENED years and only in OPEN periods.
* Only one ACTIVE year per organisation (partial unique index). Overlapping years are rejected by the service and
  by a PostgreSQL exclusion constraint (`daterange(start, end, '[]') &&`). Different organisations may overlap.
* Nothing is hardcoded: a Nepali fiscal year (1 Shrawan – last day of Ashadh) is derived from the calendar data;
  the form offers a quick-fill for it and for AD calendar years.

## Posting guard
Every financial or stock posting calls `get_posting_period(organization, date)` inside its transaction:
1. finds the period containing the canonical AD date (error `no_period` if none);
2. locks the period and fiscal-year rows `FOR SHARE`;
3. rejects closed/draft years (`fiscal_year_closed`) and locked periods (`period_locked`);
4. returns the period; the journal stores `fiscal_year` and `period`; documents store `fiscal_year`.
A rejected posting leaves no partial changes. Draft documents receive their fiscal year when posted; posted
documents cannot be edited, so transactions are never silently moved between years.

## Period locking
Users with `fiscal.manage` lock periods (optional reason). Reopening a locked period needs `fiscal.reopen`, a
reason, and is recorded permanently in the audit trail. A period of a CLOSED year cannot be reopened until the
year itself is reopened.

## Document numbering
Policies per document type: prefix, separator, padding, reset (`FISCAL_YEAR`, `CALENDAR_AD`, `CALENDAR_BS`,
`CONTINUOUS`) and optional branch/warehouse code, e.g. `SI-2083/84-000001`, `PO/0001`, `SO-KTM-2083-000001`.
Numbers come from `core_documentsequence` via one atomic upsert; a rolled-back posting rolls back its number.
Orders get a number on creation; financial documents when posted.

## Year-end close
1. **Preview** (`GET /fiscal-years/:id/closing-preview/`, read-only): blockers (draft invoices, deliveries, GRNs,
   bills, returns, unposted vouchers, unapproved expenses, draft movements/counts/journals dated in the year; earlier
   years still open; trial balance; inventory account ≠ stock valuation; AR/AP control ≠ party ledgers) and warnings
   (transfers in transit, negative cash, GRNI balance, missing/non-contiguous next year), totals, cash and bank
   balances, the income/expense balances that will be closed and the net result.
2. **Close** (`POST …/close/` with the fiscal-year code typed as confirmation, permission `fiscal.close`): re-runs the
   preview under `FOR UPDATE` locks, posts a closing journal on the last day moving income and expense balances to
   Retained Earnings, locks every period, marks the year CLOSED and the next year's opening balances
   CARRIED_FORWARD, and stores the summary in `FiscalYearClosing`.
3. Balance-sheet balances carry forward automatically because balances are cumulative.
4. **Reopen** (`POST …/reopen/` with reason, permission `fiscal.reopen`): reverses the closing journal (dated on
   the year-end), marks the year REOPENED; periods stay locked until reopened individually.
5. A year is never closed automatically because its end date has passed.

Historical reports exclude year-end closing entries from profit and loss, so closed years remain comparable
(see the *Fiscal year comparison* and *Year-end summary* reports).

## Opening balances
For the first year, post customer and supplier opening balances from their screens (once, against Opening
Balance Equity; later corrections are journals), opening stock as an *Opening stock* movement, and other balances
as an *Opening balance* journal.
