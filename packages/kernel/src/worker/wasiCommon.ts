import {ESUCCESS, EBADF, EINVAL, ENOSYS} from "../wasi/Errno.ts";
import {CHARACTER_DEVICE, DIRECTORY, REGULAR_FILE} from "../wasi/Filetype.ts";
import type {FileStat, OpenFlags} from "../fs/FileSystem.ts";
import type {DirReadEntry} from "../syscall/Syscalls.ts";
import type {PreopenDescriptor, StartMessage, SyscallReply} from "../syscall/wire.ts";
import type {ExtReply} from "../ext/wire.ts";
import {SyscallClient} from "./SyscallClient.ts";
import {ExtClient} from "./ExtClient.ts";
import {extPreview1} from "./extImports.ts";

export interface RunnerIo {
    onMessage(handler: (msg: any) => void): void;
    postMessage(msg: unknown): void;
}

export class ProcExit extends Error {
    constructor(public readonly code: number) { super(`proc_exit(${code})`); }
}

export interface MemoryAccessors {
    view(): DataView;
    u8(): Uint8Array;
    readBytes(ptr: number, len: number): Uint8Array;
    writeBytes(ptr: number, bytes: Uint8Array): void;
    readString(ptr: number, len: number): string;
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
    const decoder = new TextDecoder();
    return {
        view: () => { refresh(); return cachedView; },
        u8: () => { refresh(); return cachedU8; },
        readBytes(ptr, len) { refresh(); return cachedU8.slice(ptr, ptr + len); },
        writeBytes(ptr, bytes) { refresh(); cachedU8.set(bytes, ptr); },
        readString(ptr, len) { refresh(); return decoder.decode(cachedU8.subarray(ptr, ptr + len)); },
    };
}

function writeFilestat(view: DataView, ptr: number, stat: FileStat, inode: bigint): void {
    view.setBigUint64(ptr, 0n, true);                     // dev
    view.setBigUint64(ptr + 8, inode, true);              // ino
    view.setUint8(ptr + 16, stat.type === 'directory' ? DIRECTORY : REGULAR_FILE);
    view.setBigUint64(ptr + 24, 1n, true);                // nlink
    view.setBigUint64(ptr + 32, stat.size, true);         // size
    const t = BigInt(Math.round(stat.mtimeMs)) * 1_000_000n;
    const c = BigInt(Math.round(stat.ctimeMs)) * 1_000_000n;
    view.setBigUint64(ptr + 40, t, true);                 // atim
    view.setBigUint64(ptr + 48, t, true);                 // mtim
    view.setBigUint64(ptr + 56, c, true);                 // ctim
}

const ALL_RIGHTS = 0xffffffff_ffffffffn;

function decodeOpenFlags(oflags: number, fdflags: number, rights: bigint): OpenFlags {
    const wantWrite = (rights & 64n) !== 0n;
    const wantRead = (rights & 2n) !== 0n;
    return {
        create:    (oflags & 0x0001) !== 0,
        directory: (oflags & 0x0002) !== 0,
        exclusive: (oflags & 0x0004) !== 0,
        truncate:  (oflags & 0x0008) !== 0,
        // If guest passed no rights bits, default to read+write.
        read:      wantRead || (rights === 0n),
        write:     wantWrite || (rights === 0n),
        append:    (fdflags & 0x0001) !== 0,
    };
}

