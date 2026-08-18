import type { Workflow } from "@replay/ir";

export function approvedWorkflow(): Workflow {
  return {
    version: 1,
    metadata: {
      workflowId: "invoice-review",
      revision: 2,
      previousRevision: 1,
      createdAt: "2026-08-16T18:00:00.000Z",
      updatedAt: "2026-08-16T18:30:00.000Z",
      approval: {
        status: "approved",
        approvedAt: "2026-08-16T18:31:00.000Z",
        approvedBy: "user",
      },
    },
    name: "Review invoice",
    goal: "Approve an invoice only when its total matches the purchase order.",
    parameters: [
      {
        name: "invoiceUrl",
        type: "url",
        description: "Invoice page to review",
        required: true,
        example: "http://127.0.0.1:4173/invoices/1001",
      },
    ],
    steps: [
      {
        kind: "step",
        id: "review",
        intent: "Review the invoice totals",
        actions: [
          {
            id: "open",
            type: "navigate",
            url: { param: "invoiceUrl", vault: false },
          },
        ],
        expects: ["The invoice and purchase-order totals are visible"],
        decisions: [
          {
            id: "match",
            condition: "the invoice total matches the purchase-order total",
            confidence: "high",
            then: [
              {
                kind: "step",
                id: "approve",
                intent: "Approve the invoice",
                actions: [
                  {
                    id: "approve-click",
                    type: "click",
                    target: {
                      description: "Approve button",
                      url: "http://127.0.0.1:4173/invoices/1001",
                      accessibility: { role: "AXButton", label: "Approve invoice" },
                      dom: { selector: "[data-action='approve']" },
                      screenshotCrop: { path: "sessions/demo/crops/approve.png" },
                    },
                  },
                ],
                expects: ["The invoice status is Approved"],
                provenance: {
                  source: "recorded",
                  timestampRefs: [
                    { sessionId: "demo", startMs: 2_000, endMs: 2_500 },
                  ],
                },
              },
            ],
            else: [
              {
                kind: "stop_and_flag",
                id: "flag",
                reason: "The totals do not match",
                provenance: {
                  source: "narrated",
                  timestampRefs: [{ sessionId: "demo", startMs: 2_600 }],
                },
              },
            ],
            provenance: {
              source: "narrated",
              timestampRefs: [{ sessionId: "demo", startMs: 1_800, endMs: 2_000 }],
            },
          },
        ],
        provenance: {
          source: "recorded",
          timestampRefs: [{ sessionId: "demo", startMs: 1_000, endMs: 1_800 }],
        },
      },
    ],
  };
}
