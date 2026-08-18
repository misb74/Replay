import { describe, expect, it } from "vitest";

import {
  WorkflowMigrationError,
  createWorkflowMigrator,
  loadWorkflow,
  migrateWorkflow,
} from "../src/index.js";
import { validWorkflow } from "./fixture.js";

describe("workflow migrations", () => {
  it("validates and returns an independent current-version document", () => {
    const source = validWorkflow();
    const migrated = migrateWorkflow(source);

    expect(migrated).toEqual(source);
    expect(migrated).not.toBe(source);
  });

  it("loads persisted documents through migration and validation", () => {
    const source = validWorkflow();

    expect(loadWorkflow(source)).toEqual(source);
    expect(() => loadWorkflow({ ...source, version: 2 })).toThrowError(
      expect.objectContaining({ code: "future-version" }),
    );
    expect(() => loadWorkflow({ version: 1 })).toThrow(/validation failed/u);
  });

  it("runs migrations sequentially without mutating the source", () => {
    const source = { version: 1, name: "before" };
    const migrate = createWorkflowMigrator(3, [
      {
        from: 1,
        to: 2,
        migrate(document) {
          return { ...document, version: 2, name: "middle" };
        },
      },
      {
        from: 2,
        to: 3,
        migrate(document) {
          return { ...document, version: 3, name: "after" };
        },
      },
    ]);

    expect(migrate(source)).toEqual({ version: 3, name: "after" });
    expect(source).toEqual({ version: 1, name: "before" });
  });

  it("fails clearly on missing, future, and unsupported versions", () => {
    const migrate = createWorkflowMigrator(2, []);

    expect(() => migrate({ name: "missing" })).toThrow(WorkflowMigrationError);
    expect(() => migrate({ version: 3 })).toThrow(/newer than supported/u);
    expect(() => migrate({ version: 1 })).toThrow(/No migration/u);
  });

  it("rejects a malformed migration chain at construction time", () => {
    expect(() =>
      createWorkflowMigrator(3, [
        {
          from: 1,
          to: 3,
          migrate(document) {
            return { ...document, version: 3 };
          },
        },
      ]),
    ).toThrow(/one-version increments/u);
  });

  it.each([
    [0, []],
    [1.5, []],
  ])("rejects invalid target version %s", (targetVersion, migrations) => {
    expect(() => createWorkflowMigrator(targetVersion, migrations)).toThrowError(
      expect.objectContaining({ code: "invalid-version" }),
    );
  });

  it.each([
    [{ from: 0, to: 1 }],
    [{ from: 1.5, to: 2.5 }],
    [{ from: 3, to: 4 }],
  ])("rejects an unusable migration registration: %o", ({ from, to }) => {
    expect(() => createWorkflowMigrator(3, [{
      from,
      to,
      migrate(document) {
        return { ...document, version: to };
      },
    }])).toThrowError(expect.objectContaining({ code: "invalid-migration-chain" }));
  });

  it("preserves a migration failure as the error cause", () => {
    const rootCause = new Error("broken transform");
    const migrate = createWorkflowMigrator(2, [{
      from: 1,
      to: 2,
      migrate() {
        throw rootCause;
      },
    }]);

    try {
      migrate({ version: 1 });
      throw new Error("Expected migration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowMigrationError);
      expect(error).toMatchObject({ code: "migration-failed", cause: rootCause });
    }
  });
});
