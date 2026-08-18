import type { Workflow } from "../src/index.js";

export function validWorkflow(): Workflow {
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
        contentHash: "sha256:example",
      },
    },
    name: "Review invoice against PO",
    goal: "Approve an invoice only when its total matches the purchase order.",
    parameters: [
      {
        name: "invoiceUrl",
        type: "url",
        description: "The invoice to review",
        required: true,
        example: "http://127.0.0.1:4173/invoices/1001",
      },
      {
        name: "password",
        type: "secret",
        description: "Password for the invoice system",
        required: true,
        example: { param: "password", vault: true },
      },
    ],
    steps: [
      {
        kind: "step",
        id: "open-invoice",
        intent: "Open the invoice",
        actions: [
          {
            id: "navigate-invoice",
            type: "navigate",
            url: { param: "invoiceUrl", vault: false },
          },
          {
            id: "enter-password",
            type: "type",
            target: {
              description: "Password field",
              url: "http://127.0.0.1:4173/login",
              accessibility: {
                role: "AXSecureTextField",
                label: "Password",
                appBundleId: "com.google.Chrome",
              },
              screenshotCrop: {
                path: "sessions/demo/crops/password.png",
                capturedAtMs: 1_250,
              },
            },
            value: { param: "password", vault: true },
            secure: true,
          },
        ],
        expects: ["The invoice details are visible"],
        decisions: [
          {
            id: "totals-match",
            condition: "The invoice total matches the purchase-order total",
            confidence: "high",
            deterministicCheck: {
              kind: "visible",
              target: {
                description: "Totals match badge",
                url: "http://127.0.0.1:4173/invoices/1001",
                accessibility: { role: "AXStaticText", label: "Totals match" },
              },
            },
            then: [
              {
                kind: "step",
                id: "approve-invoice",
                intent: "Approve the matching invoice",
                actions: [
                  {
                    id: "click-approve",
                    type: "click",
                    target: {
                      description: "Approve button",
                      url: "http://127.0.0.1:4173/invoices/1001",
                      accessibility: { role: "AXButton", label: "Approve" },
                      dom: { testId: "approve-invoice" },
                      screenshotCrop: { path: "sessions/demo/crops/approve.png" },
                    },
                  },
                ],
                expects: ["The invoice is marked Approved"],
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
                id: "flag-mismatch",
                reason: "The totals do not match; flag the invoice for review",
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
