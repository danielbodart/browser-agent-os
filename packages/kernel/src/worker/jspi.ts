import {ESUCCESS, EBADF} from "../wasi/Errno.ts";
import {bootRunner, type RunnerIo, type StartMessageBase, type MemoryAccessors} from "./wasiCommon.ts";

interface FdDescriptor {
    readonly guestFd: number;
    readonly kind: 'read' | 'write';
    readonly endId: number;
}

interface JspiStart extends StartMessageBase {
    readonly fds: readonly FdDescriptor[];
}

interface PipeReply {
    readonly type: 'pipeReply';
    readonly reqId: number;
    readonly n: number;
    readonly bytes?: Uint8Array;
}

interface PipeReplyError {
    readonly type: 'pipeError';
    readonly reqId: number;
    readonly message: string;
}

interface FdHandle {
    readonly kind: 'read' | 'write';
    readonly endId: number;
}

export function bootJspiRunner(io: RunnerIo): void {
    let nextReqId = 1;
    const pendingRpc = new Map<number, (reply: PipeReply | PipeReplyError) => void>();

    const Suspending = (WebAssembly as any).Suspending;
    const promising = (WebAssembly as any).promising;
    if (!Suspending || !promising) {
        throw new Error('WebAssembly JSPI not available — run Node with --experimental-wasm-jspi or use a JSPI-enabled browser');
    }

    bootRunner<JspiStart>({
        io: {
            onMessage(handler) {
                io.onMessage((msg: any) => {
                    if (msg && (msg.type === 'pipeReply' || msg.type === 'pipeError')) {
                        const cb = pendingRpc.get(msg.reqId);
                        if (cb) { pendingRpc.delete(msg.reqId); cb(msg); }
                        return;
                    }
                    handler(msg);
                });
            },
            postMessage(msg) { io.postMessage(msg); },
        },
        fdHas(start, fd) {
            return start.fds.some(d => d.guestFd === fd);
        },
        extraImports(start, mem: MemoryAccessors) {
            const fdTable = new Map<number, FdHandle>();
            for (const d of start.fds) fdTable.set(d.guestFd, {kind: d.kind, endId: d.endId});

            const rpcWrite = (endId: number, bytes: Uint8Array): Promise<number> => {
                const reqId = nextReqId++;
                return new Promise<number>((resolve, reject) => {
                    pendingRpc.set(reqId, reply => {
                        if (reply.type === 'pipeError') reject(new Error(reply.message));
                        else resolve(reply.n);
                    });
                    io.postMessage({type: 'pipeWrite', reqId, endId, bytes});
                });
            };
            const rpcRead = (endId: number, length: number): Promise<{n: number; bytes: Uint8Array}> => {
                const reqId = nextReqId++;
                return new Promise<{n: number; bytes: Uint8Array}>((resolve, reject) => {
                    pendingRpc.set(reqId, reply => {
                        if (reply.type === 'pipeError') reject(new Error(reply.message));
                        else resolve({n: reply.n, bytes: reply.bytes ?? new Uint8Array(0)});
                    });
                    io.postMessage({type: 'pipeRead', reqId, endId, length});
                });
            };

            const fdWriteAsync = async (fd: number, iovsPtr: number, iovsLen: number, nWrittenPtr: number): Promise<number> => {
                const handle = fdTable.get(fd);
                if (!handle || handle.kind !== 'write') return EBADF;
                const slices: Uint8Array[] = [];
                for (let i = 0; i < iovsLen; i++) {
                    const ptr = mem.view().getUint32(iovsPtr + i * 8, true);
                    const len = mem.view().getUint32(iovsPtr + i * 8 + 4, true);
                    if (len > 0) slices.push(mem.u8().slice(ptr, ptr + len));
                }
                let total = 0;
                for (const s of slices) {
                    const n = await rpcWrite(handle.endId, s);
                    total += n;
                    if (n < s.length) break;
                }
                mem.view().setUint32(nWrittenPtr, total, true);
                return ESUCCESS;
            };

            const fdReadAsync = async (fd: number, iovsPtr: number, iovsLen: number, nReadPtr: number): Promise<number> => {
                const handle = fdTable.get(fd);
                if (!handle || handle.kind !== 'read') return EBADF;
                const targets: Array<{ptr: number; len: number}> = [];
                for (let i = 0; i < iovsLen; i++) {
                    const ptr = mem.view().getUint32(iovsPtr + i * 8, true);
                    const len = mem.view().getUint32(iovsPtr + i * 8 + 4, true);
                    if (len > 0) targets.push({ptr, len});
                }
                let total = 0;
                for (const {ptr, len} of targets) {
                    const {n, bytes} = await rpcRead(handle.endId, len);
                    if (n > 0) mem.u8().set(bytes.subarray(0, n), ptr);
                    total += n;
                    if (n < len) break;
                }
                mem.view().setUint32(nReadPtr, total, true);
                return ESUCCESS;
            };

            return {
                fd_write: new Suspending(fdWriteAsync),
                fd_read: new Suspending(fdReadAsync),
                fd_pwrite: new Suspending(async (fd: number, iovsPtr: number, iovsLen: number, _o: bigint, n: number) =>
                    fdWriteAsync(fd, iovsPtr, iovsLen, n)),
                fd_pread: new Suspending(async (fd: number, iovsPtr: number, iovsLen: number, _o: bigint, n: number) =>
                    fdReadAsync(fd, iovsPtr, iovsLen, n)),
            };
        },
        async runStart(instance) {
            const startFn = instance.exports._start as () => unknown;
            const promisingStart = promising(startFn) as () => Promise<unknown>;
            await promisingStart();
        },
    });
}
