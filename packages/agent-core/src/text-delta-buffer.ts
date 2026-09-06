export interface TextDeltaBufferOptions {
  emit(text: string): Promise<void>;
  signal: AbortSignal;
  onFailure(error: unknown): void;
  delayMs?: number;
  maxBytes?: number;
}

/** One model content block, never a transport-level or cross-turn buffer. */
export class TextDeltaBuffer {
  readonly #delay: number;
  readonly #maxBytes: number;
  #pending = "";
  #carry = "";
  #bytes = 0;
  #first = true;
  #closed = false;
  #discarded = false;
  #failed = false;
  #failure: unknown;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: TextDeltaBufferOptions) {
    this.#delay = options.delayMs ?? 100;
    this.#maxBytes = options.maxBytes ?? 2048;
    if (!Number.isSafeInteger(this.#delay) || this.#delay < 1 || this.#delay > 1000 ||
        !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 4 || this.#maxBytes > 16_384) throw new Error("Invalid text buffer limits.");
  }

  #assertOpen(): void {
    if (this.#failed) throw this.#failure;
    if (this.#closed) throw new Error("Text block is closed.");
    this.options.signal.throwIfAborted();
  }

  public async push(text: string): Promise<void> {
    this.#assertOpen();
    // Backpressure: never accumulate another event behind a pending database write.
    await this.#tail;
    this.#assertOpen();
    let complete = this.#carry + text;
    this.#carry = "";
    const last = complete.charCodeAt(complete.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) { this.#carry = complete.slice(-1); complete = complete.slice(0, -1); }
    for (const character of complete) {
      const bytes = Buffer.byteLength(character, "utf8");
      if (this.#bytes + bytes > this.#maxBytes) await this.#flush();
      this.#assertOpen();
      this.#pending += character;
      this.#bytes += bytes;
    }
    if (!this.#pending) return;
    if (this.#first || this.#bytes >= this.#maxBytes) {
      this.#first = false;
      await this.#flush();
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        // #flush records its failure; the timer must never create an unhandled rejection.
        void this.#flush().catch(() => undefined);
      }, this.#delay);
      this.#timer.unref();
    }
  }

  #flush(): Promise<void> {
    clearTimeout(this.#timer); this.#timer = undefined;
    if (!this.#pending) return this.#tail;
    const text = this.#pending;
    this.#pending = ""; this.#bytes = 0;
    const operation = this.#tail.then(async () => {
      if (this.#discarded) return;
      this.options.signal.throwIfAborted();
      if (this.#failed) throw this.#failure;
      await this.options.emit(text);
    });
    this.#tail = operation.catch((error: unknown) => {
      if (!this.#failed) {
        this.#failed = true; this.#failure = error;
        try { this.options.onFailure(error); } catch { /* Preserve the original failure. */ }
      }
    });
    // The caller observes failure; #tail itself is always safely drainable.
    return operation;
  }

  public async finish(): Promise<void> {
    this.#assertOpen();
    if (this.#carry) {
      if (this.#bytes + Buffer.byteLength(this.#carry) > this.#maxBytes) await this.#flush();
      this.#pending += this.#carry; this.#bytes += Buffer.byteLength(this.#carry); this.#carry = "";
    }
    this.#closed = true;
    await this.#flush();
    await this.#tail;
    if (this.#failed) throw this.#failure;
    this.options.signal.throwIfAborted();
  }

  /** No new text after cancellation/revocation. Drain already-started writes before terminal events. */
  public async discard(): Promise<void> {
    this.#closed = true; this.#discarded = true;
    clearTimeout(this.#timer); this.#timer = undefined;
    this.#pending = ""; this.#carry = ""; this.#bytes = 0;
    await this.#tail;
  }
}
