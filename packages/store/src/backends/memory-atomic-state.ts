import type { AtomicCompletedMutationResult, StoreVersion } from "../atomic.js";
import { isReceiptExpired, RECEIPT_PRUNE_BATCH } from "../atomic.js";

type Receipt = {
  requestDigest: string;
  result: AtomicCompletedMutationResult & { status: "applied" };
  createdAt: number;
};

export class MemoryAtomicState {
  versions = new Map<string, StoreVersion>();
  receipts = new Map<string, Receipt>();
  private nextVersionNumber = 1;

  constructor(
    private readonly versionPrefix: string,
    private readonly receiptRetentionMs: number | undefined,
    private readonly now: () => number,
  ) {}

  newVersion(): StoreVersion {
    return `${this.versionPrefix}-v${this.nextVersionNumber++}` as StoreVersion;
  }

  readReceipt(key: string, now: number): Receipt | undefined {
    const receipt = this.receipts.get(key);
    if (!receipt) return undefined;
    return isReceiptExpired(receipt.createdAt, now, this.receiptRetentionMs) ? undefined : receipt;
  }

  writeReceipt(key: string, now: number, receipt: Omit<Receipt, "createdAt">): void {
    this.receipts.delete(key);
    this.receipts.set(key, { ...receipt, createdAt: now });
  }

  pruneReceiptBatch(now: number): number {
    if (this.receiptRetentionMs === undefined) return 0;
    let removed = 0;
    for (const [key, receipt] of this.receipts) {
      if (removed >= RECEIPT_PRUNE_BATCH) break;
      if (!isReceiptExpired(receipt.createdAt, now, this.receiptRetentionMs)) break;
      this.receipts.delete(key);
      removed += 1;
    }
    return removed;
  }

  pruneExpiredReceipts(): number {
    if (this.receiptRetentionMs === undefined) return 0;
    const now = this.now();
    let removed = 0;
    for (const [key, receipt] of this.receipts) {
      if (isReceiptExpired(receipt.createdAt, now, this.receiptRetentionMs)) {
        this.receipts.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
