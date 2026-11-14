import { compareCodePoints } from '@mirk/store/vector';
import { generation, normalizeItem, normalizeOutcome, validateClaim, validateEnqueue, validateItem, validateOutcome, validateReceipt } from './validation.js';
import { canonicalJson } from '@mirk/store/atomic';
import type { JsonObject, JsonValue, StoreTarget, StoreVersion } from '@mirk/store/atomic';
import type { BlockedDecision, ClaimOptions, EnqueueInput, QueueClaim, QueueCommand, QueueListOptions, QueueItem, QueueOptions, StartInput, StartResult, VersionedItem } from './types.js';
import { QueueError } from './types.js';
export { QueueError } from './types.js';
export type { BlockedDecision, ClaimOptions, EnqueueInput, QueueClaim, QueueCommand, QueueListOptions, QueueItem, ItemState, QueueOptions, StartInput, StartResult, VersionedItem } from './types.js';

const terminal = (item: QueueItem) => ['succeeded', 'failed', 'cancelled'].includes(item.state);
const order = (a: QueueItem, b: QueueItem) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt || compareCodePoints(a.id, b.id);
function positive(value: number) { if (!Number.isSafeInteger(value) || value <= 0) throw new QueueError('invalid-input'); }
function text(value: string) { if (typeof value !== 'string' || !value) throw new QueueError('invalid-input'); }
function time(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new QueueError('invalid-input'); return value; }

