import type { AsyncAtomicStore, JsonValue, StoreVersion } from '@mirk/store/atomic';
import type { AsyncStoreTransactions } from '@mirk/store/transaction';
import type { AsyncLogStore } from '@mirk/store/log';

export type JobState = 'queued' | 'leased' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
export interface JobRecord {
  id: string;
  schemaVersion: 2;
  activeKey: string | null;
  subject: string | null;
  kind: string | null;
  queue: string;
  payload: JsonValue;
  state: JobState;
  priority: number;
  enqueuedAt: number;
  availableAt: number;
  updatedAt: number;
  attempt: number;
  generation: number;
  ownerToken: string | null;
  expiresAt: number | null;
  checkpoint: JsonValue;
  cancellation: { requestedAt: number; generation: number } | null;
  result: JsonValue;
  error: JsonValue;
}
export interface VersionedJob { value: JobRecord; version: StoreVersion }
export interface JobClaim { jobId: string; ownerToken: string; generation: number }
export interface JobCommand { key: string }
export interface ClaimOptions extends JobCommand { leaseMs: number }
export interface EnqueueInput {
  id: string; queue: string; payload: JsonValue; priority?: number; availableAt?: number; subject?: string; kind?: string;
}
export interface StartInput extends Omit<EnqueueInput, 'id'> { key: string; id?: string }
export interface StartResult { started: boolean; job: VersionedJob }
export interface JobListOptions { queue?: string; subject?: string; kind?: string; state?: JobState; sortBy?: 'updatedAt' | 'enqueuedAt' | 'priority'; sortDir?: 'asc' | 'desc'; limit?: number }
export type BlockedDecision =
  | { state: 'queued'; availableAt: number }
  | { state: 'succeeded'; result: JsonValue }
  | { state: 'failed'; error: JsonValue }
  | { state: 'cancelled' };
export interface JobsOptions {
  store: AsyncAtomicStore;
  transactions: AsyncStoreTransactions;
  collection?: string;
  now?: () => number;
  token?: () => string;
  log?: AsyncLogStore & { deleteStream(stream: string): Promise<boolean> };
  deleteHistoryOnRemove?: boolean;
}
export type JobsErrorCode = 'invalid-input' | 'not-found' | 'conflict' | 'idempotency-conflict' | 'stale-claim' | 'cancel-requested' | 'not-blocked' | 'not-terminal';
export class JobsError extends Error {
  override readonly name = 'JobsError';
  constructor(readonly code: JobsErrorCode, message: string = code) { super(message); }
}
