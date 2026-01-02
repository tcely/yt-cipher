import type { WorkerWithLimit, Task } from "./types.ts";

const CONCURRENCY = parseInt(Deno.env.get("MAX_THREADS") || "", 10) || navigator.hardwareConcurrency || 1;

const workers: WorkerWithLimit[] = [];
const idleWorkerStack: WorkerWithLimit[] = [];
const taskQueue: Task[] = [];
const inFlightTask = new WeakMap<WorkerWithLimit, Task>();

function dispatch() {
    if (!(workers.length > 0)) fillWorkers();
    while (idleWorkerStack.length > 0 && taskQueue.length > 0) {
        const idleWorker = idleWorkerStack.pop()!;
        const task = taskQueue.shift()!;

        const messageHandler = (e: MessageEvent) => {
            idleWorker.removeEventListener("message", messageHandler);
            inFlightTask.delete(idleWorker);
            if (idleWorker.messagesLeft > 0) {
                idleWorkerStack.push(idleWorker);
            } else {
                // stop the finished worker
                idleWorker.terminate();
                // remove from workers
                const queueIdx = workers.indexOf(idleWorker);
                if (queueIdx >= 0) workers.splice(queueIdx, 1);
                // replace any missing workers
                fillWorkers();
            }

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
                Promise.resolve().then(() => dispatch()); // keep checking
            }
        };

        idleWorker.messagesLeft -= 1;
        inFlightTask.set(idleWorker, task);
        idleWorker.addEventListener("message", messageHandler);
        idleWorker.postMessage(task.data);
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
            const task = inFlightTask.get(worker);
            if (task) {
                inFlightTask.delete(worker);
                // reject the task that was assigned to this worker
                task.reject(new Error(`Worker crashed: ${e.message}`));
            }

            // remove crashed worker from tracking structures
            const queueIdx = workers.indexOf(worker);
            if (queueIdx >= 0) workers.splice(queueIdx, 1);

            const stackIdx = idleWorkerStack.indexOf(worker);
            if (stackIdx >= 0) idleWorkerStack.splice(stackIdx, 1);

            try {
                worker.terminate();
            } catch {
                // ignore termination errors
            }

            // replace any missing workers
            fillWorkers(messagesLimit);

            // ensure queued tasks continue processing
            Promise.resolve().then(() => dispatch());
        });

        workers.push(worker);
        idleWorkerStack.push(worker);
    }
}

export function initializeWorkers() {
    fillWorkers();
    console.log(`Initialized ${CONCURRENCY} workers`);
}

