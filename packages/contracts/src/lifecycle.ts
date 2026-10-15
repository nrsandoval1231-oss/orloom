/** Internal controller-only fence passed between trusted lifecycle authorities. */
export type LifecycleGuard = () => Promise<void>;

export class LifecycleStoppedError extends Error {
  constructor(message = "Lifecycle was stopped before the next effect") { super(message); this.name = "LifecycleStoppedError"; }
}
