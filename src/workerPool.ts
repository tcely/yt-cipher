import type { InFlight, Task, WorkerWithLimit } from "./types.ts";

const CONCURRENCY = parseInt(Deno.env.get("MAX_THREADS") || "", 10) || navigator.hardwareConcurrency || 1;

const workers: WorkerWithLimit[] = [];
const idleWorkerStack: WorkerWithLimit[] = [];
const taskQueue: Task[] = [];
const inFlightTask = new WeakMap<WorkerWithLimit, InFlight>();

function removeWorkerFromTracking(worker: WorkerWithLimit) {
    const queueIdx = workers.indexOf(worker);
    if (queueIdx >= 0) workers.splice(queueIdx, 1);
    const stackIdx = idleWorkerStack.indexOf(worker);
    if (stackIdx >= 0) idleWorkerStack.splice(stackIdx, 1);
}

function retireWorker(worker: WorkerWithLimit) {
    removeWorkerFromTracking(worker);
    try {
        worker.terminate();
    } catch {
        // ignore termination errors
    }
}

function scheduleRefillAndDispatch(messagesLimit: number) {
    queueMicrotask(() => {
        fillWorkers(messagesLimit);
        dispatch();
    });
}

function releaseWorker(
    worker: WorkerWithLimit,
    messagesLimit: number = 10_000,
) {
    // Ensure we don't leak message handlers or keep stale in-flight state
    clearInFlight(worker);

    if (worker.messagesLeft > 0) {
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
    inFlightTask.set(worker, { task, messageHandler });
}

function clearInFlight(worker: WorkerWithLimit): InFlight | undefined {
    const inFlight = inFlightTask.get(worker);
    if (inFlight) {
        worker.removeEventListener("message", inFlight.messageHandler);
        inFlightTask.delete(worker);
    }
    return inFlight;
}

function dispatch() {
    if (!(workers.length > 0)) fillWorkers();
    while (idleWorkerStack.length > 0 && taskQueue.length > 0) {
        const idleWorker = idleWorkerStack.pop()!;
        const task = taskQueue.shift()!;

        const messageHandler = (e: MessageEvent) => {
            releaseWorker(idleWorker);
            try {
                const { type, data } = (e.data ?? {}) as { type?: string; data?: any };
                if (type === "success") {
                    task.resolve(data);
                } else {
                    console.error("Received error from worker:", data);
                    const err = new Error(data?.message ?? "Worker error");
                    err.stack = data?.stack;
                    task.reject(err);
                }
            } finally {
                fillWorkers();
                dispatch();
            }
        };

        try {
            idleWorker.messagesLeft -= 1;
            setInFlight(idleWorker, task, messageHandler);
            idleWorker.addEventListener("message", messageHandler);
            idleWorker.postMessage(task.data);
        } catch (err) {
            // Worker may be unusable; replace it to avoid pool deadlocks.
            idleWorker.messagesLeft = 0;
            releaseWorker(idleWorker);

            task.reject(err);
        }
    }
}

export function execInPool(data: string): Promise<string> {
    return new Promise((resolve, reject) => {
        taskQueue.push({ data, resolve, reject });
        dispatch();
    });
}

function fillWorkers(messagesLimit: number = 10_000) {
    while (workers.length < CONCURRENCY) {
        const worker: WorkerWithLimit = new Worker(new URL("../worker.ts", import.meta.url).href, { type: "module" });
        worker.messagesLeft = messagesLimit;
        worker.addEventListener("error", (e: ErrorEvent) => {
            console.error("Worker crashed:", e.message);
            const inFlight = clearInFlight(worker);
            if (inFlight) {
                // reject the task that was assigned to this worker
                inFlight.task.reject(new Error(`Worker crashed: ${e.message}`));
            }

            // remove crashed worker
            retireWorker(worker);
            
            // replace any missing workers + ensure queued tasks continue processing
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

