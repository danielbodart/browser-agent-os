import {ESUCCESS, EBADF, ESPIPE, ENOSYS} from "../wasi/Errno.ts";
import {CHARACTER_DEVICE} from "../wasi/Filetype.ts";

export interface RunnerIo {
    onMessage(handler: (msg: any) => void): void;
    postMessage(msg: unknown): void;
}

export interface StartMessageBase {
    readonly type: 'start';
    readonly binaryUrl: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
}

export class ProcExit extends Error {
    constructor(public readonly code: number) { super(`proc_exit(${code})`); }
}

export interface MemoryAccessors {
    view(): DataView;
    u8(): Uint8Array;
}

export function memoryAccessors(getMemory: () => WebAssembly.Memory | null): MemoryAccessors {
    let cachedBuffer: ArrayBuffer | null = null;
    let cachedView: DataView = null!;
    let cachedU8: Uint8Array = null!;
    const refresh = () => {
        const m = getMemory();
        if (!m) throw new Error('memory not yet bound');
        if (m.buffer !== cachedBuffer) {
            cachedBuffer = m.buffer;
            cachedView = new DataView(cachedBuffer);
            cachedU8 = new Uint8Array(cachedBuffer);
        }
    };
    return {
        view: () => { refresh(); return cachedView; },
        u8: () => { refresh(); return cachedU8; },
    };
}

export interface BasePreview1Ctx {
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly mem: MemoryAccessors;
    readonly fdHas: (fd: number) => boolean;
}

export function basePreview1(ctx: BasePreview1Ctx): Record<string, unknown> {
    const {args, env, mem, fdHas} = ctx;
    const enc = new TextEncoder();
    const argBytes = args.map(a => enc.encode(a + '\0'));
    const envEntries = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const envBytes = envEntries.map(e => enc.encode(e + '\0'));

    return {
        args_sizes_get(argcPtr: number, bufSizePtr: number): number {
            mem.view().setUint32(argcPtr, args.length, true);
            mem.view().setUint32(bufSizePtr, argBytes.reduce((s, a) => s + a.length, 0), true);
            return ESUCCESS;
        },
        args_get(argvPtr: number, argvBufPtr: number): number {
            let off = argvBufPtr;
            for (let i = 0; i < argBytes.length; i++) {
                mem.view().setUint32(argvPtr + i * 4, off, true);
                mem.u8().set(argBytes[i], off);
                off += argBytes[i].length;
            }
            return ESUCCESS;
        },
        environ_sizes_get(countPtr: number, bufSizePtr: number): number {
            mem.view().setUint32(countPtr, envBytes.length, true);
            mem.view().setUint32(bufSizePtr, envBytes.reduce((s, e) => s + e.length, 0), true);
            return ESUCCESS;
        },
        environ_get(envPtr: number, envBufPtr: number): number {
            let off = envBufPtr;
            for (let i = 0; i < envBytes.length; i++) {
                mem.view().setUint32(envPtr + i * 4, off, true);
                mem.u8().set(envBytes[i], off);
                off += envBytes[i].length;
            }
            return ESUCCESS;
        },
        fd_close(_fd: number): number { return ESUCCESS; },
        fd_seek(_fd: number, _offset: bigint, _whence: number, _newOffsetPtr: number): number { return ESPIPE; },
        fd_tell(_fd: number, offsetPtr: number): number {
            mem.view().setBigUint64(offsetPtr, 0n, true);
            return ESUCCESS;
        },
        fd_renumber(_from: number, _to: number): number { return ESUCCESS; },
        fd_advise(): number { return ESUCCESS; },
        fd_allocate(): number { return ENOSYS; },
        fd_datasync(): number { return ESUCCESS; },
        fd_sync(): number { return ESUCCESS; },
        fd_filestat_set_size(): number { return ENOSYS; },
        fd_filestat_set_times(): number { return ENOSYS; },
        fd_fdstat_get(fd: number, ptr: number): number {
            if (!fdHas(fd)) return EBADF;
            mem.view().setUint8(ptr, CHARACTER_DEVICE);
            mem.view().setUint8(ptr + 1, 0);
            mem.view().setUint16(ptr + 2, 0, true);
            mem.view().setBigUint64(ptr + 8, 0n, true);
            mem.view().setBigUint64(ptr + 16, 0n, true);
            return ESUCCESS;
        },
        fd_fdstat_set_flags(_fd: number, _flags: number): number { return ESUCCESS; },
        fd_prestat_get(_fd: number, _ptr: number): number { return EBADF; },
        fd_prestat_dir_name(_fd: number, _pathPtr: number, _pathLen: number): number { return EBADF; },
        fd_filestat_get(_fd: number, _ptr: number): number { return EBADF; },
        fd_readdir(): number { return ENOSYS; },
        path_link(): number { return ENOSYS; },
        path_symlink(): number { return ENOSYS; },
        path_filestat_set_times(): number { return ENOSYS; },
        path_open(): number { return ENOSYS; },
        path_filestat_get(): number { return ENOSYS; },
        path_create_directory(): number { return ENOSYS; },
        path_remove_directory(): number { return ENOSYS; },
        path_unlink_file(): number { return ENOSYS; },
        path_rename(): number { return ENOSYS; },
        path_readlink(): number { return ENOSYS; },
        proc_raise(): number { return ENOSYS; },
        sock_accept(): number { return ENOSYS; },
        sock_recv(): number { return ENOSYS; },
        sock_send(): number { return ENOSYS; },
        sock_shutdown(): number { return ENOSYS; },
        clock_time_get(_clockId: number, _precision: bigint, timePtr: number): number {
            mem.view().setBigUint64(timePtr, BigInt(Date.now()) * 1_000_000n, true);
            return ESUCCESS;
        },
        clock_res_get(_clockId: number, resPtr: number): number {
            mem.view().setBigUint64(resPtr, 1_000_000n, true);
            return ESUCCESS;
        },
        random_get(bufPtr: number, bufLen: number): number {
            crypto.getRandomValues(mem.u8().subarray(bufPtr, bufPtr + bufLen));
            return ESUCCESS;
        },
        proc_exit(code: number): never { throw new ProcExit(code); },
        sched_yield(): number { return ESUCCESS; },
        poll_oneoff(_in: number, _out: number, _nsubs: number, _neventsPtr: number): number { return ENOSYS; },
    };
}

