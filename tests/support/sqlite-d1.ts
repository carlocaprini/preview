import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export class BoundStatement {
  constructor(private readonly statement: StatementSync, private readonly values: unknown[] = []) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.statement, values);
  }

  async run() {
    const result = this.statement.run(...(this.values as Parameters<StatementSync["run"]>));
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...(this.values as Parameters<StatementSync["get"]>)) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      meta: { changes: 0 },
      results: this.statement.all(...(this.values as Parameters<StatementSync["all"]>)) as T[],
    };
  }
}

export class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  private batchTail: Promise<void> = Promise.resolve();

  constructor() {
    const migrations = fileURLToPath(new URL("../../migrations", import.meta.url));
    for (const name of readdirSync(migrations).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
      this.raw.exec(readFileSync(`${migrations}/${name}`, "utf8"));
    }
  }

  prepare(sql: string): BoundStatement {
    return new BoundStatement(this.raw.prepare(sql));
  }

  async batch(statements: BoundStatement[]) {
    const previous = this.batchTail;
    let release: () => void = () => undefined;
    this.batchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }
}