export class QueueStore {
  readonly collection: string;
  readonly #now: () => number;
  readonly #token: () => string;
  constructor(readonly options: QueueOptions) {
    this.collection = options.collection ?? 'mirk-queue'; text(this.collection);
    this.#now = options.now ?? Date.now;
    this.#token = options.token ?? (() => globalThis.crypto.randomUUID());
    if (typeof options.store.mutateAtomically !== 'function' || typeof options.transactions.transaction !== 'function') throw new QueueError('invalid-input');
    if (options.log && typeof options.log.append !== 'function') throw new QueueError('invalid-input');
    if (options.deleteHistoryOnRemove && typeof options.log?.deleteStream !== 'function') throw new QueueError('invalid-input');
  }
  #target(id: string): StoreTarget { return { kind: 'record', collection: this.collection, id }; }
  #generationKey(id: string) { return `mirk-queue-generation:${canonicalJson([this.collection, id])}`; }
  async #stream(id: string) {
    const retained = await this.options.store.get<unknown>(this.#generationKey(id));
    return canonicalJson([this.collection, id, retained === null ? 0 : time(generation(retained) + 1)]);
  }
  async get(id: string): Promise<VersionedItem | null> {
    text(id); const result = await this.options.store.getVersioned<QueueItem>(this.#target(id));
    if (result) { validateItem(result.value); if (result.value.id !== id) throw new QueueError('invalid-input'); }
    return result ? {...result,value:normalizeItem(result.value)} : null;
  }
  async list(filter: QueueListOptions = {}): Promise<VersionedItem[]> {
    if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 0)) throw new QueueError('invalid-input');
    const sortBy = filter.sortBy ?? 'updatedAt'; const sortDir = filter.sortDir ?? 'desc';
    if (!['updatedAt','enqueuedAt','priority'].includes(sortBy) || !['asc','desc'].includes(sortDir)) throw new QueueError('invalid-input');
    const indexed = this.options.store as typeof this.options.store & {ensureIndex?(collection:string,field:string):Promise<void>};
    if (!indexed.ensureIndex) throw new QueueError('invalid-input','Item listing requires ensureIndex');
    return this.options.transactions.transaction(async () => {
      const where: Record<string,unknown> = {};
      for (const field of ['queue','subject','kind','state'] as const) if(filter[field] !== undefined) { where[field]=filter[field]; await indexed.ensureIndex!(this.collection,field); }
      await indexed.ensureIndex!(this.collection,sortBy);
      const records = await this.options.store.list<QueueItem>(this.collection,{where,sortBy,sortDir,...(filter.limit===undefined?{}:{limit:filter.limit})});
      return Promise.all(records.map(async j => {validateItem(j); return (await this.get(j.id))!;}));
    });
  }

  async #command<T>(name: string, input: unknown, command: QueueCommand, work: () => Promise<T>): Promise<T> {
    text(command.key); const intent = canonicalJson({ name, input });
    const key = `mirk-queue-command:${canonicalJson([this.collection, command.key])}`;
    return this.options.transactions.transaction(async () => {
      const receipt = await this.options.store.get<unknown>(key);
      if (receipt !== null) {
        validateReceipt(receipt); validateOutcome(name, receipt.outcome);
        if (receipt.intent !== intent) throw new QueueError('idempotency-conflict');
        return normalizeOutcome(name, structuredClone(receipt.outcome)) as T;
      }
      const outcome = await work(); validateOutcome(name, outcome);
      const result = await this.options.store.mutateAtomically({ conditions: [{ target: { kind: 'key', key }, expected: 'missing' }], operations: [{ op: 'set', key, value: { intent, outcome: JSON.parse(canonicalJson(outcome)) as JsonValue } }] });
      if (result.status !== 'applied') throw new QueueError('conflict');
      return outcome;
    });
  }
  async #save(item: QueueItem, prior: VersionedItem | null, event: string): Promise<VersionedItem> {
    validateItem(item);
    const slot = await this.#slotMutation(item);
    const target = this.#target(item.id);
    const result = await this.options.store.mutateAtomically({ conditions: [prior ? { target, expected: 'version', version: prior.version } : { target, expected: 'missing' }, ...slot.conditions], operations: [{ op: 'put', collection: this.collection, item: item as unknown as { id: string } & JsonObject },...slot.operations] });
    if (result.status !== 'applied') throw new QueueError('conflict');
    if (this.options.log) await this.options.log.append(await this.#stream(item.id), { event, item } as unknown as JsonValue);
    return (await this.get(item.id))!;
  }
  async #require(id: string) { const item = await this.get(id); if (!item) throw new QueueError('not-found'); return item; }
  #owned(item: QueueItem, claim: QueueClaim, now: number) {
    if (item.state !== 'leased' || item.ownerToken !== claim.ownerToken || item.generation !== claim.generation || item.expiresAt === null || item.expiresAt <= now) throw new QueueError('stale-claim');
  }
  enqueue(input: EnqueueInput, command: QueueCommand): Promise<VersionedItem> {
    validateEnqueue(input); text(input.id); text(input.queue); canonicalJson(input.payload); input = structuredClone(input);
    if (!Number.isSafeInteger(input.priority ?? 0)) throw new QueueError('invalid-input');
    for(const value of [input.subject,input.kind]) if(value !== undefined && typeof value !== 'string') throw new QueueError('invalid-input');
    if (input.availableAt !== undefined) time(input.availableAt);
    return this.#command('enqueue', input, command, async () => {
      return this.#create(input,null);
    });
  }
  async #create(input: EnqueueInput, activeKey: string | null) {
      const retainedGeneration = await this.options.store.get<unknown>(this.#generationKey(input.id));
      const initialGeneration = retainedGeneration === null ? 0 : time(generation(retainedGeneration) + 1);
      const now = time(this.#now());
      const item: QueueItem = { ...input, schemaVersion: 2, activeKey, subject:input.subject ?? null, kind:input.kind ?? null, state: 'queued', priority: input.priority ?? 0, availableAt: input.availableAt ?? now, enqueuedAt: now, updatedAt: now, claimCount: 0, generation: initialGeneration, ownerToken: null, expiresAt: null, checkpoint: null, cancellation: null, result: null, error: null };
      return this.#save(item, null, 'enqueue');
  }
  start(input: StartInput, command: QueueCommand): Promise<StartResult> {
    input = structuredClone(input); text(input.key); text(input.queue);
    const {key,...candidate} = input; validateEnqueue({...candidate,id:candidate.id ?? 'pending'});
    if(input.id !== undefined) text(input.id);
    for(const value of [input.subject,input.kind]) if(value !== undefined && typeof value !== 'string') throw new QueueError('invalid-input');
    canonicalJson(input.payload); if(!Number.isSafeInteger(input.priority ?? 0)) throw new QueueError('invalid-input');
    if(input.availableAt !== undefined) time(input.availableAt);
    return this.#command('start',input,command,async () => {
      const pointer = await this.options.store.get<string>(this.#slotKey(input.queue,key));
      if(pointer !== null) {
        text(pointer); const existing = await this.get(pointer);
        if(existing && !terminal(existing.value)) {
          if(existing.value.queue !== input.queue || existing.value.activeKey !== key) throw new QueueError('conflict');
          return {started:false,item:existing};
        }
      }
      const id = input.id ?? this.#token(); text(id);
      return {started:true,item:await this.#create({...candidate,id},key)};
    });
  }
  #slotKey(queue: string,key: string) {return `mirk-queue-active:${canonicalJson([this.collection,queue,key])}`;}
  async #slotMutation(item: QueueItem): Promise<{conditions: import('@mirk/store/atomic').StoreCondition[];operations:import('@mirk/store/atomic').AtomicStoreOperation[]}> {
    if(item.activeKey === null) return {conditions:[],operations:[]};
    const key = this.#slotKey(item.queue,item.activeKey); const target = {kind:'key' as const,key};
    const slot = await this.options.store.getVersioned<string>(target);
    if(terminal(item)) return slot?.value === item.id ? {conditions:[{target,expected:'version',version:slot.version}],operations:[{op:'delete',key}]} : {conditions:[],operations:[]};
    if(slot) {
      text(slot.value); if(slot.value === item.id) return {conditions:[],operations:[]};
      const other = await this.get(slot.value); if(other && !terminal(other.value)) throw new QueueError('conflict');
    }
    return {conditions:[slot?{target,expected:'version',version:slot.version}:{target,expected:'missing'}],operations:[{op:'set',key,value:item.id}]};
  }
  async #claim(id: string, leaseMs: number): Promise<QueueClaim | null> {
    const prior = await this.get(id); const now = time(this.#now());
    if (!prior || prior.value.state !== 'queued' || prior.value.cancellation || prior.value.availableAt > now) return null;
    const ownerToken = this.#token(); text(ownerToken);
    const item = { ...prior.value, state: 'leased' as const, ownerToken, generation: prior.value.generation + 1, claimCount: prior.value.claimCount + 1, expiresAt: time(now + leaseMs), updatedAt: now };
    await this.#save(item, prior, 'claim');
    return { itemId: id, ownerToken, generation: item.generation };
  }
  async #claimCommand(name: string, input: unknown, options: ClaimOptions, work: () => Promise<QueueClaim | null>) {
    positive(options.leaseMs);
    return this.options.transactions.transaction(async () => {
      const claim = await this.#command(name, input, options, work);
      if (claim) this.#owned((await this.#require(claim.itemId)).value, claim, time(this.#now()));
      return claim;
    });
  }
  claim(id: string, options: ClaimOptions) { options = structuredClone(options); text(id); return this.#claimCommand('claim', { id, leaseMs: options.leaseMs }, options, () => this.#claim(id, options.leaseMs)); }
  claimNext(queue: string, options: ClaimOptions) {
    options = structuredClone(options); text(queue);
    return this.#claimCommand('claimNext', { queue, leaseMs: options.leaseMs }, options, async () => {
      const now = time(this.#now());
      const items = (await this.options.store.list<QueueItem>(this.collection)).map(j => { validateItem(j); return j; }).filter(j => j.queue === queue && j.state === 'queued' && !j.cancellation && j.availableAt <= now).sort(order);
      return items.length ? this.#claim(items[0]!.id, options.leaseMs) : null;
    });
  }
  #worker(name: string, claim: QueueClaim, data: JsonValue, command: QueueCommand, change: (item: QueueItem, now: number, data: JsonValue) => void, allowCancel = false) {
    validateClaim(claim); claim = structuredClone(claim); data = structuredClone(data);
    return this.#command(name, { claim, data }, command, async () => {
      const prior = await this.#require(claim.itemId); const now = time(this.#now());
      this.#owned(prior.value, claim, now);
      if (prior.value.cancellation && !allowCancel) throw new QueueError('cancel-requested');
      const item = structuredClone(prior.value); item.updatedAt = now; change(item, now, data);
      if (item.state !== 'leased') { item.ownerToken = null; item.expiresAt = null; }
      return this.#save(item, prior, name);
    });
  }
  renew(claim: QueueClaim, leaseMs: number, command: QueueCommand) { positive(leaseMs); return this.#worker('renew', claim, leaseMs, command, (j,n) => { j.expiresAt = time(n + leaseMs); }, true); }
  checkpoint(claim: QueueClaim, value: JsonValue, command: QueueCommand) { return this.#worker('checkpoint', claim, value, command, (j,_n,value) => { j.checkpoint = value; }, true); }
  complete(claim: QueueClaim, result: JsonValue, command: QueueCommand) { return this.#worker('complete', claim, result, command, (j,_n,value) => { j.state = 'succeeded'; j.result = value; }); }
  fail(claim: QueueClaim, error: JsonValue, command: QueueCommand) { return this.#worker('fail', claim, error, command, (j,_n,value) => { j.state = 'failed'; j.error = value; }); }
  retry(claim: QueueClaim, availableAt: number, command: QueueCommand) { time(availableAt); return this.#worker('retry', claim, availableAt, command, j => { j.state = 'queued'; j.availableAt = availableAt; }); }
  block(claim: QueueClaim, checkpoint: JsonValue, command: QueueCommand) { return this.#worker('block', claim, checkpoint, command, (j,_n,value) => { j.state = 'blocked'; j.checkpoint = value; }, true); }
  acknowledgeCancel(claim: QueueClaim, command: QueueCommand) { return this.#worker('acknowledgeCancel', claim, null, command, j => { if (!j.cancellation) throw new QueueError('conflict'); j.state = 'cancelled'; }, true); }
  requestCancel(id: string, command: QueueCommand) {
    return this.#command('requestCancel', { id }, command, async () => {
      const prior = await this.#require(id); if (terminal(prior.value) || prior.value.cancellation) return prior;
      const now = time(this.#now()); const item = { ...prior.value, updatedAt: now, cancellation: { requestedAt: now, generation: prior.value.generation } };
      if (item.state !== 'leased') item.state = 'cancelled';
      return this.#save(item, prior, 'requestCancel');
    });
  }
  recoverExpired(id: string, expectedGeneration: number, command: QueueCommand) {
    return this.#command('recoverExpired', { id, expectedGeneration }, command, async () => {
      const prior = await this.#require(id); const now = time(this.#now()); const item = prior.value;
      if (item.state !== 'leased' || item.generation !== expectedGeneration || item.expiresAt === null || item.expiresAt > now) throw new QueueError('conflict');
      return this.#save({ ...item, state: 'blocked', generation: item.generation + 1, ownerToken: null, expiresAt: null, updatedAt: now }, prior, 'recoverExpired');
    });
  }
  resolveBlocked(id: string, expectedVersion: StoreVersion, decision: BlockedDecision, command: QueueCommand) {
    decision = structuredClone(decision);
    const fields = decision.state === 'queued' ? ['state', 'availableAt'] : decision.state === 'succeeded' ? ['state', 'result'] : decision.state === 'failed' ? ['state', 'error'] : decision.state === 'cancelled' ? ['state'] : [];
    if (!fields.length || Object.keys(decision).some(k => !fields.includes(k)) || fields.some(k => !(k in decision))) throw new QueueError('invalid-input');
    return this.#command('resolveBlocked', { id, expectedVersion, decision }, command, async () => {
      const prior = await this.#require(id); if (prior.version !== expectedVersion) throw new QueueError('conflict');
      if (prior.value.state !== 'blocked') throw new QueueError('not-blocked');
      if (prior.value.cancellation && decision.state !== 'cancelled') throw new QueueError('cancel-requested');
      if (decision.state === 'queued') time(decision.availableAt);
      return this.#save({ ...prior.value, ...decision, updatedAt: time(this.#now()) }, prior, 'resolveBlocked');
    });
  }
  updateQueued(id: string, expectedVersion: StoreVersion, patch: { priority?: number; availableAt?: number }, command: QueueCommand) {
    patch = structuredClone(patch);
    if (Object.keys(patch).some(k => !['priority', 'availableAt'].includes(k))) throw new QueueError('invalid-input');
    if (patch.priority !== undefined && !Number.isSafeInteger(patch.priority)) throw new QueueError('invalid-input');
    if (patch.availableAt !== undefined) time(patch.availableAt);
    return this.#command('updateQueued', { id, expectedVersion, patch }, command, async () => {
      const prior = await this.#require(id);
      if (prior.version !== expectedVersion || prior.value.state !== 'queued') throw new QueueError('conflict');
      return this.#save({ ...prior.value, ...patch, updatedAt: time(this.#now()) }, prior, 'updateQueued');
    });
  }
  requeueTerminal(id: string, expectedVersion: StoreVersion, patch: { availableAt?: number }, command: QueueCommand) {
    patch = structuredClone(patch);
    if (Object.keys(patch).some(k => k !== 'availableAt')) throw new QueueError('invalid-input');
    if (patch.availableAt !== undefined) time(patch.availableAt);
    return this.#command('requeueTerminal', { id, expectedVersion, patch }, command, async () => {
      const prior = await this.#require(id);
      if (prior.version !== expectedVersion) throw new QueueError('conflict');
      if (!terminal(prior.value)) throw new QueueError('not-terminal');
      const now = time(this.#now());
      return this.#save({ ...prior.value, state: 'queued', availableAt: patch.availableAt ?? now, generation: prior.value.generation + 1, cancellation: null, checkpoint: null, result: null, error: null, ownerToken: null, expiresAt: null, updatedAt: now }, prior, 'requeueTerminal');
    });
  }
  removeTerminal(id: string, expectedVersion: StoreVersion, command: QueueCommand) {
    return this.#command('removeTerminal', { id, expectedVersion }, command, async () => {
      const prior = await this.#require(id); if (prior.version !== expectedVersion) throw new QueueError('conflict');
      if (!terminal(prior.value)) throw new QueueError('not-terminal');
      const stream = this.options.deleteHistoryOnRemove ? await this.#stream(id) : null;
      const result = await this.options.store.mutateAtomically({ conditions: [{ target: this.#target(id), expected: 'version', version: expectedVersion }], operations: [{ op: 'remove', collection: this.collection, id }, { op: 'set', key: this.#generationKey(id), value: prior.value.generation }] });
      if (result.status !== 'applied') throw new QueueError('conflict');
      if (this.options.deleteHistoryOnRemove) await this.options.log!.deleteStream(stream!);
      return true;
    });
  }
}

export { runClaim } from './runner.js';
export type { RunClaimOptions } from './runner.js';
