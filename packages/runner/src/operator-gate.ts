import type { OperatorResponse } from "./types.js";

export class OperatorGate {
  private pending: { resolve: (response: OperatorResponse) => void } | undefined;
  private queued: OperatorResponse[] = [];

  wait(): Promise<OperatorResponse> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.pending) throw new Error("Runner already has an unresolved operator prompt");
    return new Promise((resolve) => { this.pending = { resolve }; });
  }

  respond(response: OperatorResponse): void {
    if (!this.pending) {
      this.queued.push(response);
      return;
    }
    const { resolve } = this.pending;
    this.pending = undefined;
    resolve(response);
  }

  abort(): void {
    this.respond({ kind: "abort" });
  }
}
