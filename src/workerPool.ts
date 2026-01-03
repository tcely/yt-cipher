import type { InFlight, Task, WorkerWithLimit } from "./types.ts";

const CONCURRENCY = parseInt(Deno.env.get("MAX_THREADS") || "", 10) || navigator.hardwareConcurrency || 1;

// Keep the per-worker message budget consistent across the module.
// (Optional env override for testing/tuning.)
const parsedMessagesLimit = parseInt(Deno.env.get("MESSAGES_LIMIT") || "", 10);
const MESSAGES_LIMIT = Number.isFinite(parsedMessagesLimit) && parsedMessagesLimit > 0
    ? parsedMessagesLimit
    : 10_000;

const workers: WorkerWithLimit[] = [];
const idleWorkerStack: WorkerWithLimit[] = [];
const taskQueue: Task[] = [];
const inFlightTask = new WeakMap<WorkerWithLimit, InFlight>();
const inFlightWorker: Set<WorkerWithLimit> = new Set<WorkerWithLimit>();

function removeWorkerFromTracking(worker: WorkerWithLimit) {
    const queueIdx = workers.indexOf(worker);
    if (queueIdx >= 0) workers.splice(queueIdx, 1);
    const stackIdx = idleWorkerStack.indexOf(worker);
    if (stackIdx >= 0) idleWorkerStack.splice(stackIdx, 1);
}

function retireWorker(worker: WorkerWithLimit) {
    // Defensive: ensure we don't leak message handlers or keep stale in-flight state
    clearInFlight(worker);
    inFlightWorker.delete(worker);

    removeWorkerFromTracking(worker);
    try {
        worker.terminate();
    } catch {
        // ignore termination errors
    }
}

let refillScheduled = false;

function scheduleRefillAndDispatch(messagesLimit: number = MESSAGES_LIMIT) {
    if (refillScheduled) return;
    refillScheduled = true;
    queueMicrotask(() => {
        refillScheduled = false;
        try {
            fillWorkers(messagesLimit);
            dispatch();
        } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));

            // Suspicious state recovery:
            // - Keep queued tasks intact so they can be processed after recovery.
            // - Do NOT clear in-flight handlers for tracked workers here; allow in-flight work to complete normally.
            // - Quarantine all tracked workers by draining `workers` and setting their budget to 0.
            // - Retire all currently-idle workers immediately.
            // - Any quarantined worker that is not actually in-flight has no path to be observed/released,
            //   so terminate it now to avoid "zombie" workers.
            console.error("Worker pool refill/dispatch failed; attempting recovery:", e);

            const quarantined: WorkerWithLimit[] = [];
            while (workers.length > 0) {
                const w = workers.pop()!;
                w.messagesRemaining = 0;
                quarantined.push(w);
            }
            const quarantinedSet = new Set(quarantined);

            while (idleWorkerStack.length > 0) {
                const idle = idleWorkerStack.pop()!;
                retireWorker(idle);
            }

            // Terminate quarantined workers that are not actually in-flight.
            for (const w of quarantined) {
                if (!inFlightTask.get(w)) {
                    retireWorker(w);
                }
            }

            // Consistency check: every worker we believe is in-flight must have been quarantined.
            // If an unexpected in-flight worker exists, reject/cleanup/terminate it.
            for (const w of [...inFlightWorker]) {
                if (quarantinedSet.has(w)) continue;
                console.error("Found unexpected in-flight worker during recovery; rejecting and terminating it.");
                try {
                    const inFlight = clearInFlight(w);
                    if (inFlight) {
                        try {
                            inFlight.task.reject(e);
                        } catch {
                            // ignore user reject handler throws
                        }
                    }
                } finally {
                    retireWorker(w);
                }
            }

            // Track the workers being allowed to finish their assignments.
            // (Workers that were not actually in-flight have been terminated above.)
            for (const w of quarantined) {
                inFlightWorker.add(w);
            }

            // Try to recover by recreating a fresh pool on the next tick.
            scheduleRefillAndDispatch(messagesLimit);
        }
    });
}

function releaseWorker(
    worker: WorkerWithLimit,
    messagesLimit: number = MESSAGES_LIMIT,
) {
    // Only release once: if nothing is in-flight, don't re-add/retire twice.
    const inFlight = clearInFlight(worker);
    if (!inFlight) return;

    if (worker.messagesRemaining > 0) {
        if (inFlightWorker.has(worker)) {
            // Worker tracking is inconsistent
            retireWorker(worker);
        } else {
            // Worker can take more work
            idleWorkerStack.push(worker);
        }
    } else {
        // Worker hit its limit; remove & replace
        retireWorker(worker);
    }

    // Keep the pool healthy and keep draining the queue
    scheduleRefillAndDispatch(messagesLimit);
}

function setInFlight(
    worker: WorkerWithLimit,
    task: Task,
    messageHandler: (e: MessageEvent) => void,
) {
    inFlightWorker.add(worker);
    inFlightTask.set(worker, { task, messageHandler });
}

function clearInFlight(worker: WorkerWithLimit): InFlight | undefined {
    const inFlight = inFlightTask.get(worker);
    if (inFlight) {
        worker.removeEventListener("message", inFlight.messageHandler);
        inFlightTask.delete(worker);
        inFlightWorker.delete(worker);
    }
    return inFlight;
}

