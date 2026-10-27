# Reference review

The brief asked for the three products below to be studied for workflow and interaction patterns (not branding).
This records what was actually accessible on 26 Oct 2026 and how it influenced the design.

| Reference | What was accessible | Notes |
| --- | --- | --- |
| Zoho Inventory demo (zoho.com/inventory/inventory-software-demo) | Only a browser-compatibility gate ("Your current browser version does not support inventory"); the application did not load for the fetching client. | No screens could be inspected. The design draws on the stated purpose: item, sales order, purchase order, customer/supplier, document workflow and transaction list/detail patterns. |
| ScienceSoft custom inventory demo | Only the page title was returned; the dashboard itself was not accessible. | Applied the stated purpose: a dashboard focused on stock status and operations, kept to real figures. |
| AG Grid inventory example (ag-grid.com/example-inventory) | A short description: stock tracking, inline editing, status filtering, sorting. | Used AG Grid **Community** only (no Enterprise features): server-side paging through our own pager, sortable columns mapped to API ordering, column visibility/resizing, compact rows, status filters, keyboard row opening. Inline editing is limited to count sheets and line editors that save through validated endpoints. |

Nothing here copies logos, text, layouts or proprietary assets from these products.
