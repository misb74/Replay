import "./styles.css";
import { difference, initialInvoices, totalsMatch, type Invoice, type ReviewState } from "./invoices.js";

const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
let invoices: Invoice[] = initialInvoices.map((invoice) => ({ ...invoice }));
let selectedId = invoices[0]!.id;

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) throw new Error("Missing application root");
const app: HTMLElement = appElement;

function stateLabel(state: ReviewState): string {
  if (state === "approved") return "Approved";
  if (state === "flagged") return "Needs attention";
  return "Awaiting review";
}

function render(): void {
  const selected = invoices.find((invoice) => invoice.id === selectedId) ?? invoices[0]!;
  const matches = totalsMatch(selected);
  const delta = difference(selected);

  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="mark">N</span><span>Northstar Ledger</span></div>
      <span class="environment">Replay demo</span>
    </header>
    <section class="page-heading">
      <div><p class="eyebrow">Accounts payable</p><h1>Invoice review</h1></div>
      <p class="help">Compare each invoice with its purchase order, then approve matches or flag differences.</p>
    </section>
    <section class="workspace">
      <aside class="queue" aria-label="Invoice queue">
        <div class="queue-title"><h2>Review queue</h2><span>${invoices.filter((i) => i.state === "pending").length} pending</span></div>
        ${invoices.map((invoice) => `
          <button class="invoice-row ${invoice.id === selected.id ? "selected" : ""}" data-invoice-id="${invoice.id}" aria-pressed="${invoice.id === selected.id}">
            <span><strong>${invoice.id}</strong><small>${invoice.vendor}</small></span>
            <span class="status status-${invoice.state}">${stateLabel(invoice.state)}</span>
          </button>
        `).join("")}
      </aside>
      <article class="invoice-card" aria-label="Invoice details">
        <div class="card-heading">
          <div><p class="eyebrow">${selected.vendor}</p><h2>${selected.id}</h2></div>
          <span class="status status-${selected.state}" data-testid="review-state">${stateLabel(selected.state)}</span>
        </div>
        <div class="comparison">
          <div class="amount-panel"><span>Invoice total</span><strong data-testid="invoice-total">${money.format(selected.invoiceTotal)}</strong></div>
          <div class="compare-symbol" aria-hidden="true">${matches ? "=" : "≠"}</div>
          <div class="amount-panel"><span>${selected.purchaseOrder}</span><strong data-testid="po-total">${money.format(selected.purchaseOrderTotal)}</strong></div>
        </div>
        <div class="result ${matches ? "match" : "mismatch"}" data-testid="comparison-result">
          <span class="result-icon">${matches ? "✓" : "!"}</span>
          <div><strong>${matches ? "Totals match" : `Difference: ${money.format(Math.abs(delta))}`}</strong><p>${matches ? "This invoice is ready to approve." : "This invoice should be flagged for follow-up."}</p></div>
        </div>
        <dl class="metadata"><div><dt>Purchase order</dt><dd>${selected.purchaseOrder}</dd></div><div><dt>Due date</dt><dd>${selected.dueDate}</dd></div></dl>
        <div class="actions">
          <button class="secondary" data-action="flag">Flag difference</button>
          <button class="primary" data-action="approve">Approve invoice</button>
        </div>
      </article>
    </section>
  `;

  app.querySelectorAll<HTMLButtonElement>("[data-invoice-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedId = button.dataset.invoiceId ?? selectedId;
      render();
    });
  });
  app.querySelector<HTMLButtonElement>("[data-action='approve']")?.addEventListener("click", () => updateState(selected.id, "approved"));
  app.querySelector<HTMLButtonElement>("[data-action='flag']")?.addEventListener("click", () => updateState(selected.id, "flagged"));
}

function updateState(id: string, state: ReviewState): void {
  invoices = invoices.map((invoice) => invoice.id === id ? { ...invoice, state } : invoice);
  render();
}

render();
