import { describe, expect, it } from 'vitest';

import { InMemoryStore } from './backends/memory.js';
import { namespaceStore } from './namespace.js';

describe('namespaceStore', () => {
  it('isolates identical keys and collection ids in one backing store', () => {
    const backing = new InMemoryStore();
    const first = namespaceStore(backing, 'first');
    const second = namespaceStore(backing, 'second');

    first.set('same', 'first-value');
    second.set('same', 'second-value');
    first.put('records', { id: 'same', value: 'first-record' });
    second.put('records', { id: 'same', value: 'second-record' });

    expect(first.get('same')).toBe('first-value');
    expect(second.get('same')).toBe('second-value');
    expect(first.getById('records', 'same')).toEqual({ id: 'same', value: 'first-record' });
    expect(second.getById('records', 'same')).toEqual({ id: 'same', value: 'second-record' });
  });

  it('returns namespace-local keys without exposing storage prefixes', () => {
    const backing = new InMemoryStore();
    const first = namespaceStore(backing, 'first');
    const second = namespaceStore(backing, 'second');

    first.set('item:a', 1);
    first.set('item:b', 2);
    second.set('item:c', 3);

    expect(first.keys()).toEqual(['item:a', 'item:b']);
    expect(first.keys('item:')).toEqual(['item:a', 'item:b']);
  });

  it('rejects namespaces that could collide with the physical encoding', () => {
    const backing = new InMemoryStore();
    expect(() => namespaceStore(backing, '')).toThrow('namespace must be non-empty');
    expect(() => namespaceStore(backing, 'bad\u001fnamespace')).toThrow('unit separator');
  });
});
