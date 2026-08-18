/**
 * JSON Schema is kept as executable TypeScript so validators and consumers use
 * the exact same artifact. It deliberately uses draft-07, which is supported
 * by Ajv without a custom meta-schema.
 */
export const workflowSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://replay.local/schemas/workflow-v1.schema.json",
  title: "Replay workflow",
  type: "object",
  additionalProperties: false,
  required: ["version", "metadata", "name", "goal", "parameters", "steps"],
  properties: {
    version: { const: 1 },
    metadata: { $ref: "#/$defs/metadata" },
    name: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    parameters: {
      type: "array",
      items: { $ref: "#/$defs/parameter" },
    },
    steps: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/step" },
    },
  },
  $defs: {
    inputReference: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["param", "vault"],
          properties: {
            param: { type: "string", minLength: 1 },
            vault: { const: false },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["param", "vault"],
          properties: {
            param: { type: "string", minLength: 1 },
            vault: { const: true },
          },
        },
      ],
    },
    scalar: {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
      ],
    },
    value: {
      anyOf: [
        { $ref: "#/$defs/scalar" },
        { $ref: "#/$defs/inputReference" },
      ],
    },
    stringValue: {
      anyOf: [
        { type: "string" },
        { $ref: "#/$defs/inputReference" },
      ],
    },
    parameter: {
      type: "object",
      additionalProperties: false,
      required: ["name", "type", "description", "required", "example"],
      properties: {
        name: {
          type: "string",
          minLength: 1,
          pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
        },
        type: {
          enum: ["string", "number", "boolean", "url", "date", "file", "secret"],
        },
        description: { type: "string", minLength: 1 },
        required: { type: "boolean" },
        example: { $ref: "#/$defs/value" },
      },
    },
    timestampReference: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "startMs"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        startMs: { type: "number", minimum: 0 },
        endMs: { type: "number", minimum: 0 },
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["source", "timestampRefs"],
      properties: {
        source: { enum: ["recorded", "narrated", "user-added-in-review"] },
        timestampRefs: {
          type: "array",
          items: { $ref: "#/$defs/timestampReference" },
        },
        note: { type: "string", minLength: 1 },
      },
    },
    rectangle: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "width", "height"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number", minimum: 0 },
        height: { type: "number", minimum: 0 },
      },
    },
    accessibilityTarget: {
      type: "object",
      additionalProperties: false,
      properties: {
        role: { type: "string", minLength: 1 },
        label: { type: "string", minLength: 1 },
        identifier: { type: "string", minLength: 1 },
        value: { type: "string" },
        appBundleId: { type: "string", minLength: 1 },
        windowTitle: { type: "string", minLength: 1 },
        bounds: { $ref: "#/$defs/rectangle" },
      },
      minProperties: 1,
      allOf: [
        {
          if: {
            required: ["role"],
            properties: { role: { const: "AXSecureTextField" } },
          },
          then: {
            properties: { value: false },
          },
        },
      ],
    },
    domTarget: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: { type: "string", minLength: 1 },
        testId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        attributes: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
      minProperties: 1,
    },
    screenshotCrop: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1 },
        capturedAtMs: { type: "number", minimum: 0 },
        bounds: { $ref: "#/$defs/rectangle" },
      },
    },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["description"],
      properties: {
        description: { type: "string", minLength: 1 },
        accessibility: { $ref: "#/$defs/accessibilityTarget" },
        url: { type: "string", minLength: 1 },
        dom: { $ref: "#/$defs/domTarget" },
        screenshotCrop: { $ref: "#/$defs/screenshotCrop" },
      },
    },
    clickAction: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "target"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { const: "click" },
        target: { $ref: "#/$defs/target" },
        button: { enum: ["left", "right", "middle"] },
        clickCount: { type: "integer", minimum: 1 },
      },
    },
    typeAction: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "target", "value"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { const: "type" },
        target: { $ref: "#/$defs/target" },
        value: { $ref: "#/$defs/stringValue" },
        clearFirst: { type: "boolean" },
        secure: { type: "boolean" },
      },
    },
    selectAction: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "target", "value"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { const: "select" },
        target: { $ref: "#/$defs/target" },
        value: { $ref: "#/$defs/stringValue" },
      },
    },
    navigateAction: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "url"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { const: "navigate" },
        url: { $ref: "#/$defs/stringValue" },
      },
    },
    scrollAction: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "direction"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { const: "scroll" },
        direction: { enum: ["up", "down", "left", "right"] },
        distance: { type: "number", exclusiveMinimum: 0 },
        target: { $ref: "#/$defs/target" },
      },
    },
    dragAction: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "from", "to"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { const: "drag" },
        from: { $ref: "#/$defs/target" },
        to: { $ref: "#/$defs/target" },
      },
    },
    keyAction: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "key"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { const: "key" },
        key: { type: "string", minLength: 1 },
        target: { $ref: "#/$defs/target" },
      },
      allOf: [
        {
          if: {
            required: ["target"],
            properties: {
              target: {
                type: "object",
                required: ["accessibility"],
                properties: {
                  accessibility: {
                    type: "object",
                    required: ["role"],
                    properties: { role: { const: "AXSecureTextField" } },
                  },
                },
              },
            },
          },
          then: {
            properties: {
              key: { not: { type: "string", pattern: "^[\\s\\S]$" } },
            },
          },
        },
      ],
    },
    waitAction: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { const: "wait" },
        durationMs: { type: "number", exclusiveMinimum: 0 },
        until: { type: "string", minLength: 1 },
      },
      anyOf: [
        { required: ["durationMs"], properties: { durationMs: {} } },
        { required: ["until"], properties: { until: {} } },
      ],
    },
    customAction: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "description"],
      properties: {
        id: { type: "string", minLength: 1 },
        type: { const: "custom" },
        description: { type: "string", minLength: 1 },
        target: { $ref: "#/$defs/target" },
      },
    },
    action: {
      oneOf: [
        { $ref: "#/$defs/clickAction" },
        { $ref: "#/$defs/typeAction" },
        { $ref: "#/$defs/selectAction" },
        { $ref: "#/$defs/navigateAction" },
        { $ref: "#/$defs/scrollAction" },
        { $ref: "#/$defs/dragAction" },
        { $ref: "#/$defs/keyAction" },
        { $ref: "#/$defs/waitAction" },
        { $ref: "#/$defs/customAction" },
      ],
    },
    deterministicCondition: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "target"],
      properties: {
        kind: { enum: ["visible", "hidden", "text-equals", "text-contains"] },
        target: { $ref: "#/$defs/target" },
        expected: { $ref: "#/$defs/stringValue" },
      },
      allOf: [
        {
          if: { properties: { kind: { enum: ["text-equals", "text-contains"] } } },
          then: { required: ["expected"], properties: { expected: {} } },
        },
      ],
    },
    expectationCheck: {
      type: "object",
      additionalProperties: false,
      required: ["expectation", "kind", "target"],
      properties: {
        expectation: { type: "string", minLength: 1 },
        kind: { enum: ["visible", "hidden", "text-equals", "text-contains"] },
        target: { $ref: "#/$defs/target" },
        expected: { $ref: "#/$defs/stringValue" },
      },
      allOf: [
        {
          if: { properties: { kind: { enum: ["text-equals", "text-contains"] } } },
          then: { required: ["expected"], properties: { expected: {} } },
        },
      ],
    },
    askUserNode: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id", "message", "provenance"],
      properties: {
        kind: { const: "ask_user" },
        id: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        provenance: { $ref: "#/$defs/provenance" },
      },
    },
    stopAndFlagNode: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id", "reason", "provenance"],
      properties: {
        kind: { const: "stop_and_flag" },
        id: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
        provenance: { $ref: "#/$defs/provenance" },
      },
    },
    branchNode: {
      oneOf: [
        { $ref: "#/$defs/step" },
        { $ref: "#/$defs/askUserNode" },
        { $ref: "#/$defs/stopAndFlagNode" },
      ],
    },
    decision: {
      type: "object",
      additionalProperties: false,
      required: ["id", "condition", "confidence", "then", "else", "provenance"],
      properties: {
        id: { type: "string", minLength: 1 },
        condition: { type: "string", minLength: 1 },
        confidence: { enum: ["low", "medium", "high"] },
        confidenceRationale: { type: "string", minLength: 1 },
        deterministicCheck: { $ref: "#/$defs/deterministicCondition" },
        then: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/branchNode" },
        },
        else: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/branchNode" },
        },
        provenance: { $ref: "#/$defs/provenance" },
      },
    },
    step: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id", "intent", "actions", "expects", "provenance"],
      properties: {
        kind: { const: "step" },
        id: { type: "string", minLength: 1 },
        intent: { type: "string", minLength: 1 },
        actions: {
          type: "array",
          items: { $ref: "#/$defs/action" },
        },
        expects: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        expectationChecks: {
          type: "array",
          items: { $ref: "#/$defs/expectationCheck" },
        },
        decisions: {
          type: "array",
          items: { $ref: "#/$defs/decision" },
        },
        provenance: { $ref: "#/$defs/provenance" },
      },
    },
    draftApproval: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { const: "draft" } },
    },
    approvedApproval: {
      type: "object",
      additionalProperties: false,
      required: ["status", "approvedAt", "approvedBy"],
      properties: {
        status: { const: "approved" },
        approvedAt: { type: "string", minLength: 1 },
        approvedBy: { const: "user" },
        contentHash: { type: "string", minLength: 1 },
      },
    },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["workflowId", "revision", "createdAt", "updatedAt", "approval"],
      properties: {
        workflowId: { type: "string", minLength: 1 },
        revision: { type: "integer", minimum: 1 },
        previousRevision: { type: "integer", minimum: 1 },
        createdAt: { type: "string", minLength: 1 },
        updatedAt: { type: "string", minLength: 1 },
        approval: {
          oneOf: [
            { $ref: "#/$defs/draftApproval" },
            { $ref: "#/$defs/approvedApproval" },
          ],
        },
      },
    },
  },
} as const;

export type WorkflowSchema = typeof workflowSchema;
