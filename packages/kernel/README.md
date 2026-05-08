# @browser-agent-os/kernel

The browser-side kernel: pure TypeScript implementation of the WASI Preview 1 syscall surface (and our `browser_agent_os_ext` extensions, when those land), exported as importable functions for instantiation as Web Worker WASM imports.

## Scope

- TypeScript only. No C, no Zig.
- Implements the dispatch table that satisfies WASI Preview 1 and `browser_agent_os_ext` imports.
- Wraps browser primitives: OPFS, Web Workers, JSPI, fetch.

## Status

Skeleton.