export interface BootOpts<S extends StartMessageBase> {
    readonly io: RunnerIo;
    readonly extraImports: (start: S, mem: MemoryAccessors) => Record<string, unknown>;
    readonly fdHas: (start: S, fd: number) => boolean;
    readonly runStart: (instance: WebAssembly.Instance) => Promise<void> | void;
}

export function bootRunner<S extends StartMessageBase>(opts: BootOpts<S>): void {
    opts.io.onMessage(msg => {
        if (msg && typeof msg === 'object' && msg.type === 'start') {
            void runStart(msg as S);
        }
    });

    async function runStart(start: S): Promise<void> {
        let memory: WebAssembly.Memory | null = null;
        const mem = memoryAccessors(() => memory);

        const imports: WebAssembly.Imports = {
            wasi_snapshot_preview1: {
                ...basePreview1({
                    args: start.args,
                    env: start.env,
                    mem,
                    fdHas: fd => opts.fdHas(start, fd),
                }),
                ...opts.extraImports(start, mem),
            } as WebAssembly.ModuleImports,
        };

        let exitCode = 0;
        try {
            const response = await fetch(start.binaryUrl);
            if (!response.ok) throw new Error(`fetch ${start.binaryUrl}: ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const {instance} = await WebAssembly.instantiate(bytes, imports);
            memory = instance.exports.memory as WebAssembly.Memory;
            try {
                await opts.runStart(instance);
            } catch (err) {
                if (err instanceof ProcExit) exitCode = err.code;
                else throw err;
            }
            opts.io.postMessage({type: 'exit', exitCode});
        } catch (err) {
            opts.io.postMessage({type: 'error', message: (err as Error).message});
        }
    }
}
