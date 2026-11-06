"""Shared memory and SQLite transactions for short storage work."""

# pyright: reportPrivateUsage=false

from __future__ import annotations

import asyncio
import inspect
import sqlite3
import threading
import weakref
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from copy import deepcopy
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from .coordination_memory import MemoryCoordinationState

from .log import InMemoryLogStore, _caller
from .memory import InMemoryStore

T = TypeVar("T")

_sqlite_domains: weakref.WeakValueDictionary[int, SqliteTransactions] = (
    weakref.WeakValueDictionary()
)


def check_sqlite_caller(db: sqlite3.Connection) -> None:
    domain = _sqlite_domains.get(id(db))
    if domain is not None:
        domain.check()


class TransactionScopeError(RuntimeError):
    """A caller reached an active transaction owned by another task or thread."""


class _Scope:
    def __init__(self, owner: tuple[int, object], parent: _Scope | None) -> None:
        self.owner = owner
        self.parent = parent
        self.active = True
        self.callbacks: list[Callable[[], Any]] = []
        self.rollback_callbacks: list[Callable[[], None]] = []
        self.state: Any = None


class Transactions:
    def __init__(self) -> None:
        self._context: ContextVar[_Scope | None] = ContextVar("mirk_transaction", default=None)
        self._owner: tuple[int, object] | None = None
        self._lock = threading.Lock()

    def check(self) -> None:
        scope = self._context.get()
        if scope is not None and not scope.active:
            raise TransactionScopeError("The transaction has ended")
        if self._owner is not None and self._owner != _caller():
            raise TransactionScopeError(
                "Store is inside a transaction owned by another task or thread"
            )

    def available(self) -> bool:
        scope = self._context.get()
        if scope is not None and not scope.active:
            raise TransactionScopeError("The transaction has ended")
        return self._owner is None or self._owner == _caller()

    def transaction(self) -> _TransactionContext:
        return _TransactionContext(self)

    def after_commit(self, callback: Callable[[], Any]) -> None:
        self.check()
        scope = self._context.get()
        if scope is not None and scope.owner == _caller():
            scope.callbacks.append(callback)
        else:
            _deliver([callback])

    def after_rollback(self, callback: Callable[[], None]) -> None:
        self.check()
        scope = self._context.get()
        if scope is not None and scope.owner == _caller():
            scope.rollback_callbacks.append(callback)

    async def run_operation(self, work: Callable[[], Awaitable[T]]) -> T:
        while self._owner is not None and self._owner != _caller():
            await asyncio.sleep(0.001)
        self.check()
        return await work()

    def _begin(self, scope: _Scope) -> None:
        raise NotImplementedError

    def _commit(self, scope: _Scope) -> None:
        raise NotImplementedError

    def _rollback(self, scope: _Scope) -> None:
        raise NotImplementedError


class _TransactionContext:
    def __init__(self, domain: Transactions) -> None:
        self.domain = domain
        self.scope: _Scope | None = None
        self.token: Any = None

    def _parent(self) -> _Scope | None:
        parent = self.domain._context.get()
        if parent is not None and parent.owner == _caller():
            self.domain.check()
            return parent
        return None

    def _enter(self, parent: _Scope | None) -> None:
        scope = _Scope(_caller(), parent)
        try:
            self.domain._begin(scope)
        except BaseException:
            if parent is None:
                self.domain._lock.release()
            raise
        self.scope = scope
        self.domain._owner = scope.owner
        self.token = self.domain._context.set(scope)

    def __enter__(self) -> Transactions:
        parent = self._parent()
        if parent is None:
            self.domain.check()
            self.domain._lock.acquire()
        self._enter(parent)
        return self.domain

    async def __aenter__(self) -> Transactions:
        parent = self._parent()
        if parent is None:
            while not self.domain._lock.acquire(blocking=False):
                await asyncio.sleep(0.001)
        self._enter(parent)
        return self.domain

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        scope = self.scope
        assert scope is not None
        committed = False
        try:
            if exc_type is None:
                try:
                    self.domain._commit(scope)
                except BaseException:
                    self.domain._rollback(scope)
                    _rolled_back(scope)
                    raise
                committed = True
            else:
                self.domain._rollback(scope)
                _rolled_back(scope)
        finally:
            scope.active = False
            self.domain._context.reset(self.token)
            if scope.parent is None:
                self.domain._owner = None
                self.domain._lock.release()
        if committed:
            if scope.parent is not None:
                scope.parent.callbacks.extend(scope.callbacks)
                scope.parent.rollback_callbacks.extend(scope.rollback_callbacks)
            else:
                _deliver(scope.callbacks)

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.__exit__(exc_type, exc, traceback)


