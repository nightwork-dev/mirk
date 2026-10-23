// ─── The async transaction contract ─────────────────────────────────────────
// Dependency-free so the package root can export it. Adapters implement it over
// one backend connection; `@mirk/store/transaction` holds the shared coordinator.

/** A notification registered with {@link AsyncStoreTransactions.afterCommit}.
 *  A returned promise is not awaited; its rejection is absorbed like a throw. */
export type AfterCommitNotify = () => void;

/**
 * Short, database-only transactions over an async store adapter's connection.
 *
 * Every store operation of the adapter that runs inside `work` (including
 * `getVersioned` and `mutateAtomically`) joins the transaction and sees its
 * uncommitted writes.
 *
 * - A nested `transaction()` joins the outer one. If the inner `work` throws,
 *   only the inner writes roll back (a savepoint) and the outer transaction can
 *   still commit.
 * - Transactions on other adapter instances over the same database are
 *   serialized against an open transaction, so a versioned compare-and-set
 *   from another connection never succeeds against a version the open
 *   transaction has replaced.
 * - `afterCommit` callbacks run once each, in registration order, after the
 *   outermost transaction commits and before `transaction()` resolves. They
 *   run outside the transaction, so they may read the store or start a new
 *   transaction. A rollback, including the rollback of the nested transaction
 *   that registered a callback, discards it. A callback that throws does not
 *   stop the others or fail the commit.
 * - `afterCommit` is best effort. If the process dies between the commit and
 *   the callback, the notification is lost. Recover from durable state.
 * - Outside any transaction, `afterCommit` runs the callback immediately.
 */
export interface AsyncStoreTransactions {
  transaction<T>(work: () => T | Promise<T>): Promise<T>;
  afterCommit(notify: AfterCommitNotify): void;
}

