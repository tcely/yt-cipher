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
 * Abstract base for TaskQueue implementations.
 *
 * Default behavior:
 * - empty: O(1), derived from `length`
 * - clear(): removes items by repeatedly calling `pop()`
 *   - Expected performance:
 *     - O(n) calls to `pop()`
 *     - If `pop()` is O(1), overall clear is O(n)
 *   - Why pop (not shift): avoids O(n^2) behavior for array-backed queues where `shift()` is O(n).
 *
 * Concrete adapters SHOULD override `clear()` when a more efficient mechanism exists.
 *
 */
abstract class AbstractTaskQueue<T> implements TaskQueue<T> {
    public abstract get length(): number;

    public get empty(): boolean {
        return 0 === this.length;
    }

    public abstract push(...items: T[]): number;
    public abstract pop(): T | undefined;
    public abstract shift(): T | undefined;
    public abstract unshift(...items: T[]): number;

    public clear(): void {
        // O(n) pop() calls;
        //   this relies on pop() being O(1) to keep total O(n).
        while (!this.empty) {
            this.pop();
        }
    }
}

/**
 * Native array-backed TaskQueue implementation.
 *
 * Performance notes:
 * - push/pop: amortized O(1)
 * - shift/unshift: O(n) due to element reindexing
 * - clear(): O(1) by setting length = 0
 *
 */
class ArrayTaskQueue<T> extends AbstractTaskQueue<T> implements TaskQueue<T> {
    private readonly items: T[] = [];

    // Match Array#length usage
    public get length(): number {
        return this.items.length;
    }

    // Match Array#push(...items) usage
    public push(...items: T[]): number {
        return this.items.push(...items);
    }

    // Match Array#pop() usage
    public pop(): T | undefined {
        return this.items.pop();
    }

    // Match Array#shift() usage
    public shift(): T | undefined {
        return this.items.shift();
    }

    // Match Array#unshift(...items) usage
    public unshift(...items: T[]): number {
        return this.items.unshift(...items);
    }

    // Match "clear the queue" semantics
    public clear(): void {
        // O(1) clear for arrays.
        this.items.length = 0;
    }
}

/**
 * Adapter for jsr:@alg/deque
 *
 * Performance notes (expected):
 * - pushBack/popBack/pushFront/popFront: O(1)
 * - clear(): O(1) by re-initializing the deque
 *
 * Safety:
 * - AlgDeque throws on pop/shift from empty; we guard and return undefined.
 *
 */
class AlgTaskQueueAdapter<T> extends AbstractTaskQueue<T> implements TaskQueue<T> {
    // implements linked blocks of arrays
    private dq: AlgDeque<T> = new AlgDeque<T>();

    public get length(): number {
        return this.dq.length;
    }

    /**
     * TaskQueue API is Array-like and variadic:
     *   push(...items: T[]): number
     *
     * jsr:@alg/deque provides:
     *   pushBack(item: T): void            // single item
     *   pushAllBack(items: Iterable<T>): void // one iterable, not variadic
     *
     * We forward the rest-parameter array (`items`) to `pushAllBack` since
     * arrays are Iterable<T>. This preserves `queue.push(a, b, c)` semantics.
     *
     */
    public push(...items: T[]): number {
        // Match Array#push: commonly returns new length; since underlying deque doesn’t, return length ourselves.
        // items: T[] is treated as Iterable<T>
        this.dq.pushAllBack(items);

        return this.length;
    }

    public pop(): T | undefined {
        // AlgDeque throws on empty; we avoid exceptions by guarding.
        if (this.empty) {
            return undefined;
        }

        return this.dq.popBack();
    }

    public shift(): T | undefined {
        // AlgDeque throws on empty; we avoid exceptions by guarding.
        if (this.empty) {
            return undefined;
        }

        return this.dq.popFront();
    }

    public unshift(...items: T[]): number {
        // Preserve Array#unshift order:
        // unshift(a, b) => a becomes index 0, then b becomes index 1.
        // Using pushFront repeatedly per-item needs reverse iteration.
        for (let i = items.length - 1; i >= 0; i--) {
            this.dq.pushFront(items[i]);
        }
        return this.length;
    }

    public clear(): void {
        // O(1) clear by replacing the underlying deque instance.
        this.dq = new AlgDeque<T>();
    }
}

/**
 * Adapter for jsr:@korkje/deque
 *
 * Performance notes (expected):
 * - push/pop/shift/unshift: O(1) amortized (circular buffer)
 * - clear(): O(1) via dq.clear()
 *
 * Safety:
 * - We guard pop/shift to ensure undefined when empty regardless of library behavior.
 *
 */
class KorkjeTaskQueueAdapter<T> extends AbstractTaskQueue<T> implements TaskQueue<T> {
    // manages an underlying array with a circular buffer
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
        // KorkjeDeque is not expected to throw; we guard anyway.
        if (this.empty) {
            return undefined;
        }

        return this.dq.pop();
    }

    public shift(): T | undefined {
        // KorkjeDeque is not expected to throw; we guard anyway.
        if (this.empty) {
            return undefined;
        }

        return this.dq.shift();
    }

    public unshift(...items: T[]): number {
        // Preserve Array#unshift order.
        // unshift(a, b) => a becomes index 0, then b becomes index 1.
        // Using unshift repeatedly per-item needs reverse iteration.
        for (let i = items.length - 1; i >= 0; i--) {
            this.dq.unshift(items[i]);
        }
        return this.length;
    }

    public clear(): void {
        this.dq.clear();
    }
}
