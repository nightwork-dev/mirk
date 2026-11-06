import { canonicalJson } from '@mirk/store/atomic';
import type { JobClaim, JobRecord } from './types.js';
import { JobsError } from './types.js';

const states = ['queued', 'leased', 'blocked', 'succeeded', 'failed', 'cancelled'];
const fields = ['id', 'schemaVersion', 'queue', 'payload', 'state', 'priority', 'enqueuedAt', 'availableAt', 'updatedAt', 'attempt', 'generation', 'ownerToken', 'expiresAt', 'checkpoint', 'cancellation', 'result', 'error'];
function invalid(): never { throw new JobsError('invalid-input', 'Malformed jobs data'); }
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
export function validateJob(value: unknown): asserts value is JobRecord {
  const job = object(value); exact(job, fields);
  if (job.schemaVersion !== 1 || !states.includes(job.state as string)) invalid();
  nonempty(job.id); nonempty(job.queue);
  if (!Number.isSafeInteger(job.priority)) invalid();
  for (const field of ['enqueuedAt','availableAt','updatedAt','attempt','generation']) generation(job[field]);
  if (job.state === 'leased') {
    nonempty(job.ownerToken); generation(job.expiresAt);
    if (job.attempt === 0 || job.generation === 0) invalid();
  } else if (job.ownerToken !== null || job.expiresAt !== null) invalid();
  if (job.cancellation !== null) {
    const cancellation = object(job.cancellation); exact(cancellation,['requestedAt','generation']);
    generation(cancellation.requestedAt);
    if (generation(cancellation.generation) > generation(job.generation) || ['queued','succeeded','failed'].includes(job.state as string)) invalid();
  }
  try { canonicalJson(value); } catch { invalid(); }
}
export function validateClaim(value: unknown): asserts value is JobClaim {
  const claim = object(value); exact(claim,['jobId','ownerToken','generation']);
  nonempty(claim.jobId); nonempty(claim.ownerToken);
  if (generation(claim.generation) === 0) invalid();
}
export function validateOutcome(name: string, value: unknown) {
  if (name === 'claim' || name === 'claimNext') { if (value !== null) validateClaim(value); return; }
  if (name === 'removeTerminal') { if (value !== true) invalid(); return; }
  const result = object(value); exact(result,['value','version']); nonempty(result.version); validateJob(result.value);
}
export function validateReceipt(value: unknown): asserts value is {intent: string; outcome: unknown} {
  const receipt = object(value); exact(receipt,['intent','outcome']); nonempty(receipt.intent);
}
export function validateEnqueue(value: unknown) {
  const input = object(value);
  if (Object.keys(input).some(k => !['id','queue','payload','priority','availableAt'].includes(k))) invalid();
  if (!Object.hasOwn(input,'payload')) invalid();
}
