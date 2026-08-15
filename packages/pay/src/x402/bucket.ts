export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = clock();
  }
  take(): boolean {
    const now = this.clock();
    const gained = Math.floor((now - this.last) / this.refillMs) * this.capacity;
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.last = now;
    }
    if (this.tokens <= 0) return false;
    this.tokens--;
    return true;
  }
}
