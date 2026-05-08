import {ESUCCESS, EBADF} from "../wasi/Errno.ts";
import {
    PIPE_HEADER_BYTES,
    PIPE_WRITE_POS_INDEX,
    PIPE_READ_POS_INDEX,
    PIPE_CLOSED_INDEX,
    PIPE_EVENT_INDEX,
} from "../pipe/AtomicsPipeBuffer.ts";
import {bootRunner, type RunnerIo, type StartMessageBase, type MemoryAccessors} from "./wasiCommon.ts";

interface FdDescriptor {
    readonly guestFd: number;
    readonly kind: 'read' | 'write';
    readonly sab: SharedArrayBuffer;
    readonly capacity: number;
}

interface AtomicsStart extends StartMessageBase {
    readonly fds: readonly FdDescriptor[];
}

interface FdHandle {
    readonly kind: 'read' | 'write';
    readonly header: Int32Array;
    readonly data: Uint8Array;
    readonly capacity: number;
}

function buildFdTable(start: AtomicsStart): Map<number, FdHandle> {
    const table = new Map<number, FdHandle>();
    for (const fd of start.fds) {
        table.set(fd.guestFd, {
            kind: fd.kind,
            header: new Int32Array(fd.sab, 0, 4),
            data: new Uint8Array(fd.sab, PIPE_HEADER_BYTES, fd.capacity),
            capacity: fd.capacity,
        });
    }
    return table;
}

function syncRead(handle: FdHandle, dst: Uint8Array): number {
    while (true) {
        const ev = Atomics.load(handle.header, PIPE_EVENT_INDEX);
        const wp = Atomics.load(handle.header, PIPE_WRITE_POS_INDEX);
        const rp = Atomics.load(handle.header, PIPE_READ_POS_INDEX);
        const avail = wp - rp;
        if (avail > 0) {
            const take = Math.min(avail, dst.length);
            const offset = rp % handle.capacity;
            const tail = handle.capacity - offset;
            if (take <= tail) {
                dst.set(handle.data.subarray(offset, offset + take));
            } else {
                dst.set(handle.data.subarray(offset, handle.capacity), 0);
                dst.set(handle.data.subarray(0, take - tail), tail);
            }
            Atomics.store(handle.header, PIPE_READ_POS_INDEX, rp + take);
            Atomics.add(handle.header, PIPE_EVENT_INDEX, 1);
            Atomics.notify(handle.header, PIPE_EVENT_INDEX);
            return take;
        }
        if (Atomics.load(handle.header, PIPE_CLOSED_INDEX) === 1) return 0;
        Atomics.wait(handle.header, PIPE_EVENT_INDEX, ev);
    }
}

function syncWrite(handle: FdHandle, src: Uint8Array): number {
    let written = 0;
    while (written < src.length) {
        if (Atomics.load(handle.header, PIPE_CLOSED_INDEX) === 1) return written;
        const ev = Atomics.load(handle.header, PIPE_EVENT_INDEX);
        const rp = Atomics.load(handle.header, PIPE_READ_POS_INDEX);
        const wp = Atomics.load(handle.header, PIPE_WRITE_POS_INDEX);
        const free = handle.capacity - (wp - rp);
        if (free === 0) {
            Atomics.wait(handle.header, PIPE_EVENT_INDEX, ev);
            continue;
        }
        const take = Math.min(free, src.length - written);
        const offset = wp % handle.capacity;
        const tail = handle.capacity - offset;
        if (take <= tail) {
            handle.data.set(src.subarray(written, written + take), offset);
        } else {
            handle.data.set(src.subarray(written, written + tail), offset);
            handle.data.set(src.subarray(written + tail, written + take), 0);
        }
        Atomics.store(handle.header, PIPE_WRITE_POS_INDEX, wp + take);
        Atomics.add(handle.header, PIPE_EVENT_INDEX, 1);
        Atomics.notify(handle.header, PIPE_EVENT_INDEX);
        written += take;
    }
    return written;
}

export function bootAtomicsRunner(io: RunnerIo): void {
    bootRunner<AtomicsStart>({
        io,
        fdHas(start, fd) {
            return start.fds.some(d => d.guestFd === fd);
        },
        extraImports(start, mem: MemoryAccessors) {
            const fdTable = buildFdTable(start);

            const fdWrite = (fd: number, iovsPtr: number, iovsLen: number, nWrittenPtr: number): number => {
                const handle = fdTable.get(fd);
                if (!handle || handle.kind !== 'write') return EBADF;
                let total = 0;
                for (let i = 0; i < iovsLen; i++) {
                    const ptr = mem.view().getUint32(iovsPtr + i * 8, true);
                    const len = mem.view().getUint32(iovsPtr + i * 8 + 4, true);
                    if (len === 0) continue;
                    const slice = mem.u8().slice(ptr, ptr + len);
                    const wrote = syncWrite(handle, slice);
                    total += wrote;
                    if (wrote < len) break;
                }
                mem.view().setUint32(nWrittenPtr, total, true);
                return ESUCCESS;
            };
            const fdRead = (fd: number, iovsPtr: number, iovsLen: number, nReadPtr: number): number => {
                const handle = fdTable.get(fd);
                if (!handle || handle.kind !== 'read') return EBADF;
                let total = 0;
                for (let i = 0; i < iovsLen; i++) {
                    const ptr = mem.view().getUint32(iovsPtr + i * 8, true);
                    const len = mem.view().getUint32(iovsPtr + i * 8 + 4, true);
                    if (len === 0) continue;
                    const tmp = new Uint8Array(len);
                    const n = syncRead(handle, tmp);
                    if (n > 0) {
                        mem.u8().set(tmp.subarray(0, n), ptr);
                        total += n;
                    }
                    if (n < len) break;
                }
                mem.view().setUint32(nReadPtr, total, true);
                return ESUCCESS;
            };

            return {
                fd_write: fdWrite,
                fd_read: fdRead,
                fd_pwrite: (fd: number, iovsPtr: number, iovsLen: number, _o: bigint, n: number) => fdWrite(fd, iovsPtr, iovsLen, n),
                fd_pread:  (fd: number, iovsPtr: number, iovsLen: number, _o: bigint, n: number) => fdRead(fd, iovsPtr, iovsLen, n),
            };
        },
        runStart(instance) {
            (instance.exports._start as () => void)();
        },
    });
}
