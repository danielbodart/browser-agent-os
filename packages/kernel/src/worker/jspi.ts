import {bootRunner, type RunnerIo} from "./wasiCommon.ts";
import type {StartMessage} from "../syscall/wire.ts";

export function bootJspiRunner(io: RunnerIo): void {
    const Suspending = (WebAssembly as any).Suspending;
    const promising = (WebAssembly as any).promising;
    if (!Suspending || !promising) {
        throw new Error('WebAssembly JSPI not available');
    }

    bootRunner<StartMessage>({
        io,
        wrapImports(raw) {
            const out: Record<string, unknown> = {};
            for (const [name, value] of Object.entries(raw)) {
                if (typeof value === 'function' && (value as Function).constructor.name === 'AsyncFunction') {
                    out[name] = new Suspending(value);
                } else {
                    out[name] = value;
                }
            }
            return out;
        },
        async runStart(instance) {
            const startFn = instance.exports._start as () => unknown;
            const promisingStart = promising(startFn) as () => Promise<unknown>;
            await promisingStart();
        },
    });
}
