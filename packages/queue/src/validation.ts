import { canonicalJson } from '@mirk/store/atomic';
import type { QueueClaim, QueueItem } from './types.js';
import { QueueError } from './types.js';

const states = ['queued', 'leased', 'blocked', 'succeeded', 'failed', 'cancelled'];
const fields = ['id', 'schemaVersion', 'queue', 'payload', 'state', 'priority', 'enqueuedAt', 'availableAt', 'updatedAt', 'claimCount', 'generation', 'ownerToken', 'expiresAt', 'checkpoint', 'cancellation', 'result', 'error'];
function invalid(): never { throw new QueueError('invalid-input', 'Malformed queue data'); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid();
}
function nonempty(value: unknown) { if (typeof value !== 'string' || !value) invalid(); }
export function generation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
export function validateItem(value: unknown): asserts value is QueueItem {
  const item = object(value); exact(item, item.schemaVersion === 1 ? fields : [...fields,'activeKey','subject','kind']);
  if (![1,2].includes(item.schemaVersion as number) || !states.includes(item.state as string)) invalid();
  if (item.schemaVersion === 2) for (const field of ['activeKey','subject','kind']) { if (item[field] !== null && typeof item[field] !== 'string') invalid(); }
  if (item.schemaVersion === 2 && item.activeKey !== null) nonempty(item.activeKey);
  nonempty(item.id); nonempty(item.queue);
  if (!Number.isSafeInteger(item.priority)) invalid();
  for (const field of ['enqueuedAt','availableAt','updatedAt','claimCount','generation']) generation(item[field]);
  if (item.state === 'leased') {
    nonempty(item.ownerToken); generation(item.expiresAt);
    if (item.claimCount === 0 || item.generation === 0) invalid();
  } else if (item.ownerToken !== null || item.expiresAt !== null) invalid();
  if (item.cancellation !== null) {
    const cancellation = object(item.cancellation); exact(cancellation,['requestedAt','generation']);
    generation(cancellation.requestedAt);
    if (generation(cancellation.generation) > generation(item.generation) || ['queued','succeeded','failed'].includes(item.state as string)) invalid();
  }
  try { canonicalJson(value); } catch { invalid(); }
}
export function normalizeItem(value: unknown): QueueItem {
  validateItem(value);
  return value.schemaVersion === 2 ? value : {...value,schemaVersion:2,activeKey:null,subject:null,kind:null};
}
export function normalizeOutcome(name: string, value: unknown): unknown {
  validateOutcome(name,value);
  if (name === 'start') { const result = value as {started:boolean;item:{value:unknown;version:string}}; return {...result,item:{...result.item,value:normalizeItem(result.item.value)}}; }
  if (name === 'claim' || name === 'claimNext' || name === 'removeTerminal') return value;
  const result = value as {value:unknown;version:string}; return {...result,value:normalizeItem(result.value)};
}
export function validateClaim(value: unknown): asserts value is QueueClaim {
  const claim = object(value); exact(claim,['itemId','ownerToken','generation']);
  nonempty(claim.itemId); nonempty(claim.ownerToken);
  if (generation(claim.generation) === 0) invalid();
}
export function validateOutcome(name: string, value: unknown) {
  if (name === 'start') { const result = object(value); exact(result,['started','item']); if(typeof result.started !== 'boolean') invalid(); validateOutcome('enqueue',result.item); return; }
  if (name === 'claim' || name === 'claimNext') { if (value !== null) validateClaim(value); return; }
  if (name === 'removeTerminal') { if (value !== true) invalid(); return; }
  const result = object(value); exact(result,['value','version']); nonempty(result.version); validateItem(result.value);
}
export function validateReceipt(value: unknown): asserts value is {intent: string; outcome: unknown} {
  const receipt = object(value); exact(receipt,['intent','outcome']); nonempty(receipt.intent);
}
export function validateEnqueue(value: unknown) {
  const input = object(value);
  if (Object.keys(input).some(k => !['id','queue','payload','priority','availableAt','subject','kind'].includes(k))) invalid();
  if (!Object.hasOwn(input,'payload')) invalid();
}
