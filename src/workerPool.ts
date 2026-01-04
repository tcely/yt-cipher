import type { InFlight, InFlightWithTimeout, Task, WorkerWithLimit } from "./types.ts";

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
// Track enqueue timestamps without extending `Task`'s type surface.
const taskEnqueuedAt = new WeakMap<Task, number>();
const inFlightTask = new WeakMap<WorkerWithLimit, InFlight>();
// Workers that currently have an assigned task (purely "in-flight" tracking).
const inFlightWorker: Set<WorkerWithLimit> = new Set<WorkerWithLimit>();
// Workers that must not accept new tasks and must be retired after their current in-flight work finishes.
const retireAfterFlight: Set<WorkerWithLimit> = new Set<WorkerWithLimit>();

// Backpressure / liveness policies
const MAX_TASK_AGE_MS = 30 * 60 * 1000; // 30 minutes
const IN_FLIGHT_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// When set, the pool is considered "fatally" broken and new work should fail fast.
let poolInitError: Error | null = null;

// Bounded recovery with exponential backoff
const RECOVERY_BACKOFF_BASE_MS = 25;
const RECOVERY_BACKOFF_MAX_MS = 5_000;
const RECOVERY_FAILURE_THRESHOLD = 5;
let recoveryBackoffMs = RECOVERY_BACKOFF_BASE_MS;
let recoveryFailures = 0;

let recoveryTimerId: number | null = null;

let refillScheduled = false;

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
        retireAfterFlight.delete(worker);
    } catch {
        // ignore termination errors
    }
}

function scheduleRefillAndDispatch(messagesLimit: number = MESSAGES_LIMIT) {
    // If we've latched a fatal failure, fail fast and drain anything still queued.
    if (poolInitError) {
        drainAndRejectQueuedTasks(poolInitError);
        return;
    }

    // Avoid immediate recursive microtask rescheduling and avoid piling up timers.
    if (refillScheduled) return;
    refillScheduled = true;

    queueMicrotask(() => {
        refillScheduled = false;

        // If a backoff timer is already pending, let it drive the next attempt.
        if (recoveryTimerId !== null) return;

        try {
            fillWorkers(messagesLimit);
            dispatch();

            // Successful run: reset failure counter/backoff.
            recoveryFailures = 0;
            recoveryBackoffMs = RECOVERY_BACKOFF_BASE_MS;
        } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            recoveryFailures += 1;

            console.error(
                `Worker pool refill/dispatch failed (attempt ${recoveryFailures}/${RECOVERY_FAILURE_THRESHOLD}); will retry with backoff:`,
                e,
            );

            // Suspicious state recovery:
            // - Keep queued tasks intact so they can be processed after recovery.
            // - Do NOT clear in-flight handlers for tracked workers here; allow in-flight work to complete normally.
            // - Quarantine all tracked workers by draining `workers` and setting their budget to 0.
            // - Retire all currently-idle workers immediately.
            // - Any quarantined worker that is not actually in-flight has no path to be observed/released,
            //   so terminate it now to avoid "zombie" workers.

            const quarantined: WorkerWithLimit[] = [];
            while (workers.length > 0) {
                const w = workers.pop()!;
                w.messagesRemaining = 0;
                quarantined.push(w);
                // Track the workers being allowed to finish their assignments.
                // When called below, retireWorker is expected to remove from both of these sets.
                inFlightWorker.add(w);
                retireAfterFlight.add(w);
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

            // If we've exceeded our bounded recovery threshold, latch the pool failure and drain queued tasks.
            if (recoveryFailures >= RECOVERY_FAILURE_THRESHOLD) {
                poolInitError ??= new Error(
                    `Worker pool failed to recover after ${recoveryFailures} attempts: ${e.message}`,
                );
                drainAndRejectQueuedTasks(poolInitError);
                return;
            }

            // Exponential backoff with cap (no immediate recursive microtasks).
            const delay = Math.min(recoveryBackoffMs, RECOVERY_BACKOFF_MAX_MS);
            recoveryBackoffMs = Math.min(recoveryBackoffMs * 2, RECOVERY_BACKOFF_MAX_MS);

            recoveryTimerId = setTimeout(() => {
                recoveryTimerId = null;
                scheduleRefillAndDispatch(messagesLimit);
            }, delay) as unknown as number;
        }
    });
}

function releaseWorker(
    worker: WorkerWithLimit,
    messagesLimit: number = MESSAGES_LIMIT,
) {
    // Cleanup any tracked in-flight state (if present), but do not short-circuit:
    // callers may invoke `releaseWorker()` in paths where the task was never successfully tracked.
    clearInFlight(worker);

    // Quarantine marker takes precedence: never return to idle once quarantined.
    if (retireAfterFlight.has(worker)) {
        retireWorker(worker);
    } else if (worker.messagesRemaining > 0) {
        // Worker can take more work
        idleWorkerStack.push(worker);
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
    const timeoutId = setTimeout(() => {
        const inflight = clearInFlight(worker);
        if (inflight) {
            try {
                inflight.task.reject(new Error("Worker task timed out"));
            } catch {
                // ignore user reject handler throws
            }
        }
        retireWorker(worker);
        scheduleRefillAndDispatch();
    }, IN_FLIGHT_TIMEOUT_MS) as unknown as number;

    inFlightTask.set(worker, { task, messageHandler, timeoutId } as InFlightWithTimeout);

}

function clearInFlight(worker: WorkerWithLimit): InFlight | undefined {
    const inFlight = inFlightTask.get(worker);
    if (inFlight) {
        try {
            worker.removeEventListener("message", inFlight.messageHandler);
            const timeoutId = (inFlight as InFlightWithTimeout).timeoutId;
            if (typeof timeoutId === "number") clearTimeout(timeoutId);
        } finally {
            inFlightTask.delete(worker);
            inFlightWorker.delete(worker);
        }
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
        const enqueuedAt = taskEnqueuedAt.get(task) ?? Date.now();
        if (enqueuedAt < (Date.now() - MAX_TASK_AGE_MS)) {
            idleWorkerStack.push(idleWorker);
            try {
                task.reject(new Error("Task was queued longer than allowed"));
            } catch {
                // ignore user reject handler throws
            }
            continue;
        }

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

function drainAndRejectQueuedTasks(err: Error) {
    while (taskQueue.length > 0) {
        const t = taskQueue.shift()!;
        try {
          t.reject(err);
        } catch {
          // ignore user-handler failures; keep draining
        }
    }
}

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

        const task: Task = { data, resolve, reject };
        taskEnqueuedAt.set(task, Date.now());
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

            drainAndRejectQueuedTasks(new Error(`Failed to start worker: ${e.message}`));
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

