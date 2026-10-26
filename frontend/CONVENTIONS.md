# Frontend conventions

These rules keep every module consistent. Read the reference implementation in
`src/features/sales/` (SalesOrders.tsx, Invoices.tsx, Receipts.tsx, SalesReturns.tsx, Deliveries.tsx) before adding a screen.

## Structure
- One file per business area in `src/features/<area>/`, exporting **named** page components
  (`XList`, `XForm`, `XDetail`). Routes are registered in `src/app/routes.tsx` with the `page()` lazy helper.
- API access only through `src/api/client.ts` (`api`, `errorMessage`, `fieldErrors`, `downloadFile`, `openPdf`)
  and `src/api/hooks.ts` (`useList`, `useOptions`, `useDetail`, `useGet`, `useDocumentAction`, `useApiMutation`).
- Server state lives in TanStack Query. Never keep a copy of server totals in local state; display what the API returns.

## Business rules in the UI
- The server is authoritative for totals, balances, numbering, fiscal year and permissions. Forms send inputs only
  (quantities, prices, dates, ids); previews (`computeTotals`) are labelled as previews.
- Hide actions the user's role cannot perform with `useAuth().can("<perm>")` (permission strings are in
  `backend/apps/users/roles.py`). The server re-checks every call.
- Posted documents are never edited or deleted. Offer **Reverse** (`ReverseAction`, reason required) instead.
- Significant actions (approve, reject, cancel, close, lock, year-end) use `ConfirmDialog`; actions that the audit
  trail must explain use `requireReason`.

## Dates (AD/BS)
- Every business date input is `<DatePicker value onChange />` from `@/calendar/DatePicker` (ISO AD string in/out).
  Never use `<input type="date">`.
- Display dates with `<DateText value={x.date} bs={x.date_bs} />`; in grids use `col.date(field, label, ctx)`.
- Today's business date: `todayIn(organization.timezone)` from `@/calendar/bs` – not `new Date()`.

## Lists
- Use `ResourceList` (server pagination/sort/filter, URL state, export). `dated` adds fiscal-year and AD/BS range
  filters (the API resolves `fiscal_year`, `date_from`, `date_to`). Column factories live in `components/data/columns.tsx`.
- `sortable: true` only on fields the API lists in `ordering_fields`.
- Export uses `exportUrl="/<resource>/export/"` (`?export=csv|xlsx`).

## Visual language
- Components: `Button` (primary only for the main action of a screen), `Panel`, `PageHeader`, `KeyValues`, `Field`,
  `Input`/`NumberInput`/`Select`/`Textarea`, `StatusBadge`, `Badge`, `Alert`, `Dialog`, `ConfirmDialog`, `Tabs`, `Menu`.
- Dense, quiet, consistent: 13px body text, 32px controls, thin `border-line` borders, no gradients, no decorative
  icons in content, no emoji, no placeholder numbers. Money right-aligned with `formatAmount`, quantities with `formatQty`.
- Every list/detail handles loading (`LoadingBlock`), error (`ErrorState`) and empty (`EmptyState`) states.
- Copy is plain and specific ("Post invoice", "Record receipt"), never marketing language.
