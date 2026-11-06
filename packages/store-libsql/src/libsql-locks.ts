/** A first-come, first-served async lock. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const acquired = this.tail.then(() => release);
    this.tail = this.tail.then(() => held);
    return acquired;
  }
}

const localWriters = new Map<string, { mutex: Mutex; adapters: number }>();

/** The writer lock shared by every adapter in this process on the database
 *  file `url` names, and a `detach` the adapter calls once on close; the lock
 *  is forgotten when its last adapter detaches. URLs that spell one file
 *  differently get separate locks and fall back to SQLite's busy handling.
 *  In-memory databases are private to their connection, so each gets its
 *  own. */
export function fileWriters(url: string): { mutex: Mutex; detach: () => void } {
  const path = url.replace(/^file:/i, "").replace(/\?.*$/, "");
  if (
    !/^file:/i.test(url) ||
    path === "" ||
    path === ":memory:" ||
    /[?&]mode=memory\b/.test(url)
  ) {
    return { mutex: new Mutex(), detach: () => undefined };
  }
  let entry = localWriters.get(path);
  if (!entry) {
    entry = { mutex: new Mutex(), adapters: 0 };
    localWriters.set(path, entry);
  }
  entry.adapters += 1;
  const shared = entry;
  let detached = false;
  return {
    mutex: shared.mutex,
    detach: () => {
      if (detached) return;
      detached = true;
      shared.adapters -= 1;
      if (shared.adapters === 0 && localWriters.get(path) === shared)
        localWriters.delete(path);
    },
  };
}

/** @internal The number of files with a shared writer lock, for tests. */
export function localWriterCount(): number {
  return localWriters.size;
}
