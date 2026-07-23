interface WorkerError {
  readonly name: string;
  readonly message: string;
  readonly storeCode?: string;
}

interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: WorkerError;
}

interface PendingRequest {
  readonly resolve: (response: WorkerResponse) => void;
}

class Harness {
  #worker: Worker | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();

  async reset(storeName: string): Promise<void> {
    this.terminate();
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(storeName, { recursive: true });
    } catch (cause) {
      if (!(cause instanceof DOMException) || cause.name !== "NotFoundError") throw cause;
    }
  }

  async start(
    storeName: string,
    options: { durability: "relaxed" | "strict"; faultable?: boolean },
  ): Promise<WorkerResponse> {
    this.terminate();
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const pending = this.#pending.get(event.data.id);
      if (pending === undefined) return;
      this.#pending.delete(event.data.id);
      pending.resolve(event.data);
    });
    worker.addEventListener("error", (event) => {
      for (const [id, pending] of this.#pending) {
        pending.resolve({
          id,
          ok: false,
          error: { name: "WorkerError", message: event.message },
        });
      }
      this.#pending.clear();
    });
    this.#worker = worker;
    return this.request("open", { storeName, ...options });
  }

  request(command: string, value?: unknown): Promise<WorkerResponse> {
    if (this.#worker === undefined) throw new Error("OPFS repacked harness worker is not running");
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, { resolve });
      this.#worker!.postMessage({ id, command, value });
    });
  }

  terminate(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    for (const [id, pending] of this.#pending) {
      pending.resolve({ id, ok: false, error: { name: "WorkerTerminated", message: "worker terminated" } });
    }
    this.#pending.clear();
  }
}

declare global {
  interface Window {
    opfsRepackedHarness: Harness;
  }
}

window.opfsRepackedHarness = new Harness();
