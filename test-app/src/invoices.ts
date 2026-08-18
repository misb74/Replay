export type ReviewState = "pending" | "approved" | "flagged";

export interface Invoice {
  id: string;
  vendor: string;
  purchaseOrder: string;
  invoiceTotal: number;
  purchaseOrderTotal: number;
  dueDate: string;
  state: ReviewState;
}

export const initialInvoices: readonly Invoice[] = [
  {
    id: "INV-1048",
    vendor: "Juniper Office Supply",
    purchaseOrder: "PO-8821",
    invoiceTotal: 1_284.4,
    purchaseOrderTotal: 1_284.4,
    dueDate: "2026-08-30",
    state: "pending",
  },
  {
    id: "INV-1049",
    vendor: "Harbour Freight Co.",
    purchaseOrder: "PO-8829",
    invoiceTotal: 972.15,
    purchaseOrderTotal: 925.0,
    dueDate: "2026-09-02",
    state: "pending",
  },
];

export function totalsMatch(invoice: Pick<Invoice, "invoiceTotal" | "purchaseOrderTotal">): boolean {
  return Math.abs(invoice.invoiceTotal - invoice.purchaseOrderTotal) < 0.005;
}

export function difference(invoice: Pick<Invoice, "invoiceTotal" | "purchaseOrderTotal">): number {
  return Math.round((invoice.invoiceTotal - invoice.purchaseOrderTotal) * 100) / 100;
}