export function wasiPreview1<S extends StartMessage>(opts: {
    readonly start: S;
    readonly client: SyscallClient;
    readonly mem: MemoryAccessors;
}): Record<string, unknown> {
    const {start, client, mem} = opts;
    const enc = new TextEncoder();

    const argBytes = start.args.map(a => enc.encode(a + '\0'));
    const envEntries = Object.entries(start.env).map(([k, v]) => `${k}=${v}`);
    const envBytes = envEntries.map(e => enc.encode(e + '\0'));

    const preopens = new Map<number, PreopenDescriptor>(start.preopens.map(p => [p.fd, p]));

    return {
        args_sizes_get(argcPtr: number, bufSizePtr: number): number {
            mem.view().setUint32(argcPtr, start.args.length, true);
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
        proc_raise(): number { return ENOSYS; },
        sock_accept(): number { return ENOSYS; },
        sock_recv(): number { return ENOSYS; },
        sock_send(): number { return ENOSYS; },
        sock_shutdown(): number { return ENOSYS; },
        path_link(): number { return ENOSYS; },
        path_symlink(): number { return ENOSYS; },
        path_readlink(): number { return ENOSYS; },
        path_filestat_set_times(): number { return ENOSYS; },
        fd_advise(): number { return ESUCCESS; },
        fd_allocate(): number { return ENOSYS; },
        fd_datasync(): number { return ESUCCESS; },
        fd_renumber(): number { return ESUCCESS; },
        fd_filestat_set_times(): number { return ENOSYS; },
        fd_fdstat_set_flags(): number { return ESUCCESS; },
        fd_fdstat_set_rights(): number { return ESUCCESS; },
        poll_oneoff(): number { return ENOSYS; },

        fd_prestat_get(fd: number, ptr: number): number {
            const p = preopens.get(fd);
            if (!p) return EBADF;
            const path = enc.encode(p.path);
            mem.view().setUint8(ptr, 0);
            mem.view().setUint32(ptr + 4, path.length, true);
            return ESUCCESS;
        },
        fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
            const p = preopens.get(fd);
            if (!p) return EBADF;
            const path = enc.encode(p.path);
            if (path.length > pathLen) return EINVAL;
            mem.u8().set(path, pathPtr);
            return ESUCCESS;
        },
        fd_fdstat_get(fd: number, ptr: number): number {
            const filetype = preopens.has(fd) ? DIRECTORY : CHARACTER_DEVICE;
            mem.view().setUint8(ptr, filetype);
            mem.view().setUint8(ptr + 1, 0);
            mem.view().setUint16(ptr + 2, 0, true);
            mem.view().setBigUint64(ptr + 8, ALL_RIGHTS, true);
            mem.view().setBigUint64(ptr + 16, ALL_RIGHTS, true);
            return ESUCCESS;
        },

        async fd_read(fd: number, iovsPtr: number, iovsLen: number, nReadPtr: number): Promise<number> {
            const targets: Array<{ptr: number; len: number}> = [];
            for (let i = 0; i < iovsLen; i++) {
                const ptr = mem.view().getUint32(iovsPtr + i * 8, true);
                const len = mem.view().getUint32(iovsPtr + i * 8 + 4, true);
                if (len > 0) targets.push({ptr, len});
            }
            let total = 0;
            for (const {ptr, len} of targets) {
                const reply = await client.invoke({op: 'fd_read', fd, length: len});
                if (!reply.ok) return reply.errno;
                const r = reply.result as {n: number; bytes: Uint8Array};
                if (r.n > 0) mem.writeBytes(ptr, r.bytes);
                total += r.n;
                if (r.n < len) break;
            }
            mem.view().setUint32(nReadPtr, total, true);
            return ESUCCESS;
        },
        async fd_write(fd: number, iovsPtr: number, iovsLen: number, nWrittenPtr: number): Promise<number> {
            const slices: Uint8Array[] = [];
            for (let i = 0; i < iovsLen; i++) {
                const ptr = mem.view().getUint32(iovsPtr + i * 8, true);
                const len = mem.view().getUint32(iovsPtr + i * 8 + 4, true);
                if (len > 0) slices.push(mem.readBytes(ptr, len));
            }
            let total = 0;
            for (const s of slices) {
                const reply = await client.invoke({op: 'fd_write', fd, bytes: s});
                if (!reply.ok) return reply.errno;
                const r = reply.result as {n: number};
                total += r.n;
                if (r.n < s.length) break;
            }
            mem.view().setUint32(nWrittenPtr, total, true);
            return ESUCCESS;
        },
        async fd_pread(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nReadPtr: number): Promise<number> {
            let total = 0;
            let cur = offset;
            for (let i = 0; i < iovsLen; i++) {
                const ptr = mem.view().getUint32(iovsPtr + i * 8, true);
                const len = mem.view().getUint32(iovsPtr + i * 8 + 4, true);
                if (len === 0) continue;
                const reply = await client.invoke({op: 'fd_pread', fd, length: len, offset: cur});
                if (!reply.ok) return reply.errno;
                const r = reply.result as {n: number; bytes: Uint8Array};
                if (r.n > 0) mem.writeBytes(ptr, r.bytes);
                total += r.n;
                cur += BigInt(r.n);
                if (r.n < len) break;
            }
            mem.view().setUint32(nReadPtr, total, true);
            return ESUCCESS;
        },
        async fd_pwrite(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nWrittenPtr: number): Promise<number> {
            let total = 0;
            let cur = offset;
            for (let i = 0; i < iovsLen; i++) {
                const ptr = mem.view().getUint32(iovsPtr + i * 8, true);
                const len = mem.view().getUint32(iovsPtr + i * 8 + 4, true);
                if (len === 0) continue;
                const slice = mem.readBytes(ptr, len);
                const reply = await client.invoke({op: 'fd_pwrite', fd, bytes: slice, offset: cur});
                if (!reply.ok) return reply.errno;
                const r = reply.result as {n: number};
                total += r.n;
                cur += BigInt(r.n);
                if (r.n < len) break;
            }
            mem.view().setUint32(nWrittenPtr, total, true);
            return ESUCCESS;
        },
        async fd_close(fd: number): Promise<number> {
            const reply = await client.invoke({op: 'fd_close', fd});
            return reply.ok ? ESUCCESS : reply.errno;
        },
        async fd_seek(fd: number, offset: bigint, whence: number, newOffsetPtr: number): Promise<number> {
            if (whence < 0 || whence > 2) return EINVAL;
            const reply = await client.invoke({op: 'fd_seek', fd, offset, whence: whence as 0|1|2});
            if (!reply.ok) return reply.errno;
            const r = reply.result as {position: bigint};
            mem.view().setBigUint64(newOffsetPtr, r.position, true);
            return ESUCCESS;
        },
        async fd_tell(fd: number, offsetPtr: number): Promise<number> {
            const reply = await client.invoke({op: 'fd_tell', fd});
            if (!reply.ok) return reply.errno;
            const r = reply.result as {position: bigint};
            mem.view().setBigUint64(offsetPtr, r.position, true);
            return ESUCCESS;
        },
        async fd_filestat_get(fd: number, ptr: number): Promise<number> {
            const reply = await client.invoke({op: 'fd_filestat_get', fd});
            if (!reply.ok) return reply.errno;
            writeFilestat(mem.view(), ptr, reply.result as FileStat, BigInt(fd));
            return ESUCCESS;
        },
        async fd_filestat_set_size(fd: number, size: bigint): Promise<number> {
            const reply = await client.invoke({op: 'fd_filestat_set_size', fd, size});
            return reply.ok ? ESUCCESS : reply.errno;
        },
        async fd_sync(fd: number): Promise<number> {
            const reply = await client.invoke({op: 'fd_sync', fd});
            return reply.ok ? ESUCCESS : reply.errno;
        },
        async fd_readdir(fd: number, bufPtr: number, bufLen: number, cookie: bigint, bufUsedPtr: number): Promise<number> {
            const reply = await client.invoke({op: 'fd_readdir', fd, cookie});
            if (!reply.ok) return reply.errno;
            const {entries} = reply.result as {entries: readonly DirReadEntry[]};
            let off = 0;
            for (const e of entries) {
                const nameBytes = enc.encode(e.name);
                const headerLen = 24;
                if (off + headerLen > bufLen) break;
                mem.view().setBigUint64(bufPtr + off, e.cookie, true);
                mem.view().setBigUint64(bufPtr + off + 8, e.inode, true);
                mem.view().setUint32(bufPtr + off + 16, nameBytes.length, true);
                mem.view().setUint8(bufPtr + off + 20, e.type === 'directory' ? DIRECTORY : REGULAR_FILE);
                off += headerLen;
                const nameRoom = Math.min(nameBytes.length, bufLen - off);
                if (nameRoom > 0) mem.u8().set(nameBytes.subarray(0, nameRoom), bufPtr + off);
                off += nameRoom;
                if (nameRoom < nameBytes.length) break;
            }
            mem.view().setUint32(bufUsedPtr, off, true);
            return ESUCCESS;
        },
        async path_open(
            dirfd: number,
            _dirflags: number,
            pathPtr: number,
            pathLen: number,
            oflags: number,
            fsRightsBase: bigint,
            _fsRightsInheriting: bigint,
            fdflags: number,
            fdOutPtr: number,
        ): Promise<number> {
            const path = mem.readString(pathPtr, pathLen);
            const flags = decodeOpenFlags(oflags, fdflags, fsRightsBase);
            const reply = await client.invoke({op: 'path_open', dirfd, path, flags});
            if (!reply.ok) return reply.errno;
            const r = reply.result as {fd: number};
            mem.view().setUint32(fdOutPtr, r.fd, true);
            return ESUCCESS;
        },
        async path_filestat_get(dirfd: number, _flags: number, pathPtr: number, pathLen: number, ptr: number): Promise<number> {
            const path = mem.readString(pathPtr, pathLen);
            const reply = await client.invoke({op: 'path_filestat_get', dirfd, path});
            if (!reply.ok) return reply.errno;
            writeFilestat(mem.view(), ptr, reply.result as FileStat, 0n);
            return ESUCCESS;
        },
        async path_create_directory(dirfd: number, pathPtr: number, pathLen: number): Promise<number> {
            const path = mem.readString(pathPtr, pathLen);
            const reply = await client.invoke({op: 'path_create_directory', dirfd, path});
            return reply.ok ? ESUCCESS : reply.errno;
        },
        async path_remove_directory(dirfd: number, pathPtr: number, pathLen: number): Promise<number> {
            const path = mem.readString(pathPtr, pathLen);
            const reply = await client.invoke({op: 'path_remove_directory', dirfd, path});
            return reply.ok ? ESUCCESS : reply.errno;
        },
        async path_unlink_file(dirfd: number, pathPtr: number, pathLen: number): Promise<number> {
            const path = mem.readString(pathPtr, pathLen);
            const reply = await client.invoke({op: 'path_unlink_file', dirfd, path});
            return reply.ok ? ESUCCESS : reply.errno;
        },
        async path_rename(
            dirfd: number, fromPtr: number, fromLen: number,
            toDirfd: number, toPtr: number, toLen: number,
        ): Promise<number> {
            const from = mem.readString(fromPtr, fromLen);
            const to = mem.readString(toPtr, toLen);
            const reply = await client.invoke({op: 'path_rename', dirfd, from, toDirfd, to});
            return reply.ok ? ESUCCESS : reply.errno;
        },
    };
}

