const PREFIX = '[CarrierPigeon][timing]';

/** Runs fn and logs how long it took under a consistent, greppable prefix. */
export async function timed<T>(label: string, fn: () => T | PromiseLike<T>): Promise<T> {
    const start = Date.now();
    try {
        return await fn();
    } finally {
        console.log(`${PREFIX} ${label}: ${Date.now() - start}ms`);
    }
}

/** Logs a standalone timing measurement (for code that can't be wrapped). */
export function logTiming(label: string, startMs: number): void {
    console.log(`${PREFIX} ${label}: ${Date.now() - startMs}ms`);
}
