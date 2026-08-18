---
name: "review-invoice"
description: "Approve an invoice only when its total matches the purchase order."
metadata:
  replay-workflow-id: "invoice-review"
  replay-workflow-revision: 2
---

# Review invoice

## Goal

Approve an invoice only when its total matches the purchase order.

## Inputs

| Name | Type | Required | Description | Recorded example |
| --- | --- | --- | --- | --- |
| `invoiceUrl` | url | yes | Invoice page to review | http://127.0.0.1:4173/invoices/1001 |

## Steps

- **Review the invoice totals** [^source-1]
  - Navigate to {{invoiceUrl}}
  - **Check:** The invoice and purchase-order totals are visible
  - **Decision:** If the invoice total matches the purchase-order total [^source-2]
    - **Then:**
      - **Approve the invoice** [^source-3]
        - Click Approve button (http://127.0.0.1:4173/invoices/1001)
        - **Check:** The invoice status is Approved
    - **Else:**
      - **Stop and flag:** The totals do not match [^source-4]

## Provenance

[^source-1]: `review` — recorded; demo@0:01.000–0:01.800
[^source-2]: `match` — narrated; demo@0:01.800–0:02.000
[^source-3]: `approve` — recorded; demo@0:02.000–0:02.500
[^source-4]: `flag` — narrated; demo@0:02.600
