// ─── @mirk/store tests ────────────────────────────────────────────────────
// Same test suite runs against the InMemory and SQLite backends.
//
// Covers:
//   - KV operations: get, set, has, delete, keys with prefix
//   - Collection operations: list, getById, put, remove, count
//   - StoreFilter: where, sortBy, sortDir, limit, offset
//   - SQLite-specific: auto-table creation, JSON body column, concurrent reads

import { describe, it, expect, beforeEach } from 'vitest';
import type { SyncStore } from './types.js';
import { InMemoryKv, toAsync } from './kv.js';
import { SqliteAdapter } from './adapters/sqlite.js';

// ── Test Data ─────────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  category: string;
  priority: number;
}

function makeProject(
  id: string,
  name: string,
  category: string,
  priority: number,
): Project {
  return { id, name, category, priority };
}

const projects: Project[] = [
  makeProject('p1', 'Alpha', 'platform', 1),
  makeProject('p2', 'Beta', 'ai', 2),
  makeProject('p3', 'Gamma', 'tooling', 3),
  makeProject('p4', 'Delta', 'creative', 1),
  makeProject('p5', 'Epsilon', 'ai', 4),
];

// ── Shared Test Suite ─────────────────────────────────────────────────────

function storeTests(name: string, createStore: () => SyncStore) {
  describe(`${name} — KV Operations`, () => {
    let store: SyncStore;

    beforeEach(async () => {
      store = createStore();
    });

    it('get returns null for missing key', async () => {
      const val = store.get('nonexistent');
      expect(val).toBeNull();
    });

    it('set and get round-trip a string', async () => {
      store.set('greeting', 'hello');
      const val = store.get<string>('greeting');
      expect(val).toBe('hello');
    });

    it('set and get round-trip an object', async () => {
      const data = { name: 'test', count: 42, nested: { ok: true } };
      store.set('obj', data);
      const val = store.get<typeof data>('obj');
      expect(val).toEqual(data);
    });

    it('set overwrites existing value', async () => {
      store.set('key', 'first');
      store.set('key', 'second');
      const val = store.get<string>('key');
      expect(val).toBe('second');
    });

    it('has returns false for missing key', async () => {
      expect(store.has('ghost')).toBe(false);
    });

    it('has returns true for existing key', async () => {
      store.set('present', 1);
      expect(store.has('present')).toBe(true);
    });

    it('delete returns false for missing key', async () => {
      expect(store.delete('ghost')).toBe(false);
    });

    it('delete removes a key and returns true', async () => {
      store.set('doomed', 'bye');
      expect(store.delete('doomed')).toBe(true);
      expect(store.get('doomed')).toBeNull();
    });

    it('keys returns all keys', async () => {
      store.set('a:1', 'x');
      store.set('a:2', 'y');
      store.set('b:1', 'z');
      const all = store.keys();
      expect(all).toContain('a:1');
      expect(all).toContain('a:2');
      expect(all).toContain('b:1');
      expect(all.length).toBe(3);
    });

    it('keys with prefix filters correctly', async () => {
      store.set('ns:alpha', 1);
      store.set('ns:beta', 2);
      store.set('other:gamma', 3);
      const filtered = store.keys('ns:');
      expect(filtered.length).toBe(2);
      expect(filtered).toContain('ns:alpha');
      expect(filtered).toContain('ns:beta');
    });
  });

  describe(`${name} — Collection Operations`, () => {
    let store: SyncStore;

    beforeEach(async () => {
      store = createStore();
      // Seed projects
      for (const p of projects) {
        store.put('projects', p);
      }
    });

    it('list returns all items', async () => {
      const items = store.list<Project>('projects');
      expect(items.length).toBe(5);
    });

    it('getById returns the correct item', async () => {
      const item = store.getById<Project>('projects', 'p2');
      expect(item).not.toBeNull();
      expect(item!.name).toBe('Beta');
    });

    it('getById returns null for missing id', async () => {
      const item = store.getById<Project>('projects', 'p999');
      expect(item).toBeNull();
    });

    it('put creates a new item', async () => {
      const newItem = makeProject('p6', 'Zeta', 'creative', 2);
      const result = store.put('projects', newItem);
      expect(result.id).toBe('p6');
      const retrieved = store.getById<Project>('projects', 'p6');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('Zeta');
    });

    it('put updates an existing item', async () => {
      const updated = makeProject('p1', 'Alpha v2', 'platform', 0);
      store.put('projects', updated);
      const retrieved = store.getById<Project>('projects', 'p1');
      expect(retrieved!.name).toBe('Alpha v2');
      expect(retrieved!.priority).toBe(0);
    });

    it('remove deletes an item and returns true', async () => {
      expect(store.remove('projects', 'p3')).toBe(true);
      const retrieved = store.getById<Project>('projects', 'p3');
      expect(retrieved).toBeNull();
    });

    it('remove returns false for missing id', async () => {
      expect(store.remove('projects', 'p999')).toBe(false);
    });

    it('count returns total items', async () => {
      expect(store.count('projects')).toBe(5);
    });

    it('count returns 0 for empty collection', async () => {
      expect(store.count('empty_collection')).toBe(0);
    });

    it('list on empty collection returns empty array', async () => {
      const items = store.list('nothing');
      expect(items).toEqual([]);
    });
  });

  describe(`${name} — StoreFilter`, () => {
    let store: SyncStore;

    beforeEach(async () => {
      store = createStore();
      for (const p of projects) {
        store.put('projects', p);
      }
    });

    it('where filters by exact field match', async () => {
      const aiProjects = store.list<Project>('projects', {
        where: { category: 'ai' },
      });
      expect(aiProjects.length).toBe(2);
      expect(aiProjects.every((p) => p.category === 'ai')).toBe(true);
    });

    it('where filters by multiple fields', async () => {
      const results = store.list<Project>('projects', {
        where: { category: 'ai', priority: 2 },
      });
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe('Beta');
    });

    it('where with no matches returns empty', async () => {
      const results = store.list<Project>('projects', {
        where: { category: 'nonexistent' },
      });
      expect(results).toEqual([]);
    });

    it('where filters by boolean field', async () => {
      interface Flagged { id: string; name: string; pinned: boolean }
      store.put('flagged', { id: 'f1', name: 'A', pinned: true });
      store.put('flagged', { id: 'f2', name: 'B', pinned: false });
      store.put('flagged', { id: 'f3', name: 'C', pinned: true });

      const pinned = store.list<Flagged>('flagged', {
        where: { pinned: true },
      });
      expect(pinned.length).toBe(2);
      expect(pinned.every((f) => f.pinned === true)).toBe(true);

      const unpinned = store.list<Flagged>('flagged', {
        where: { pinned: false },
      });
      expect(unpinned.length).toBe(1);
      expect(unpinned[0]!.name).toBe('B');
    });

    it('sortBy sorts ascending by default', async () => {
      const sorted = store.list<Project>('projects', {
        sortBy: 'name',
      });
      const names = sorted.map((p) => p.name);
      expect(names).toEqual([...names].sort());
    });

    it('sortBy + sortDir desc sorts descending', async () => {
      const sorted = store.list<Project>('projects', {
        sortBy: 'priority',
        sortDir: 'desc',
      });
      const priorities = sorted.map((p) => p.priority);
      expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    });

    it('limit restricts result count', async () => {
      const limited = store.list<Project>('projects', { limit: 2 });
      expect(limited.length).toBe(2);
    });

    it('offset skips results', async () => {
      const all = store.list<Project>('projects', { sortBy: 'name' });
      const offset = store.list<Project>('projects', {
        sortBy: 'name',
        offset: 2,
      });
      expect(offset.length).toBe(3);
      expect(offset[0]!.name).toBe(all[2]!.name);
    });

    it('limit + offset paginates correctly', async () => {
      const all = store.list<Project>('projects', { sortBy: 'name' });
      const page = store.list<Project>('projects', {
        sortBy: 'name',
        limit: 2,
        offset: 1,
      });
      expect(page.length).toBe(2);
      expect(page[0]!.name).toBe(all[1]!.name);
      expect(page[1]!.name).toBe(all[2]!.name);
    });

    it('count respects where filter', async () => {
      const cnt = store.count('projects', {
        where: { category: 'ai' },
      });
      expect(cnt).toBe(2);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// INMEMORY
// ═══════════════════════════════════════════════════════════════════════════

storeTests('InMemoryKv', () => new InMemoryKv());

// ═══════════════════════════════════════════════════════════════════════════
// SQLITE
// ═══════════════════════════════════════════════════════════════════════════

storeTests('SqliteAdapter.kv', () => new SqliteAdapter({ path: ':memory:' }).kv);

// ── SQLite-Specific Tests ─────────────────────────────────────────────────

describe('SqliteAdapter.kv — Backend-Specific', () => {
  let adapter: SqliteAdapter;
  let store: SyncStore;

  beforeEach(() => {
    adapter = new SqliteAdapter({ path: ':memory:' });
    store = adapter.kv;
  });

  it('auto-creates collection tables on first use', async () => {
    // Just using the collection should create the table
    store.put('new_collection', { id: 'x1', data: 'hello' });
    const item = store.getById('new_collection', 'x1');
    expect(item).not.toBeNull();
  });

  it('stores complex nested JSON in data column', async () => {
    const complex = {
      id: 'c1',
      nested: { deep: { value: [1, 2, 3] } },
      tags: ['a', 'b'],
    };
    store.put('complex', complex);
    const retrieved = store.getById<typeof complex>('complex', 'c1');
    expect(retrieved).toEqual(complex);
  });

  it('reads back many rows correctly', () => {
    for (let i = 0; i < 100; i++) {
      store.put('items', { id: `i${i}`, value: i });
    }
    const results = Array.from({ length: 50 }, (_, i) =>
      store.getById<{ id: string; value: number }>('items', `i${i}`),
    );
    expect(results.every((r) => r !== null)).toBe(true);
    expect(results[0]!.value).toBe(0);
    expect(results[49]!.value).toBe(49);
  });

  it('meta reports sqlite backend', () => {
    expect(store.meta.backend).toBe('sqlite');
  });

  it('close does not throw', () => {
    expect(() => adapter.close()).not.toThrow();
  });
});

// mirk ships InMemory + SQLite backends; a remote backend would implement AsyncStore.

// ── toAsync adapter ─────────────────────────────────────────────────────────

describe('toAsync', () => {
  it('lifts a sync store to the AsyncStore interface (awaitable, same data)', async () => {
    const store = toAsync(new InMemoryKv());
    await store.set('k', 42);
    expect(await store.get<number>('k')).toBe(42);
    expect(await store.has('k')).toBe(true);
    await store.put('items', { id: 'a', name: 'x' });
    expect(
      await store.getById<{ id: string; name: string }>('items', 'a'),
    ).toEqual({ id: 'a', name: 'x' });
    expect(await store.count('items')).toBe(1);
    expect(await store.delete('k')).toBe(true);
    expect(store.meta.backend).toBe('memory');
  });

  it('reflects writes made directly through the underlying sync store', async () => {
    const sync = new InMemoryKv();
    const store = toAsync(sync);
    sync.set('shared', 'from-sync');
    expect(await store.get<string>('shared')).toBe('from-sync');
  });
});

// ── Backend parity (review fixes: collection aliasing, literal prefix, null sort)

describe.each<[string, () => SyncStore]>([
  ['InMemoryKv', () => new InMemoryKv()],
  ['SqliteAdapter.kv', () => new SqliteAdapter({ path: ':memory:' }).kv],
])('%s — backend parity', (_name, make) => {
  let store: SyncStore;
  beforeEach(() => {
    store = make();
  });

  it('distinct collection names do not alias to one table', () => {
    store.put('foo-bar', { id: 'x', v: 1 });
    store.put('foo_bar', { id: 'x', v: 2 });
    expect(store.getById<{ id: string; v: number }>('foo-bar', 'x')!.v).toBe(1);
    expect(store.getById<{ id: string; v: number }>('foo_bar', 'x')!.v).toBe(2);
    expect(store.count('foo-bar')).toBe(1);
    expect(store.count('foo_bar')).toBe(1);
  });

  it('keys(prefix) matches literally — no LIKE wildcard overmatch', () => {
    store.set('a_b', 1);
    store.set('axb', 2);
    store.set('a_c', 3);
    expect(store.keys('a_').sort()).toEqual(['a_b', 'a_c']);
  });

  it('sort puts null/missing fields LAST in both directions', () => {
    store.put('items', { id: '1', n: 2 });
    store.put('items', { id: '2' }); // n missing
    store.put('items', { id: '3', n: 1 });
    const asc = store.list<{ id: string; n?: number }>('items', { sortBy: 'n' }).map((r) => r.id);
    const desc = store
      .list<{ id: string; n?: number }>('items', { sortBy: 'n', sortDir: 'desc' })
      .map((r) => r.id);
    expect(asc).toEqual(['3', '1', '2']); // 1, 2, then null LAST
    expect(desc).toEqual(['1', '3', '2']); // 2, 1, then null still LAST
  });

  it('where: { x: null } matches an explicit-null field, not a missing one', () => {
    store.put('items', { id: 'has-null', x: null, tag: 'a' });
    store.put('items', { id: 'missing', tag: 'b' }); // x absent
    store.put('items', { id: 'has-value', x: 5, tag: 'c' });
    const matched = store
      .list<{ id: string }>('items', { where: { x: null } })
      .map((r) => r.id)
      .sort();
    expect(matched).toEqual(['has-null']); // only the explicit null; missing/valued excluded
    expect(store.count('items', { where: { x: null } })).toBe(1);
  });

  it('dotted field name in where is one TOP-LEVEL key, not a nested path', () => {
    store.put('items', { id: 'flat', 'a.b': 1 }); // top-level key literally "a.b"
    store.put('items', { id: 'nested', a: { b: 1 } }); // nested a → b
    const matched = store
      .list<{ id: string }>('items', { where: { 'a.b': 1 } })
      .map((r) => r.id);
    expect(matched).toEqual(['flat']); // the nested doc must NOT match
  });

  it('dotted field name in sortBy is one TOP-LEVEL key, not a nested path', () => {
    store.put('items', { id: 'x', 'a.b': 3, a: { b: 1 } });
    store.put('items', { id: 'y', 'a.b': 1, a: { b: 3 } });
    store.put('items', { id: 'z', 'a.b': 2, a: { b: 2 } });
    // Ordering must follow the top-level "a.b" key (1,2,3 → y,z,x), NOT nested a.b.
    const ids = store
      .list<{ id: string }>('items', { sortBy: 'a.b' })
      .map((r) => r.id);
    expect(ids).toEqual(['y', 'z', 'x']);
  });

  it('hostile field names are bound, not injected (no SQL injection)', () => {
    // A field name carrying a single quote + a classic injection payload. Inlined
    // into the SQL string the `'` breaks out of the literal; bound as a value (the
    // only correct way) it is inert — it just names a weird top-level key.
    const evil = `x') OR 1=1 --`;
    store.put('items', { id: 'match', [evil]: 7 });
    store.put('items', { id: 'other', other: 1 });
    // Matches ONLY the doc with that literal key. If it injected (`OR 1=1`) this
    // would return both rows; if it broke the SQL it would throw. Neither happens.
    const where = store.list<{ id: string }>('items', { where: { [evil]: 7 } }).map((r) => r.id);
    expect(where).toEqual(['match']);
    expect(() => store.list('items', { sortBy: evil })).not.toThrow();
  });
});

describe('SqliteAdapter — one connection serves kv + vector', () => {
  it('shares a single db across the kv and vector facets', () => {
    const db = new SqliteAdapter({ path: ':memory:', dimensions: 3 });
    try {
      db.kv.set('greeting', 'hi');
      db.kv.put('notes', { id: 'n1', text: 'a' });
      db.vector.upsert('vecs', { id: 'v1', vector: Float32Array.from([1, 0, 0]) });
      expect(db.kv.get('greeting')).toBe('hi');
      expect(db.kv.getById<{ id: string; text: string }>('notes', 'n1')!.text).toBe('a');
      expect(db.vector.search('vecs', Float32Array.from([1, 0, 0]), { topK: 1 })[0]!.id).toBe('v1');
    } finally {
      db.close();
    }
  });

  it('does not close a caller-provided db on a facet construction error', async () => {
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(':memory:');
    // Seed dimensions=4 on the handle, then reopen the SAME handle as 3 -> throws.
    new SqliteAdapter({ path: ':memory:', db: raw, dimensions: 4 });
    expect(() => new SqliteAdapter({ path: ':memory:', db: raw, dimensions: 3 })).toThrow(
      /dimension/i,
    );
    // The caller's handle must NOT have been closed by the failed construction.
    expect(() => raw.prepare('SELECT 1').get()).not.toThrow();
    raw.close();
  });
});
