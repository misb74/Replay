import { CURRENT_WORKFLOW_VERSION, type Workflow } from "./types.js";
import { parseWorkflow } from "./validation.js";

export interface WorkflowMigration {
  readonly from: number;
  readonly to: number;
  migrate(document: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

export type MigrationErrorCode =
  | "missing-version"
  | "invalid-version"
  | "future-version"
  | "missing-migration"
  | "invalid-migration-chain"
  | "migration-failed";

export class WorkflowMigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowMigrationError";
    this.code = code;
  }
}

/** Add an entry here when version 2 is introduced. Version 1 is the first persisted format. */
export const WORKFLOW_MIGRATIONS: readonly WorkflowMigration[] = [];

function getVersion(document: unknown): number {
  if (typeof document !== "object" || document === null || !("version" in document)) {
    throw new WorkflowMigrationError(
      "missing-version",
      "Workflow documents must declare a numeric version.",
    );
  }
  const version = document.version;
  if (!Number.isInteger(version) || typeof version !== "number" || version < 1) {
    throw new WorkflowMigrationError(
      "invalid-version",
      "Workflow version must be a positive integer.",
    );
  }
  return version;
}

/**
 * Creates a pure, deterministic migration pipeline. It is public so every new
 * schema version can be tested before becoming the current version.
 */
export function createWorkflowMigrator(
  targetVersion: number,
  migrations: readonly WorkflowMigration[],
): (document: unknown) => Record<string, unknown> {
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new WorkflowMigrationError(
      "invalid-version",
      "The target workflow version must be a positive integer.",
    );
  }

  const byVersion = new Map<number, WorkflowMigration>();
  for (const migration of migrations) {
    if (
      !Number.isInteger(migration.from)
      || migration.from < 1
      || !Number.isInteger(migration.to)
      || migration.to > targetVersion
      || migration.to !== migration.from + 1
      || byVersion.has(migration.from)
    ) {
      throw new WorkflowMigrationError(
        "invalid-migration-chain",
        "Migrations must be unique, positive one-version increments ending at or before the target version.",
      );
    }
    byVersion.set(migration.from, migration);
  }

  return (document: unknown): Record<string, unknown> => {
    let version = getVersion(document);
    if (version > targetVersion) {
      throw new WorkflowMigrationError(
        "future-version",
        `Workflow version ${String(version)} is newer than supported version ${String(targetVersion)}.`,
      );
    }

    let current = structuredClone(document) as Record<string, unknown>;
    while (version < targetVersion) {
      const migration = byVersion.get(version);
      if (migration === undefined) {
        throw new WorkflowMigrationError(
          "missing-migration",
          `No migration is registered from workflow version ${String(version)}.`,
        );
      }
      try {
        current = migration.migrate(current);
      } catch (cause) {
        throw new WorkflowMigrationError(
          "migration-failed",
          `Migration ${String(migration.from)}→${String(migration.to)} failed.`,
          { cause },
        );
      }
      const migratedVersion = getVersion(current);
      if (migratedVersion !== migration.to) {
        throw new WorkflowMigrationError(
          "invalid-migration-chain",
          `Migration ${String(migration.from)}→${String(migration.to)} produced version ${String(migratedVersion)}.`,
        );
      }
      version = migratedVersion;
    }
    return current;
  };
}

const migrateToCurrent = createWorkflowMigrator(
  CURRENT_WORKFLOW_VERSION,
  WORKFLOW_MIGRATIONS,
);

export function migrateWorkflow(document: unknown): Workflow {
  return parseWorkflow(migrateToCurrent(document));
}

/**
 * Loads an untrusted persisted workflow through the complete compatibility
 * boundary: reject future versions, migrate older versions, then validate the
 * current schema. Use parseWorkflow only for documents already known to use
 * the current version.
 */
export function loadWorkflow(document: unknown): Workflow {
  return migrateWorkflow(document);
}
