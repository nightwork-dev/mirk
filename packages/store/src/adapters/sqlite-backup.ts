import { closeSync, openSync, unlinkSync } from "node:fs";
import { SqliteFormatError } from "../sql.js";
import type { SqliteDb, SqliteStatement } from "./sqlite-driver.js";

export interface BackupReader {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
export function sqliteSnapshot(
  source: SqliteDb,
  destination: string,
  open: (path: string) => BackupReader,
): void {
  const databases = source.prepare("PRAGMA database_list").all() as {
    name: string;
    file: string;
  }[];
  const file = databases.find((db) => db.name === "main")?.file;
  if (!file)
    throw new SqliteFormatError(
      "unsupported-backup",
      "Migration backups require a local file database",
    );
  sqliteFileSnapshot(file, destination, open);
}

export function sqliteFileSnapshot(
  file: string,
  destination: string,
  open: (path: string) => BackupReader,
): void {
  let reserved = false;
  let reader: BackupReader | undefined;
  try {
    closeSync(openSync(destination, "wx"));
    reserved = true;
    reader = open(file);
    reader.prepare("VACUUM main INTO ?").run(destination);
  } catch (error) {
    if (reserved) {
      try {
        unlinkSync(destination);
      } catch {}
    }
    throw new SqliteFormatError(
      "backup-failed",
      `Cannot create migration backup: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    reader?.close();
  }
}