def _rolled_back(scope: _Scope) -> None:
    _deliver(list(reversed(scope.rollback_callbacks)))


def _deliver(callbacks: list[Callable[[], Any]]) -> None:
    for callback in callbacks:
        try:
            result = callback()
            if inspect.isawaitable(result):
                task = asyncio.ensure_future(result)
                task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        except Exception:
            pass


class MemoryTransactions(Transactions):
    def __init__(
        self,
        *,
        kv: InMemoryStore,
        log: InMemoryLogStore,
        coordination: MemoryCoordinationState | None = None,
    ) -> None:
        super().__init__()
        if getattr(kv, "_transaction_domain", None) or getattr(log, "_transaction_domain", None):
            raise ValueError("A memory store already belongs to a transaction domain")
        if coordination is not None and coordination._transaction_domain is not None:
            raise ValueError("Memory coordination state already belongs to a transaction domain")
        self.coordination = coordination
        if coordination is not None:
            coordination._transaction_domain = self
        self.kv = kv
        self.log = log
        kv._transaction_domain = self
        log._transaction_domain = self

    def _begin(self, scope: _Scope) -> None:
        self.log._check_caller()
        scope.state = deepcopy(
            (
                self.kv._kv,
                self.kv._collections,
                self.kv._versions,
                self.kv._receipts,
                self.log._transaction_checkpoint(),
                self.coordination._transaction_checkpoint() if self.coordination else None,
            )
        )

    def _commit(self, scope: _Scope) -> None:
        pass

    def _rollback(self, scope: _Scope) -> None:
        (
            self.kv._kv,
            self.kv._collections,
            self.kv._versions,
            self.kv._receipts,
            log_state,
            coordination_state,
        ) = scope.state
        self.log._transaction_restore(log_state)
        if self.coordination is not None:
            self.coordination._transaction_restore(coordination_state)


def create_memory_transactions(
    *, kv: InMemoryStore, log: InMemoryLogStore, coordination: MemoryCoordinationState | None = None
) -> MemoryTransactions:
    return MemoryTransactions(kv=kv, log=log, coordination=coordination)


class SqliteTransactions(Transactions):
    def __init__(self, handle: object) -> None:
        super().__init__()
        from .sqlite import connection_of

        self.db = connection_of(handle)
        if id(self.db) in _sqlite_domains:
            raise ValueError("SQLite connection already belongs to a transaction domain")
        _sqlite_domains[id(self.db)] = self
        self._sequence = 0

    def _begin(self, scope: _Scope) -> None:
        if scope.parent is None:
            self.db.execute("BEGIN IMMEDIATE")
        else:
            self._sequence += 1
            scope.state = f"mirk_tx_{self._sequence}"
            self.db.execute(f"SAVEPOINT {scope.state}")

    def _commit(self, scope: _Scope) -> None:
        self.db.execute("COMMIT" if scope.parent is None else f"RELEASE SAVEPOINT {scope.state}")

    def _rollback(self, scope: _Scope) -> None:
        if scope.parent is None:
            self.db.execute("ROLLBACK")
        else:
            self.db.execute(f"ROLLBACK TO SAVEPOINT {scope.state}")
            self.db.execute(f"RELEASE SAVEPOINT {scope.state}")


class MemoryTransactionTarget:
    def memoryTransactionRollback(self) -> dict[str, object]:
        from .coordination_transaction_conformance import memory_transaction_rollback

        return asyncio.run(memory_transaction_rollback())


def conformance_target(backend: str, connection: object) -> object:
    if backend != "memory":
        raise ValueError("Memory transaction participation requires the memory backend")
    return MemoryTransactionTarget()