export interface BootOpts<S extends StartMessage> {
    readonly io: RunnerIo;
    readonly wrapImports: (raw: Record<string, unknown>) => Record<string, unknown>;
    readonly runStart: (instance: WebAssembly.Instance) => Promise<void> | void;
}

export function bootRunner<S extends StartMessage>(opts: BootOpts<S>): void {
    const syscallReplyHandlers: Array<(r: SyscallReply) => void> = [];
    const extReplyHandlers: Array<(r: ExtReply) => void> = [];
    const client = new SyscallClient({
        sendRequest(env) { opts.io.postMessage(env); },
        onReply(h) { syscallReplyHandlers.push(h); },
    });
    const extClient = new ExtClient({
        sendRequest(env) { opts.io.postMessage(env); },
        onReply(h) { extReplyHandlers.push(h); },
    });

    opts.io.onMessage(msg => {
        if (msg && typeof msg === 'object') {
            if (msg.type === 'syscallReply') {
                for (const h of syscallReplyHandlers) h(msg as SyscallReply);
                return;
            }
            if (msg.type === 'extReply') {
                for (const h of extReplyHandlers) h(msg as ExtReply);
                return;
            }
            if (msg.type === 'start') {
                void runStart(msg as S);
                return;
            }
        }
    });

    async function runStart(start: S): Promise<void> {
        let memory: WebAssembly.Memory | null = null;
        const mem = memoryAccessors(() => memory);

        const raw = wasiPreview1<S>({start, client, mem});
        const wasiImports = opts.wrapImports(raw);
        const extRaw = extPreview1({client: extClient, mem});
        const extImports = opts.wrapImports(extRaw);

        const imports: WebAssembly.Imports = {
            wasi_snapshot_preview1: wasiImports as WebAssembly.ModuleImports,
            browser_agent_os_ext: extImports as WebAssembly.ModuleImports,
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
