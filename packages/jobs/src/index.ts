import { compareCodePoints } from '@mirk/store/vector';
import { generation, normalizeJob, normalizeOutcome, validateClaim, validateEnqueue, validateJob, validateOutcome, validateReceipt } from './validation.js';
import { canonicalJson } from '@mirk/store/atomic';
import type { JsonObject, JsonValue, StoreTarget, StoreVersion } from '@mirk/store/atomic';
import type { BlockedDecision, ClaimOptions, EnqueueInput, JobClaim, JobCommand, JobListOptions, JobRecord, JobsOptions, StartInput, StartResult, VersionedJob } from './types.js';
import { JobsError } from './types.js';
export { JobsError } from './types.js';
export type { BlockedDecision, ClaimOptions, EnqueueInput, JobClaim, JobCommand, JobListOptions, JobRecord, JobState, JobsOptions, StartInput, StartResult, VersionedJob } from './types.js';

const terminal = (job: JobRecord) => ['succeeded', 'failed', 'cancelled'].includes(job.state);
const order = (a: JobRecord, b: JobRecord) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt || compareCodePoints(a.id, b.id);
function positive(value: number) { if (!Number.isSafeInteger(value) || value <= 0) throw new JobsError('invalid-input'); }
function text(value: string) { if (typeof value !== 'string' || !value) throw new JobsError('invalid-input'); }
function time(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new JobsError('invalid-input'); return value; }

