import { describe, expect, it } from "vitest";
import { difference, initialInvoices, totalsMatch } from "./invoices.js";

describe("invoice decision rule", () => {
  it("identifies an exact total match", () => {
    expect(totalsMatch(initialInvoices[0]!)).toBe(true);
  });

  it("identifies a mismatch and retains the signed difference", () => {
    expect(totalsMatch(initialInvoices[1]!)).toBe(false);
    expect(difference(initialInvoices[1]!)).toBe(47.15);
  });

  it("allows sub-cent floating point noise", () => {
    expect(totalsMatch({ invoiceTotal: 10.0001, purchaseOrderTotal: 10 })).toBe(true);
  });
});
