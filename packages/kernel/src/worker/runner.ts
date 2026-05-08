/// <reference lib="webworker" />
import {ESUCCESS, EBADF, ESPIPE, ENOSYS} from "../wasi/Errno.ts";
import {CHARACTER_DEVICE} from "../wasi/Filetype.ts";

interface StartMessage {
    readonly type: 'start';
    readonly url: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
}

class ProcExit extends Error {
    constructor(public readonly code: number) { super(`proc_exit(${code})`); }
}

const enc = new TextEncoder();

self.onmessage = async (event: MessageEvent<StartMessage>) => {
    if (event.data?.type !== 'start') return;
    const {url, args, env} = event.data;

    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let exitCode = 0;

    const argBytes = args.map(a => enc.encode(a + "\0"));
    const envEntries = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const envBytes = envEntries.map(e => enc.encode(e + "\0"));

    let memory: WebAssembly.Memory | null = null;
    let cachedBuffer: ArrayBuffer | null = null;
    let cachedView: DataView = null!;
    let cachedU8: Uint8Array = null!;
    const view = (): DataView => {
        if (memory!.buffer !== cachedBuffer) {
            cachedBuffer = memory!.buffer;
            cachedView = new DataView(cachedBuffer);
            cachedU8 = new Uint8Array(cachedBuffer);
        }
        return cachedView;
    };
    const u8 = (): Uint8Array => {
        if (memory!.buffer !== cachedBuffer) view();
        return cachedU8;
    };

    const wasi_snapshot_preview1 = {
        args_sizes_get(argcPtr: number, bufSizePtr: number): number {
            view().setUint32(argcPtr, args.length, true);
            view().setUint32(bufSizePtr, argBytes.reduce((s, a) => s + a.length, 0), true);
            return ESUCCESS;
        },
        args_get(argvPtr: number, argvBufPtr: number): number {
            let off = argvBufPtr;
            for (let i = 0; i < argBytes.length; i++) {
                view().setUint32(argvPtr + i * 4, off, true);
                u8().set(argBytes[i], off);
                off += argBytes[i].length;
            }
            return ESUCCESS;
        },
        environ_sizes_get(countPtr: number, bufSizePtr: number): number {
            view().setUint32(countPtr, envBytes.length, true);
            view().setUint32(bufSizePtr, envBytes.reduce((s, e) => s + e.length, 0), true);
            return ESUCCESS;
        },
        environ_get(envPtr: number, envBufPtr: number): number {
            let off = envBufPtr;
            for (let i = 0; i < envBytes.length; i++) {
                view().setUint32(envPtr + i * 4, off, true);
                u8().set(envBytes[i], off);
                off += envBytes[i].length;
            }
            return ESUCCESS;
        },
        fd_write(fd: number, iovsPtr: number, iovsLen: number, nWrittenPtr: number): number {
            const target = fd === 1 ? stdout : fd === 2 ? stderr : null;
            if (!target) return EBADF;
            let total = 0;
            for (let i = 0; i < iovsLen; i++) {
                const ptr = view().getUint32(iovsPtr + i * 8, true);
                const len = view().getUint32(iovsPtr + i * 8 + 4, true);
                target.push(u8().slice(ptr, ptr + len));
                total += len;
            }
            view().setUint32(nWrittenPtr, total, true);
            return ESUCCESS;
        },
        fd_read(_fd: number, _iovsPtr: number, _iovsLen: number, nReadPtr: number): number {
            view().setUint32(nReadPtr, 0, true);
            return ESUCCESS; // EOF
        },
        fd_pread(_fd: number, _iovsPtr: number, _iovsLen: number, _offset: bigint, nReadPtr: number): number {
            view().setUint32(nReadPtr, 0, true);
            return ESUCCESS;
        },
        fd_pwrite(fd: number, iovsPtr: number, iovsLen: number, _offset: bigint, nWrittenPtr: number): number {
            const target = fd === 1 ? stdout : fd === 2 ? stderr : null;
            if (!target) return EBADF;
            let total = 0;
            for (let i = 0; i < iovsLen; i++) {
                const ptr = view().getUint32(iovsPtr + i * 8, true);
                const len = view().getUint32(iovsPtr + i * 8 + 4, true);
                target.push(u8().slice(ptr, ptr + len));
                total += len;
            }
            view().setUint32(nWrittenPtr, total, true);
            return ESUCCESS;
        },
        fd_tell(_fd: number, offsetPtr: number): number {
            view().setBigUint64(offsetPtr, 0n, true);
            return ESUCCESS;
        },
        fd_renumber(_from: number, _to: number): number { return ESUCCESS; },
        fd_advise(): number { return ESUCCESS; },
        fd_allocate(): number { return ENOSYS; },
        fd_datasync(): number { return ESUCCESS; },
        fd_sync(): number { return ESUCCESS; },
        fd_filestat_set_size(): number { return ENOSYS; },
        fd_filestat_set_times(): number { return ENOSYS; },
        path_link(): number { return ENOSYS; },
        path_symlink(): number { return ENOSYS; },
        path_filestat_set_times(): number { return ENOSYS; },
        proc_raise(): number { return ENOSYS; },
        sock_accept(): number { return ENOSYS; },
        sock_recv(): number { return ENOSYS; },
        sock_send(): number { return ENOSYS; },
        sock_shutdown(): number { return ENOSYS; },
        fd_close(_fd: number): number { return ESUCCESS; },
        fd_seek(_fd: number, _offset: bigint, _whence: number, _newOffsetPtr: number): number {
            return ESPIPE;
        },
        fd_fdstat_get(fd: number, ptr: number): number {
            if (fd > 2) return EBADF;
            view().setUint8(ptr, CHARACTER_DEVICE);
            view().setUint8(ptr + 1, 0);
            view().setUint16(ptr + 2, 0, true);
            view().setBigUint64(ptr + 8, 0n, true);
            view().setBigUint64(ptr + 16, 0n, true);
            return ESUCCESS;
        },
        fd_fdstat_set_flags(_fd: number, _flags: number): number { return ESUCCESS; },
        fd_prestat_get(_fd: number, _ptr: number): number { return EBADF; },
        fd_prestat_dir_name(_fd: number, _pathPtr: number, _pathLen: number): number { return EBADF; },
        fd_filestat_get(_fd: number, _ptr: number): number { return EBADF; },
        clock_time_get(_clockId: number, _precision: bigint, timePtr: number): number {
            view().setBigUint64(timePtr, BigInt(Date.now()) * 1_000_000n, true);
            return ESUCCESS;
        },
        clock_res_get(_clockId: number, resPtr: number): number {
            view().setBigUint64(resPtr, 1_000_000n, true);
            return ESUCCESS;
        },
        random_get(bufPtr: number, bufLen: number): number {
            crypto.getRandomValues(u8().subarray(bufPtr, bufPtr + bufLen));
            return ESUCCESS;
        },
        proc_exit(code: number): never { throw new ProcExit(code); },
        sched_yield(): number { return ESUCCESS; },
        poll_oneoff(_in: number, _out: number, _nsubs: number, _neventsPtr: number): number { return ENOSYS; },
        path_open(): number { return ENOSYS; },
        path_filestat_get(): number { return ENOSYS; },
        path_create_directory(): number { return ENOSYS; },
        path_remove_directory(): number { return ENOSYS; },
        path_unlink_file(): number { return ENOSYS; },
        path_rename(): number { return ENOSYS; },
        path_readlink(): number { return ENOSYS; },
        fd_readdir(): number { return ENOSYS; },
    };

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
        const {instance} = await WebAssembly.instantiateStreaming(response, {wasi_snapshot_preview1});
        memory = instance.exports.memory as WebAssembly.Memory;
        try {
            (instance.exports._start as () => void)();
        } catch (err) {
            if (err instanceof ProcExit) exitCode = err.code;
            else throw err;
        }
        const flatten = (chunks: Uint8Array[]): Uint8Array => {
            const total = chunks.reduce((s, c) => s + c.length, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            return out;
        };
        self.postMessage({
            type: 'exit',
            stdout: flatten(stdout),
            stderr: flatten(stderr),
            exitCode,
        });
    } catch (err) {
        self.postMessage({type: 'error', message: (err as Error).message});
    }
};
