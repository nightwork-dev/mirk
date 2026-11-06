export interface MemoryAdmission {
  check(): void;
  run<T>(work: () => T | Promise<T>): Promise<T>;
}
interface Participant {
  checkpoint(): unknown;
  restore(state: unknown): void;
  admission?: MemoryAdmission;
}
const participants = new WeakMap<object, Participant>();
export function registerMemoryParticipant(store: object, participant: Participant): void {
  participants.set(store, participant);
}
export function memoryParticipant(store: object): Participant {
  const participant = participants.get(store);
  if (!participant) throw new TypeError("Transactions require the supplied in-memory stores");
  return participant;
}
export function checkMemoryAdmission(store: object): void {
  participants.get(store)?.admission?.check();
}
export function runMemoryOperation<T>(store: object, work: () => T | Promise<T>): Promise<T> {
  const admission = participants.get(store)?.admission;
  return admission ? admission.run(work) : Promise.resolve(work());
}
