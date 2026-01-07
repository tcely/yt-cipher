import type { TaskQueue } from "./types.ts";

import { Deque as AlgDeque } from "jsr:@alg/deque";
import { Deque as KorkjeDeque } from "jsr:@korkje/deque";

type DequeImpl = "alg" | "korkje" | "native";

function getDequeImpl(): DequeImpl {
    const v = (Deno.env.get("TASK_QUEUE_DEQUE_IMPL") || "").toLowerCase();
    if (v === "native") return "native";
    if (v === "korkje") return "korkje";
    return "alg";
}

export function createTaskQueue<T>(): TaskQueue<T> {
    const impl = getDequeImpl();

    if ("native" === impl) return new ArrayTaskQueue<T>();
    if ("korkje" === impl) return new KorkjeTaskQueueAdapter<T>();
    return new AlgTaskQueueAdapter<T>();
}


/**
* Base TaskQueue implementation using a plain Array.
* Adapters can extend this and override behavior if needed.
*/
class ArrayTaskQueue<T> implements TaskQueue<T> {
    protected items: T[] = [];

    /** Match Array#length usage */
    public get length(): number {
        return this.items.length;
    }

    /** Convenience boolean; should be implemented as `0 === this.length` */
    public get empty(): boolean {
        return 0 === this.length;
    }

    /** Match Array#push(...items) usage */
    public push(...items: T[]): number {
        return this.items.push(...items);
    }

    /** Match Array#pop() usage */
    public pop(): T | undefined {
        return this.items.pop();
    }

    /** Match Array#shift() usage */
    public shift(): T | undefined {
        return this.items.shift();
    }

    /** Match Array#unshift(...items) usage */
    public unshift(...items: T[]): number {
        return this.items.unshift(...items);
    }

    /** Match "clear the queue" semantics */
    public clear(): void {
        this.items.length = 0;
    }
}

class AlgTaskQueueAdapter<T> extends ArrayTaskQueue<T> implements TaskQueue<T> {
    // implements blocks of arrays
    private dq: AlgDeque<T> = new AlgDeque<T>();

    public get length(): number {
        return this.dq.length;
    }

    public push(...items: T[]): number {
        // Match Array#push: commonly returns new length; if underlying deque doesn’t, return length ourselves.
        this.dq.pushAllBack(items);
        return this.length;
    }

    public pop(): T | undefined {
        if (this.empty) {
            return undefined;
        }

        // AlgDeque throws on empty; we avoid exceptions by guarding.
        return this.dq.popBack();
    }

    public shift(): T | undefined {
        if (this.empty) {
            return undefined;
        }

        // AlgDeque throws on empty; we avoid exceptions by guarding.
        return this.dq.popFront();
    }

    public unshift(...items: T[]): number {
        // Must match Array#unshift order:
        // unshift(a, b) => a becomes index 0, then b becomes index 1.
        // Using pushFront repeatedly must be done in reverse order.
        for (let i = items.length - 1; i >= 0; i--) {
            this.dq.pushFront(items[i]);
        }
        return this.length;
    }

    public clear(): void {
        // AlgDeque does not expose clear(); fastest is to re-init.
        this.dq = new AlgDeque<T>();
    }
}

class KorkjeTaskQueueAdapter<T> extends ArrayTaskQueue<T> implements TaskQueue<T> {
    // manages an underlying array with a ring buffer
    private readonly dq = new KorkjeDeque<T>();

    public get length(): number {
        return this.dq.length;
    }

    public get empty(): boolean {
        return this.dq.isEmpty();
    }

    public push(...items: T[]): number {
        for (const item of items) {
            this.dq.push(item);
        }
        return this.length;
    }

    public pop(): T | undefined {
        return this.dq.pop();
    }

    public shift(): T | undefined {
        return this.dq.shift();
    }

    public unshift(...items: T[]): number {
        // Must preserve Array#unshift order; unshift per-item needs reverse iteration.
        for (let i = items.length - 1; i >= 0; i--) {
            this.dq.unshift(items[i]);
        }
        return this.length;
    }

    public clear(): void {
        this.dq.clear();
    }
}
