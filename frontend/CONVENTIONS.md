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

## Tables – one way only (`@/components/table`)
Every table is described with the same `TableColumn` type, built with the `col` helpers:
`col.text | number | money | qty | percent | date | datetime | status | doc | custom(key, header, render)`.
Formatting (lakh grouping, AD/BS dates per user preference, status badges, right alignment) is applied centrally.

| Need | Component |
| --- | --- |
| Server-paginated list page with search, filters, sorting, export | `<ResourceList resource columns={[...]} dated filters exportUrl detailPath />` |
| Grid over data you already have / custom paging (AG Grid) | `<DataGrid columns rows ... />` |
| Any in-page table: document lines, allocations, statements, small lists, editable sheets | `<BaseTable columns rows footer? onRowClick? density? />` |

- Editable tables are BaseTable with `col.custom(...)` cells holding inputs.
- Totals rows: set `footer` on columns and pass `footer` to BaseTable.
- `sortable: true` only for fields in the API's `ordering_fields`; use `sortField` when it differs from `key`.
- Never write `<table>` or import AG Grid in feature code (enforced by `src/__tests__/ui-conventions.test.ts`).
- Import only from the barrel: `import { BaseTable, ResourceList, col } from "@/components/table"`.

## Forms – one way only (`@/components/form`)
- Page forms: `<BaseForm defaultValues onSubmit submitLabel onCancel>` with `<FormSection title columns>` blocks of
  `<FormField name label type required ... />`.
- Dialog forms: `<FormDialog open onOpenChange title defaultValues onSubmit>` with `<FormGrid>` + `<FormField>`.
- `FormField` types: `text, email, password, tel, number, money, percent, textarea, select (options), checkbox,
  date (AD/BS DatePicker), entity (EntitySelect: resource, params, optionLabel), custom (render)`.
- Name fields with the **API field names**; `onSubmit` just calls the API and throws on failure – BaseForm maps
  server field errors onto fields (use `errorFieldMap` when names differ), shows other errors, keeps submit state,
  and warns about unsaved changes on page forms.
- Several submit buttons: `submitActions={[{ key: "draft", label: "Save draft" }, { key: "post", label: "Post", primary: true }]}`;
  `onSubmit(values, form, intent)` receives the clicked key.
- Dialog-specific buttons beside Cancel/Save: `FormDialog footerActions={...}`.
- Payment method + cash/bank account + reference: `<PaymentMethodFields accountField="deposit_account" />`.
- Editable table cells inside a form: `CellInput` (`number` for amounts), `CellSelect`, `CellDate`, `CellEntity`, each bound
  to a field path such as `lines.3.quantity` and showing its own error; allocations: `AllocationField`.
- Watch values with `useWatch`, read/set with `useFormContext`, line arrays with `useFieldArray` (re-exported from `@/components/form`).
- Never write `<form>`, `useForm` or import `react-hook-form` in feature code (enforced by the same test).
- Small inline controls that are not a form (a filter, a single "as of" date, a search box) may use the plain
  inputs from `components/ui` directly.

## Visual language
- Components: `Button` (primary only for the main action of a screen), `Panel`, `PageHeader`, `KeyValues`, `Field`,
  `Input`/`NumberInput`/`Select`/`Textarea`, `StatusBadge`, `Badge`, `Alert`, `Dialog`, `ConfirmDialog`, `Tabs`, `Menu`.
- Dense, quiet, consistent: 13px body text, 32px controls, thin `border-line` borders, no gradients, no decorative
  icons in content, no emoji, no placeholder numbers. Money right-aligned with `formatAmount`, quantities with `formatQty`.
- Every list/detail handles loading (`LoadingBlock`), error (`ErrorState`) and empty (`EmptyState`) states.
- Copy is plain and specific ("Post invoice", "Record receipt"), never marketing language.
