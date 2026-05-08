# browser-agent-os

Browser-resident WebAssembly microkernel for capability-scoped, multi-process AI agents and UNIX-style tools.

## Philosophy

- **WebAssembly is the sandbox.** Every meaningful execution boundary is a WASM module.
- **The browser is the hypervisor.** Web Workers are our threads, OPFS is our disk, the browser tab is our machine.
- **POSIX-shaped where it fits.** WASI Preview 1 is honoured. Browser-incompatible syscalls are omitted, not faked.
- **Thin TypeScript, fat WebAssembly.** TS glue exists only to bridge browser APIs to WASM imports. Real logic lives in WASM where it can be sandboxed.

## Stack

- **Mise** — tool versioning
- **Bun** — TypeScript runtime, package manager, tests
- **Zig 0.16.0** — WASM binaries (`-target wasm32-wasi`)
- **Allium** — behavioural specifications (added per package as they stabilise)

## Repository layout

```
browser-agent-os/
├── README.md
├── mise.toml                     ← tool versions
├── package.json                  ← Bun workspace root
├── tsconfig.json
├── docs/
│   └── ARCHITECTURE.md           ← layered architecture
└── packages/
    └── kernel/                   ← @browser-agent-os/kernel: browser-side WASI implementation (TS)
```

## Architecture summary

The browser tab boots a TypeScript runtime (`@browser-agent-os/kernel`) that exposes a WASI Preview 1 syscall surface to WebAssembly guests. Guests run in Web Workers with their own linear memory. OPFS is the filesystem. JSPI bridges async browser APIs to synchronous WASM imports. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

Greenfield. Skeleton only.

## Inspiration

Reference implementations studied during design (none vendored as dependencies):

| Project | What we lifted |
|---|---|
| [Antmicro jswasi](https://github.com/antmicro/jswasi) | Kernel structure, syscall table, multi-FS, process model |
| [Antmicro wash](https://github.com/antmicro/wash) | POSIX shell on WASI, pipe semantics |
| [openbrowserclaw](https://github.com/wexare-ai/openbrowserclaw) | IndexedDB schema, AES-GCM key encryption (agent layer) |
| [nullclaw](https://github.com/nullclaw/nullclaw) | Agent loop, tool dispatch, providers |
| [WebAssembly/wasi-libc](https://github.com/WebAssembly/wasi-libc) | Canonical WASI Preview 1 ABI reference |

## License

TBD.
