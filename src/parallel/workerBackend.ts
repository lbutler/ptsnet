/**
 * Worker spawning abstracted across Node (`worker_threads`) and the browser
 * (Blob `Worker`), plus a SharedArrayBuffer capability check used to fall back
 * to the serial engine when parallelism isn't available.
 */

export interface WorkerHandle {
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface WorkerBackend {
  readonly kind: 'node' | 'browser';
  spawn(source: string): WorkerHandle;
}

/**
 * Whether SharedArrayBuffer-backed parallelism is usable here. In the browser
 * this requires cross-origin isolation (COOP/COEP headers); in Node it's always
 * available (`crossOriginIsolated` is undefined there).
 */
export function sabUsable(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  const coi = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  if (coi === false) return false;
  return true;
}

function isNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return proc?.versions?.node != null;
}

/**
 * Resolve a worker backend for the current environment, or `null` if parallel
 * execution isn't supported (caller should fall back to the serial engine).
 */
export async function resolveBackend(): Promise<WorkerBackend | null> {
  if (!sabUsable()) return null;

  if (isNode()) {
    // Indirect specifier + vite-ignore so browser bundlers don't resolve it.
    const spec = 'node:worker_threads';
    const wt = (await import(/* @vite-ignore */ spec)) as {
      Worker: new (source: string, options: { eval: true }) => {
        postMessage(m: unknown): void;
        terminate(): unknown;
      };
    };
    return {
      kind: 'node',
      spawn(source: string): WorkerHandle {
        const w = new wt.Worker(source, { eval: true });
        return {
          postMessage: (m) => w.postMessage(m),
          terminate: () => {
            w.terminate();
          },
        };
      },
    };
  }

  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
    return {
      kind: 'browser',
      spawn(source: string): WorkerHandle {
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const w = new Worker(url);
        return {
          postMessage: (m) => w.postMessage(m),
          terminate: () => {
            w.terminate();
            URL.revokeObjectURL(url);
          },
        };
      },
    };
  }

  return null;
}
