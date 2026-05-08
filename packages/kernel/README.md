# @browser-agent-os/kernel

Env-agnostic TypeScript core. No Bun-specific or browser-specific code; both runtimes share this package and inject their own dependencies via `@bodar/yadic`.

## Public API

```ts
import {application} from "@browser-agent-os/kernel";

const app = application({
    binaryResolver: name => new URL(`/bin/${name}`, baseUrl),
    workerFactory: () => new Worker(workerUrl),
});

const result = await app.kernel.spawn("echo", ["hello", "world"]);
// { stdout: Uint8Array("hello world\n"), stderr: ..., exitCode: 0 }
```

## Layout

- `Kernel.ts` — `Kernel` interface
- `LocalKernel.ts` — implementation; spawns a Worker per process
- `Application.ts` — yadic composition factory
- `Process.ts` — `ProcessResult` type
- `worker/runner.ts` — Web Worker entry; instantiates the WASM guest with the WASI preview 1 import surface
- `wasi/Errno.ts` / `wasi/Filetype.ts` — WASI preview 1 constants

## Scope (today)

- WASI preview 1 import shim covering everything a Zig `_start` echo needs: args, environ, fd_write/pwrite/read/pread, fd_close/seek/tell/fdstat_get, fd_prestat_get (no preopens), clock_time_get, random_get, proc_exit, plus ENOSYS stubs for unimplemented operations.
- Stdout/stderr buffered worker-local; flushed via `postMessage` on `proc_exit`.
- One Worker per process. Worker terminates after exit.

## Not yet

- OPFS / persistent filesystem
- JSPI sync-over-async transport (lands with OPFS + pipes)
- Pipes / FIFOs / cross-worker stdio
- `browser_agent_os_ext::spawn` extension
- Allium specs