export class JobsStore {
  readonly collection: string;
  readonly #now: () => number;
  readonly #token: () => string;
  constructor(readonly options: JobsOptions) {
    this.collection = options.collection ?? 'mirk-jobs'; text(this.collection);
    this.#now = options.now ?? Date.now;
    this.#token = options.token ?? (() => globalThis.crypto.randomUUID());
    if (typeof options.store.mutateAtomically !== 'function' || typeof options.transactions.transaction !== 'function') throw new JobsError('invalid-input');
    if (options.log && typeof options.log.append !== 'function') throw new JobsError('invalid-input');
    if (options.deleteHistoryOnRemove && typeof options.log?.deleteStream !== 'function') throw new JobsError('invalid-input');
  }
  #target(id: string): StoreTarget { return { kind: 'record', collection: this.collection, id }; }
  #generationKey(id: string) { return `mirk-jobs-generation:${canonicalJson([this.collection, id])}`; }
  async #stream(id: string) {
    const retained = await this.options.store.get<unknown>(this.#generationKey(id));
    return canonicalJson([this.collection, id, retained === null ? 0 : time(generation(retained) + 1)]);
  }
  async get(id: string): Promise<VersionedJob | null> {
    text(id); const result = await this.options.store.getVersioned<JobRecord>(this.#target(id));
    if (result) { validateJob(result.value); if (result.value.id !== id) throw new JobsError('invalid-input'); }
    return result ? {...result,value:normalizeJob(result.value)} : null;
  }
  async list(filter: JobListOptions = {}): Promise<VersionedJob[]> {
    if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 0)) throw new JobsError('invalid-input');
    const sortBy = filter.sortBy ?? 'updatedAt'; const sortDir = filter.sortDir ?? 'desc';
    if (!['updatedAt','enqueuedAt','priority'].includes(sortBy) || !['asc','desc'].includes(sortDir)) throw new JobsError('invalid-input');
    const indexed = this.options.store as typeof this.options.store & {ensureIndex?(collection:string,field:string):Promise<void>};
    if (!indexed.ensureIndex) throw new JobsError('invalid-input','Job listing requires ensureIndex');
    return this.options.transactions.transaction(async () => {
      const where: Record<string,unknown> = {};
      for (const field of ['queue','subject','kind','state'] as const) if(filter[field] !== undefined) { where[field]=filter[field]; await indexed.ensureIndex!(this.collection,field); }
      await indexed.ensureIndex!(this.collection,sortBy);
      const records = await this.options.store.list<JobRecord>(this.collection,{where,sortBy,sortDir,...(filter.limit===undefined?{}:{limit:filter.limit})});
      return Promise.all(records.map(async j => {validateJob(j); return (await this.get(j.id))!;}));
    });
  }

  async #command<T>(name: string, input: unknown, command: JobCommand, work: () => Promise<T>): Promise<T> {
    text(command.key); const intent = canonicalJson({ name, input });
    const key = `mirk-jobs-command:${canonicalJson([this.collection, command.key])}`;
    return this.options.transactions.transaction(async () => {
      const receipt = await this.options.store.get<unknown>(key);
      if (receipt !== null) {
        validateReceipt(receipt); validateOutcome(name, receipt.outcome);
        if (receipt.intent !== intent) throw new JobsError('idempotency-conflict');
        return normalizeOutcome(name, structuredClone(receipt.outcome)) as T;
      }
      const outcome = await work(); validateOutcome(name, outcome);
      const result = await this.options.store.mutateAtomically({ conditions: [{ target: { kind: 'key', key }, expected: 'missing' }], operations: [{ op: 'set', key, value: { intent, outcome: JSON.parse(canonicalJson(outcome)) as JsonValue } }] });
      if (result.status !== 'applied') throw new JobsError('conflict');
      return outcome;
    });
  }
  async #save(job: JobRecord, prior: VersionedJob | null, event: string): Promise<VersionedJob> {
    validateJob(job);
    const slot = await this.#slotMutation(job);
    const target = this.#target(job.id);
    const result = await this.options.store.mutateAtomically({ conditions: [prior ? { target, expected: 'version', version: prior.version } : { target, expected: 'missing' }, ...slot.conditions], operations: [{ op: 'put', collection: this.collection, item: job as unknown as { id: string } & JsonObject },...slot.operations] });
    if (result.status !== 'applied') throw new JobsError('conflict');
    if (this.options.log) await this.options.log.append(await this.#stream(job.id), { event, job } as unknown as JsonValue);
    return (await this.get(job.id))!;
  }
  async #require(id: string) { const job = await this.get(id); if (!job) throw new JobsError('not-found'); return job; }
  #owned(job: JobRecord, claim: JobClaim, now: number) {
    if (job.state !== 'leased' || job.ownerToken !== claim.ownerToken || job.generation !== claim.generation || job.expiresAt === null || job.expiresAt <= now) throw new JobsError('stale-claim');
  }
  enqueue(input: EnqueueInput, command: JobCommand): Promise<VersionedJob> {
    validateEnqueue(input); text(input.id); text(input.queue); canonicalJson(input.payload); input = structuredClone(input);
    if (!Number.isSafeInteger(input.priority ?? 0)) throw new JobsError('invalid-input');
    for(const value of [input.subject,input.kind]) if(value !== undefined && typeof value !== 'string') throw new JobsError('invalid-input');
    if (input.availableAt !== undefined) time(input.availableAt);
    return this.#command('enqueue', input, command, async () => {
      return this.#create(input,null);
    });
  }
  async #create(input: EnqueueInput, activeKey: string | null) {
      const retainedGeneration = await this.options.store.get<unknown>(this.#generationKey(input.id));
      const initialGeneration = retainedGeneration === null ? 0 : time(generation(retainedGeneration) + 1);
      const now = time(this.#now());
      const job: JobRecord = { ...input, schemaVersion: 2, activeKey, subject:input.subject ?? null, kind:input.kind ?? null, state: 'queued', priority: input.priority ?? 0, availableAt: input.availableAt ?? now, enqueuedAt: now, updatedAt: now, attempt: 0, generation: initialGeneration, ownerToken: null, expiresAt: null, checkpoint: null, cancellation: null, result: null, error: null };
      return this.#save(job, null, 'enqueue');
  }
  start(input: StartInput, command: JobCommand): Promise<StartResult> {
    input = structuredClone(input); text(input.key); text(input.queue);
    const {key,...candidate} = input; validateEnqueue({...candidate,id:candidate.id ?? 'pending'});
    if(input.id !== undefined) text(input.id);
    for(const value of [input.subject,input.kind]) if(value !== undefined && typeof value !== 'string') throw new JobsError('invalid-input');
    canonicalJson(input.payload); if(!Number.isSafeInteger(input.priority ?? 0)) throw new JobsError('invalid-input');
    if(input.availableAt !== undefined) time(input.availableAt);
    return this.#command('start',input,command,async () => {
      const pointer = await this.options.store.get<string>(this.#slotKey(input.queue,key));
      if(pointer !== null) {
        text(pointer); const existing = await this.get(pointer);
        if(existing && !terminal(existing.value)) {
          if(existing.value.queue !== input.queue || existing.value.activeKey !== key) throw new JobsError('conflict');
          return {started:false,job:existing};
        }
      }
      const id = input.id ?? this.#token(); text(id);
      return {started:true,job:await this.#create({...candidate,id},key)};
    });
  }
  #slotKey(queue: string,key: string) {return `mirk-jobs-active:${canonicalJson([this.collection,queue,key])}`;}
  async #slotMutation(job: JobRecord): Promise<{conditions: import('@mirk/store/atomic').StoreCondition[];operations:import('@mirk/store/atomic').AtomicStoreOperation[]}> {
    if(job.activeKey === null) return {conditions:[],operations:[]};
    const key = this.#slotKey(job.queue,job.activeKey); const target = {kind:'key' as const,key};
    const slot = await this.options.store.getVersioned<string>(target);
    if(terminal(job)) return slot?.value === job.id ? {conditions:[{target,expected:'version',version:slot.version}],operations:[{op:'delete',key}]} : {conditions:[],operations:[]};
    if(slot) {
      text(slot.value); if(slot.value === job.id) return {conditions:[],operations:[]};
      const other = await this.get(slot.value); if(other && !terminal(other.value)) throw new JobsError('conflict');
    }
    return {conditions:[slot?{target,expected:'version',version:slot.version}:{target,expected:'missing'}],operations:[{op:'set',key,value:job.id}]};
  }
  async #claim(id: string, leaseMs: number): Promise<JobClaim | null> {
    const prior = await this.get(id); const now = time(this.#now());
    if (!prior || prior.value.state !== 'queued' || prior.value.cancellation || prior.value.availableAt > now) return null;
    const ownerToken = this.#token(); text(ownerToken);
    const job = { ...prior.value, state: 'leased' as const, ownerToken, generation: prior.value.generation + 1, attempt: prior.value.attempt + 1, expiresAt: time(now + leaseMs), updatedAt: now };
    await this.#save(job, prior, 'claim');
    return { jobId: id, ownerToken, generation: job.generation };
  }
  async #claimCommand(name: string, input: unknown, options: ClaimOptions, work: () => Promise<JobClaim | null>) {
    positive(options.leaseMs);
    return this.options.transactions.transaction(async () => {
      const claim = await this.#command(name, input, options, work);
      if (claim) this.#owned((await this.#require(claim.jobId)).value, claim, time(this.#now()));
      return claim;
    });
  }
  claim(id: string, options: ClaimOptions) { options = structuredClone(options); text(id); return this.#claimCommand('claim', { id, leaseMs: options.leaseMs }, options, () => this.#claim(id, options.leaseMs)); }
  claimNext(queue: string, options: ClaimOptions) {
    options = structuredClone(options); text(queue);
    return this.#claimCommand('claimNext', { queue, leaseMs: options.leaseMs }, options, async () => {
      const now = time(this.#now());
      const jobs = (await this.options.store.list<JobRecord>(this.collection)).map(j => { validateJob(j); return j; }).filter(j => j.queue === queue && j.state === 'queued' && !j.cancellation && j.availableAt <= now).sort(order);
      return jobs.length ? this.#claim(jobs[0]!.id, options.leaseMs) : null;
    });
  }
  #worker(name: string, claim: JobClaim, data: JsonValue, command: JobCommand, change: (job: JobRecord, now: number, data: JsonValue) => void, allowCancel = false) {
    validateClaim(claim); claim = structuredClone(claim); data = structuredClone(data);
    return this.#command(name, { claim, data }, command, async () => {
      const prior = await this.#require(claim.jobId); const now = time(this.#now());
      this.#owned(prior.value, claim, now);
      if (prior.value.cancellation && !allowCancel) throw new JobsError('cancel-requested');
      const job = structuredClone(prior.value); job.updatedAt = now; change(job, now, data);
      if (job.state !== 'leased') { job.ownerToken = null; job.expiresAt = null; }
      return this.#save(job, prior, name);
    });
  }
  renew(claim: JobClaim, leaseMs: number, command: JobCommand) { positive(leaseMs); return this.#worker('renew', claim, leaseMs, command, (j,n) => { j.expiresAt = time(n + leaseMs); }, true); }
  checkpoint(claim: JobClaim, value: JsonValue, command: JobCommand) { return this.#worker('checkpoint', claim, value, command, (j,_n,value) => { j.checkpoint = value; }, true); }
  complete(claim: JobClaim, result: JsonValue, command: JobCommand) { return this.#worker('complete', claim, result, command, (j,_n,value) => { j.state = 'succeeded'; j.result = value; }); }
  fail(claim: JobClaim, error: JsonValue, command: JobCommand) { return this.#worker('fail', claim, error, command, (j,_n,value) => { j.state = 'failed'; j.error = value; }); }
  retry(claim: JobClaim, availableAt: number, command: JobCommand) { time(availableAt); return this.#worker('retry', claim, availableAt, command, j => { j.state = 'queued'; j.availableAt = availableAt; }); }
  block(claim: JobClaim, checkpoint: JsonValue, command: JobCommand) { return this.#worker('block', claim, checkpoint, command, (j,_n,value) => { j.state = 'blocked'; j.checkpoint = value; }, true); }
  acknowledgeCancel(claim: JobClaim, command: JobCommand) { return this.#worker('acknowledgeCancel', claim, null, command, j => { if (!j.cancellation) throw new JobsError('conflict'); j.state = 'cancelled'; }, true); }
  requestCancel(id: string, command: JobCommand) {
    return this.#command('requestCancel', { id }, command, async () => {
      const prior = await this.#require(id); if (terminal(prior.value) || prior.value.cancellation) return prior;
      const now = time(this.#now()); const job = { ...prior.value, updatedAt: now, cancellation: { requestedAt: now, generation: prior.value.generation } };
      if (job.state !== 'leased') job.state = 'cancelled';
      return this.#save(job, prior, 'requestCancel');
    });
  }
  recoverExpired(id: string, expectedGeneration: number, command: JobCommand) {
    return this.#command('recoverExpired', { id, expectedGeneration }, command, async () => {
      const prior = await this.#require(id); const now = time(this.#now()); const job = prior.value;
      if (job.state !== 'leased' || job.generation !== expectedGeneration || job.expiresAt === null || job.expiresAt > now) throw new JobsError('conflict');
      return this.#save({ ...job, state: 'blocked', generation: job.generation + 1, ownerToken: null, expiresAt: null, updatedAt: now }, prior, 'recoverExpired');
    });
  }
  resolveBlocked(id: string, expectedVersion: StoreVersion, decision: BlockedDecision, command: JobCommand) {
    decision = structuredClone(decision);
    const fields = decision.state === 'queued' ? ['state', 'availableAt'] : decision.state === 'succeeded' ? ['state', 'result'] : decision.state === 'failed' ? ['state', 'error'] : decision.state === 'cancelled' ? ['state'] : [];
    if (!fields.length || Object.keys(decision).some(k => !fields.includes(k)) || fields.some(k => !(k in decision))) throw new JobsError('invalid-input');
    return this.#command('resolveBlocked', { id, expectedVersion, decision }, command, async () => {
      const prior = await this.#require(id); if (prior.version !== expectedVersion) throw new JobsError('conflict');
      if (prior.value.state !== 'blocked') throw new JobsError('not-blocked');
      if (prior.value.cancellation && decision.state !== 'cancelled') throw new JobsError('cancel-requested');
      if (decision.state === 'queued') time(decision.availableAt);
      return this.#save({ ...prior.value, ...decision, updatedAt: time(this.#now()) }, prior, 'resolveBlocked');
    });
  }
  updateQueued(id: string, expectedVersion: StoreVersion, patch: { priority?: number; availableAt?: number }, command: JobCommand) {
    patch = structuredClone(patch);
    if (Object.keys(patch).some(k => !['priority', 'availableAt'].includes(k))) throw new JobsError('invalid-input');
    if (patch.priority !== undefined && !Number.isSafeInteger(patch.priority)) throw new JobsError('invalid-input');
    if (patch.availableAt !== undefined) time(patch.availableAt);
    return this.#command('updateQueued', { id, expectedVersion, patch }, command, async () => {
      const prior = await this.#require(id);
      if (prior.version !== expectedVersion || prior.value.state !== 'queued') throw new JobsError('conflict');
      return this.#save({ ...prior.value, ...patch, updatedAt: time(this.#now()) }, prior, 'updateQueued');
    });
  }
  requeueTerminal(id: string, expectedVersion: StoreVersion, patch: { availableAt?: number }, command: JobCommand) {
    patch = structuredClone(patch);
    if (Object.keys(patch).some(k => k !== 'availableAt')) throw new JobsError('invalid-input');
    if (patch.availableAt !== undefined) time(patch.availableAt);
    return this.#command('requeueTerminal', { id, expectedVersion, patch }, command, async () => {
      const prior = await this.#require(id);
      if (prior.version !== expectedVersion) throw new JobsError('conflict');
      if (!terminal(prior.value)) throw new JobsError('not-terminal');
      const now = time(this.#now());
      return this.#save({ ...prior.value, state: 'queued', availableAt: patch.availableAt ?? now, generation: prior.value.generation + 1, cancellation: null, checkpoint: null, result: null, error: null, ownerToken: null, expiresAt: null, updatedAt: now }, prior, 'requeueTerminal');
    });
  }
  removeTerminal(id: string, expectedVersion: StoreVersion, command: JobCommand) {
    return this.#command('removeTerminal', { id, expectedVersion }, command, async () => {
      const prior = await this.#require(id); if (prior.version !== expectedVersion) throw new JobsError('conflict');
      if (!terminal(prior.value)) throw new JobsError('not-terminal');
      const stream = this.options.deleteHistoryOnRemove ? await this.#stream(id) : null;
      const result = await this.options.store.mutateAtomically({ conditions: [{ target: this.#target(id), expected: 'version', version: expectedVersion }], operations: [{ op: 'remove', collection: this.collection, id }, { op: 'set', key: this.#generationKey(id), value: prior.value.generation }] });
      if (result.status !== 'applied') throw new JobsError('conflict');
      if (this.options.deleteHistoryOnRemove) await this.options.log!.deleteStream(stream!);
      return true;
    });
  }
}

export { runClaim } from './runner.js';
export type { RunClaimOptions } from './runner.js';
