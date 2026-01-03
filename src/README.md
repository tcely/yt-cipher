## Environment variables

### `MAX_THREADS`
Controls the maximum number of workers used by the pool.

- Type: integer
- Default: `navigator.hardwareConcurrency` (or `1` if unavailable)
- Behavior:
  - If set to a valid integer, the pool will create up to that many workers.
  - If unset/invalid, the pool falls back to `navigator.hardwareConcurrency`, then `1`.

### `MESSAGES_LIMIT`
Controls how many tasks (messages) a single worker will process before being retired and replaced.
This helps prevent long-lived workers from accumulating memory/GC pressure over time.

- Type: integer
- Default: `10000`
- Behavior:
  - If set to a positive integer, each worker starts with that message budget.
  - When a worker reaches `0` remaining messages, it is terminated and replaced.
