# @browser-agent-os/kernel

Env-agnostic TypeScript core. No Bun-specific or browser-specific code; both runtimes share this package and inject their own dependencies via `@bodar/yadic`.

## Public API

```ts
import {application, AtomicsTransport} from "@browser-agent-os/kernel";

const transport = new AtomicsTransport({workerFactory, runnerUrl});
const app = application({
    binaryResolver: name => new URL(`/bin/${name}`, baseUrl),
    transport,
});

// Single process — fd 0 is closed (immediate EOF), 1 + 2 captured into result.
const r = await app.kernel.spawn("echo", ["hello"]);
// r = { stdout: "hello\n", stderr: "", exitCode: 0 }

// Pipeline — caller wires fd 1 of producer to fd 0 of consumer.
const {readEnd, writeEnd} = app.kernel.pipe();
const [, catRes] = await Promise.all([
    app.kernel.spawn("echo", ["hello"], {}, new Map([[1, writeEnd]])),
    app.kernel.spawn("cat",  [],        {}, new Map([[0, readEnd]])),
]);
```

## Layout

- `Kernel.ts` — `Kernel` interface (`pipe()`, `spawn()`)
- `LocalKernel.ts` — orchestrates per-process FdMap, allocates collector pipes for unmapped 1/2, drains them into `ProcessResult`
- `Application.ts` — yadic composition factory
- `Process.ts` — `ProcessResult`
- `pipe/Pipe.ts` — `PipeEnd` / `Pipe` / `FdMap` types and `DEFAULT_PIPE_CAPACITY` (64 KiB)
- `pipe/PipeBuffer.ts` — `PipeBuffer` interface + `JsPipeBuffer` (plain async, used by JSPI transport)
- `pipe/AtomicsPipeBuffer.ts` — `SharedArrayBuffer` ring buffer used by Atomics transport
- `transport/Transport.ts` — interface: pipe / drain / closeWriteEnd / spawn
- `transport/AtomicsTransport.ts` — SAB transport; workers run `worker/runner.atomics.ts`
- `transport/JSPITransport.ts` — kernel-resident buffer + worker RPC; workers run a host-supplied script that calls `bootJspiRunner`
- `transport/MessagingWorker.ts` — runtime-agnostic Worker shape (Bun web-Worker / Node `worker_threads` adapt to it)
- `worker/runner.atomics.ts` — Bun web-Worker entry; sync `Atomics.wait` syscalls on the SAB
- `worker/jspi.ts` — `bootJspiRunner({onMessage, postMessage})` — env-agnostic JSPI guest entry; consumers wire it to the runtime's messaging primitive
- `wasi/Errno.ts` / `wasi/Filetype.ts` — preview-1 constants

## Scope (today)

- WASI preview 1 import shim: args, environ, fd_write/pwrite/read/pread, fd_close/seek/tell/fdstat_get, clock_time_get, random_get, proc_exit; ENOSYS for path_*, sock_*, signals.
- Lower-level pipe primitive: `Kernel.pipe()` returns `{readEnd, writeEnd}`; `Kernel.spawn(..., fds)` overrides individual guest fds. No `spawnPipeline` — callers compose.
- Two transports behind one interface; same contract suite green against both.

## Not yet

- OPFS / persistent filesystem
- `path_open` and friends (Stage 2)
- `browser_agent_os_ext::spawn` extension for in-guest process spawn (Stage 4)
- Allium specs