function dispatch() {
    if (workers.length < CONCURRENCY) fillWorkers(MESSAGES_LIMIT);
    while (idleWorkerStack.length > 0 && taskQueue.length > 0) {
        const idleWorker = idleWorkerStack.pop()!;
        if (!Number.isFinite(idleWorker.messagesRemaining) || idleWorker.messagesRemaining <= 0) {
            retireWorker(idleWorker);
            scheduleRefillAndDispatch();
            continue;
        }
        const task = taskQueue.shift()!;

        const messageHandler = (e: MessageEvent) => {
            const { type, data } = (e.data ?? {}) as { type?: string; data?: any };

            if (type === "success") {
                try {
                    if (typeof data !== "string") {
                        idleWorker.messagesRemaining = 0;
                        try {
                            task.reject(new Error("Worker returned non-string success payload"));
                        } catch {
                            // ignore user reject handler throws
                        }
                    } else {
                        try {
                            task.resolve(data);
                        } catch {
                            // ignore user resolve handler throws
                        }
                    }
                } finally {
                    releaseWorker(idleWorker);
                }
                return;
            }

            console.error("Received error from worker:", data);
            const err = new Error(data?.message ?? "Worker error");
            err.stack = data?.stack;

            // Treat worker-reported errors as potentially unhealthy.
            idleWorker.messagesRemaining = 0;
            try {
                try {
                    task.reject(err);
                } catch {
                    // ignore user reject handler throws
                }
            } finally {
                releaseWorker(idleWorker);
            }
        };

        try {
            idleWorker.messagesRemaining -= 1;
            setInFlight(idleWorker, task, messageHandler);
            idleWorker.addEventListener("message", messageHandler);
            idleWorker.postMessage(task.data);
        } catch (err) {
            // Worker may be unusable; replace it to avoid pool deadlocks.
            idleWorker.messagesRemaining = 0;
            releaseWorker(idleWorker);

            try {
                task.reject(err);
            } catch {
                // ignore user reject handler throws
            }
        }
    }
}

// When set, the pool is considered "fatally" broken and new work should fail fast.
// NOTE: This pull request includes the guard/checks, but does not actively set this value yet.
// See the TODO comments below for what kind of decisions need to be made before proceeding.
let poolInitError: Error | null = null;

export function execInPool(data: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // TODO: Before enabling `poolInitError` by setting it anywhere:
        // - Define what counts as a *fatal* pool failure (only worker construction? repeated crashes? permissions?).
        // - Decide if/when it should be cleared (never vs. on later successful `fillWorkers()`).
        // - Decide whether callers should always fail fast or whether retry/backoff should be attempted.
        // Until those decisions are made, `poolInitError` should remain unset (null).
        if (poolInitError) {
            reject(poolInitError);
            return;
        }

        const task = { data, resolve, reject };
        taskQueue.push(task);
        scheduleRefillAndDispatch();
    });
}

function fillWorkers(messagesLimit: number = MESSAGES_LIMIT) {
    while (workers.length < CONCURRENCY) {
        let worker: WorkerWithLimit;
        try {
            worker = new Worker(new URL("../worker.ts", import.meta.url).href, { type: "module" }) as WorkerWithLimit;
        } catch (err) {
            // Avoid leaving tasks stuck if workers cannot be created.
            const e = err instanceof Error ? err : new Error(String(err));

            // Example (intentionally not enabled): latch a fatal init/start failure so future calls fail fast.
            // poolInitError ??= new Error(`Failed to start worker: ${e.message}`);

            while (taskQueue.length > 0) {
                const t = taskQueue.shift()!;
                try {
                    t.reject(new Error(`Failed to start worker: ${e.message}`));
                } catch {
                    // ignore user-handler failures; keep draining
                }
            }
            break;
        }

        worker.messagesRemaining = messagesLimit;
        worker.addEventListener("error", (e: ErrorEvent) => {
            console.error("Worker crashed:", e.message);
            const inFlight = clearInFlight(worker);
            if (inFlight) {
                // reject the task that was assigned to this worker
                try {
                    inFlight.task.reject(new Error(`Worker crashed: ${e.message}`));
                } catch {
                    // ignore user reject handler throws
                }
            }

            // Example (intentionally not enabled): if you decide worker crashes are fatal for the whole pool:
            // poolInitError ??= new Error(`Worker crashed: ${e.message}`);

            // remove crashed worker
            retireWorker(worker);

            // replace any missing workers + ensure queued tasks continue processing
            scheduleRefillAndDispatch(messagesLimit);
        });

        worker.addEventListener("messageerror", () => {
            console.error("Worker message deserialization failed");
            const inFlight = clearInFlight(worker);
            if (inFlight) {
                try {
                    inFlight.task.reject(new Error("Worker message deserialization failed"));
                } catch {
                    // ignore user reject handler throws
                }
            }

            // Example (intentionally not enabled): if you decide message deserialization failures are fatal:
            // poolInitError ??= new Error("Worker message deserialization failed");

            retireWorker(worker);
            scheduleRefillAndDispatch(messagesLimit);
        });

        workers.push(worker);
        idleWorkerStack.push(worker);
    }
}

export function initializeWorkers() {
    fillWorkers();
    console.log(`Initialized ${CONCURRENCY} workers`);
}

