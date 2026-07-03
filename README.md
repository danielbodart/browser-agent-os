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
├── mise.toml                     ← tool versions + task chain
├── package.json                  ← Bun workspace root
├── tsconfig.json
├── scripts/
│   └── wasm-opt.ts               ← Binaryen wasm-opt -Oz pipeline
├── docs/
│   └── ARCHITECTURE.md           ← layered architecture
└── packages/
    ├── kernel/                   ← @browser-agent-os/kernel: env-agnostic WASI core (TS)
    ├── host-bun/                 ← @browser-agent-os/host-bun: Bun dev server + tests
    ├── host-browser/             ← @browser-agent-os/host-browser: xterm.js + OPFS browser host
    ├── shell/                    ← Zig package: sh.wasm (parser, pipes, redirects, REPL)
    └── coreutils/                ← Zig package, multiple wasm32-wasi binaries (echo, cat, ls, ...)
```

## Quick start

```
mise install              # bun + zig + node
mise run build:bins       # zig build + wasm-opt
mise run test             # full suite (kernel + coreutils + shell + headless-Chrome smoke)
mise run dev              # Bun dev server on :3000 serving /bin/<name>
mise run dev:browser      # browser host: xterm.js + kernel in a real tab on :3000
```

## Architecture summary

The browser tab boots a TypeScript runtime (`@browser-agent-os/kernel`) that exposes a WASI Preview 1 syscall surface to WebAssembly guests. Guests run in Web Workers with their own linear memory. OPFS is the filesystem. JSPI bridges async browser APIs to synchronous WASM imports. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

Stages 0–6 done (see [docs/ROADMAP.md](docs/ROADMAP.md)). A real browser tab
boots xterm.js over the kernel: a Zig shell reads from stdin, spawns coreutils
binaries as separate Web Workers, and wires pipes and `<`/`>`/`>>` redirects
via the `browser_agent_os_ext` namespace. Filesystem is `MemoryFs` or OPFS
(persistent across reloads) behind one `FileSystem` contract. A single
`JSPITransport` (`WebAssembly.Suspending` + `promising`) runs in-process under
Bun and inside Web Workers in Chrome — no `SharedArrayBuffer`, no COOP/COEP.
Coreutils: `echo`, `cat`, `ls`, `pwd`, `head`, `tail`, `wc`, `env`, `true`,
`false`, `mkdir`, `rmdir`, `rm`, `cp`, `mv`, `touch`.

Next: Stage 7 (CI/CD) → Stage 8 (R2 firmware overlay FS).

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
