# Architecture

## Layers

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 3 — Guest code                                            │
│  Agents, shells, scripts. Anything compiled to wasm32-wasi.      │
│  One Web Worker per process.                                     │
└────────────────────────────┬─────────────────────────────────────┘
                             │ syscalls (WASM imports)
┌────────────────────────────▼─────────────────────────────────────┐
│  Layer 2 — Kernel (@browser-agent-os/kernel)                     │
│  TypeScript. Implements the WASI Preview 1 syscall surface as    │
│  Web Worker imports. Wraps OPFS, JSPI, Web Workers, fetch.       │
└────────────────────────────┬─────────────────────────────────────┘
                             │ wraps
┌────────────────────────────▼─────────────────────────────────────┐
│  Layer 1 — Browser primitives                                    │
│  Web Workers, SharedArrayBuffer, Atomics, OPFS, WebAssembly,     │
│  JSPI, fetch, WebCrypto, IndexedDB.                              │
└──────────────────────────────────────────────────────────────────┘
```

## Key principles

- **WebAssembly is the sandbox.** Capability and isolation guarantees come from WASM linear memory + import gating.
- **One linear memory per process.** No shared memory between guests; communication via pipes or message passing.
- **All blocking syscalls suspend via JSPI.** No Asyncify.
- **POSIX shape preserved where supportable.** Names match WASI Preview 1; behaviour matches POSIX semantics within browser limits.
- **Browser-incompatible syscalls are omitted.** Guests importing unsupported entries fail at instantiation. Loud, not silent.
- **Thin TypeScript, fat WebAssembly.** TS exists only to bridge browser APIs to WASM imports.

## What we do not implement

- `proc_raise` / signal delivery — no signal mechanism in browser
- Sockets (`sock_recv`, `sock_send`, `sock_shutdown`) — no raw sockets in browser
- `path_symlink` / symlink-related ops — OPFS has no symlinks
- `fork` / `exec` — process spawning will land as a `browser_agent_os_ext` extension when defined
- `flock` / process-shared file locking — not portable to OPFS
