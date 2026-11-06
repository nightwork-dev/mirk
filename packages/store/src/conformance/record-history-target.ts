import type { SyncStore } from "../types.js";
import type { JsonValue } from "../atomic.js";
import type { LogStore } from "../log/types.js";
import type { AsyncStoreTransactions } from "../transaction-types.js";

export function recordHistoryApi(kv: SyncStore, log: LogStore, transactions: AsyncStoreTransactions) {
  return {
    async changeRecordHistory(
      collection: string,
      id: string,
      stream: string,
      value: JsonValue,
      remove = false,
      failAfter = 0,
    ) {
      const rollback = new Error("rollback record and history");
      try {
        await transactions.transaction(() => {
          if (remove) kv.remove(collection, id);
          else kv.put(collection, { id, value });
          if (failAfter === 1) throw rollback;
          if (remove) log.deleteStream(stream);
          else log.append(stream, value);
          if (failAfter === 2) throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      return { record: kv.getById(collection, id), history: log.list(stream) };
    },
  };
}
