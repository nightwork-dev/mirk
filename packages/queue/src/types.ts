import type { AsyncAtomicStore, JsonValue, StoreVersion } from '@mirk/store/atomic';
import type { AsyncStoreTransactions } from '@mirk/store/transaction';
import type { AsyncLogStore } from '@mirk/store/log';

export type ItemState = 'queued' | 'leased' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
export interface QueueItem {
  id: string;
  schemaVersion: 2;
  activeKey: string | null;
  subject: string | null;
  kind: string | null;
  queue: string;
  payload: JsonValue;
  state: ItemState;
  priority: number;
  enqueuedAt: number;
  availableAt: number;
  updatedAt: number;
  claimCount: number;
  generation: number;
  ownerToken: string | null;
  expiresAt: number | null;
  checkpoint: JsonValue;
  cancellation: { requestedAt: number; generation: number } | null;
  result: JsonValue;
  error: JsonValue;
}
export interface VersionedItem { value: QueueItem; version: StoreVersion }
export interface QueueClaim { itemId: string; ownerToken: string; generation: number }
export interface QueueCommand { key: string }
export interface ClaimOptions extends QueueCommand { leaseMs: number }
export interface EnqueueInput {
  id: string; queue: string; payload: JsonValue; priority?: number; availableAt?: number; subject?: string; kind?: string;
}
export interface StartInput extends Omit<EnqueueInput, 'id'> { key: string; id?: string }
export interface StartResult { started: boolean; item: VersionedItem }
export interface QueueListOptions { queue?: string; subject?: string; kind?: string; state?: ItemState; sortBy?: 'updatedAt' | 'enqueuedAt' | 'priority'; sortDir?: 'asc' | 'desc'; limit?: number }
export type BlockedDecision =
  | { state: 'queued'; availableAt: number }
  | { state: 'succeeded'; result: JsonValue }
  | { state: 'failed'; error: JsonValue }
  | { state: 'cancelled' };
export interface QueueOptions {
  store: AsyncAtomicStore;
  transactions: AsyncStoreTransactions;
  collection?: string;
  now?: () => number;
  token?: () => string;
  log?: AsyncLogStore & { deleteStream(stream: string): Promise<boolean> };
  deleteHistoryOnRemove?: boolean;
}
export type QueueErrorCode = 'invalid-input' | 'not-found' | 'conflict' | 'idempotency-conflict' | 'stale-claim' | 'cancel-requested' | 'not-blocked' | 'not-terminal';
export class QueueError extends Error {
  override readonly name = 'QueueError';
  constructor(readonly code: QueueErrorCode, message: string = code) { super(message); }
}
