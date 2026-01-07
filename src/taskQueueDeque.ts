import type { TaskQueue } from "./types.ts";

import { Deque as AlgDeque } from "jsr:@alg/deque";
import { Deque as KorkjeDeque } from "jsr:@korkje/deque";

type DequeImpl = "alg" | "korkje";

function getDequeImpl(): DequeImpl {
    const v = (Deno.env.get("TASK_QUEUE_DEQUE_IMPL") || "").toLowerCase();
    if (v === "korkje") return "korkje";
    return "alg";
}

export function createTaskQueue<T>(): TaskQueue<T> {
    const impl = getDequeImpl();
    return impl === "korkje"
        ? new KorkjeTaskQueueAdapter<T>()
        : new AlgTaskQueueAdapter<T>();
}

class AlgTaskQueueAdapter<T> extends AlgDeque implements TaskQueue<T> {
    // implements blocks of arrays

    public push(item: T): number {
        // Match Array#push: commonly returns new length; the underlying deque doesn’t, so return length ourselves.
        this.pushBack(item);
        return this.length;
    }

    public shift(): T | undefined {
        // Match Array#shift: by returning undefined when empty.

        /**
         * Avoid the expensive exception by checking the condition first.
         *
         * popFront() {
         *     if (this.#size === 0) {
         *         throw new Error("Called `.popFront` on empty queue");
         *     }
         */
        if (0 === this.length) {
            return undefined;
        }

        return this.popFront();
    }
}

class KorkjeTaskQueueAdapter<T> extends KorkjeDeque implements TaskQueue<T> {
    // manages an underlying array with a ring buffer
}
