import type {Dependency} from "@bodar/yadic/types.ts";
import type {Pipe, PipeEnd} from "../pipe/Pipe.ts";
import type {PipeBuffer} from "../pipe/PipeBuffer.ts";
import {JsPipeBuffer, drainBuffer} from "../pipe/PipeBuffer.ts";
import type {Transport, TransportSpawnOpts, TransportSpawnResult} from "./Transport.ts";
import type {MessagingWorker, MessagingWorkerFactory} from "./MessagingWorker.ts";
import {SyscallError} from "../syscall/SyscallHandler.ts";
import {EIO} from "../wasi/Errno.ts";
import {FsError} from "../fs/FileSystem.ts";
import type {Syscalls} from "../syscall/Syscalls.ts";
import type {Ext} from "../ext/Ext.ts";
import type {ErrorMessage, ExitMessage, StartMessage, SyscallEnvelope, SyscallReply, SyscallRequest} from "../syscall/wire.ts";
import type {ExtEnvelope, ExtReply, ExtRequest} from "../ext/wire.ts";

export type JSPITransportDependencies =
    Dependency<'workerFactory', MessagingWorkerFactory> &
    Dependency<'runnerUrl', string>;

interface EndRecord {
    readonly buffer: PipeBuffer;
    readonly kind: 'read' | 'write';
    // Live process-holders of a write end. `closeWriteEnd` decrements; the buffer is
    // only EOF'd at zero. An end that was never acquired (holders 0) closes immediately,
    // which is what host-provided stdin ends and the kernel's default no-writer stdin want.
    holders: number;
}

type WorkerInbound = ExitMessage | ErrorMessage | SyscallEnvelope | ExtEnvelope;

export class JSPITransport implements Transport {
    private nextEndId = 1;
    private readonly ends = new Map<number, EndRecord>();

    constructor(private readonly deps: JSPITransportDependencies) {}

    pipe(capacity: number): Pipe {
        const buffer = new JsPipeBuffer(capacity);
        const writeId = this.nextEndId++;
        const readId = this.nextEndId++;
        this.ends.set(writeId, {buffer, kind: 'write', holders: 0});
        this.ends.set(readId, {buffer, kind: 'read', holders: 0});
        return {
            writeEnd: {kind: 'write', id: writeId},
            readEnd: {kind: 'read', id: readId},
        };
    }

    drain(readEnd: PipeEnd): Promise<Uint8Array> {
        const rec = this.endRecord(readEnd);
        if (rec.kind !== 'read') throw new Error(`drain requires a read end (got ${rec.kind})`);
        return drainBuffer(rec.buffer);
    }

    acquireWriteEnd(end: PipeEnd): void {
        const rec = this.endRecord(end);
        if (rec.kind !== 'write') throw new Error(`acquireWriteEnd requires a write end (got ${rec.kind})`);
        rec.holders++;
    }

    closeWriteEnd(end: PipeEnd): void {
        const rec = this.ends.get(end.id);
        if (!rec) return;
        if (rec.kind !== 'write') throw new Error(`closeWriteEnd requires a write end (got ${rec.kind})`);
        if (rec.holders > 0) rec.holders--;
        if (rec.holders === 0) rec.buffer.closeWrite();
    }

    releaseEnd(end: PipeEnd): void {
        this.ends.delete(end.id);
    }

    bufferedBytes(end: PipeEnd): number {
        return this.endRecord(end).buffer.buffered;
    }

    pipeBuffer(end: PipeEnd): PipeBuffer {
        return this.endRecord(end).buffer;
    }

    spawn(opts: TransportSpawnOpts): Promise<TransportSpawnResult> {
        const worker = this.deps.workerFactory(this.deps.runnerUrl);
        return new Promise<TransportSpawnResult>((resolve, reject) => {
            worker.addMessageListener((message: WorkerInbound) => {
                this.handleMessage(worker, opts.syscalls, opts.ext, message, resolve, reject);
            });
            worker.addErrorListener(err => {
                worker.terminate();
                reject(err);
            });
            const start: StartMessage = {
                type: 'start',
                binaryUrl: opts.binaryUrl,
                args: opts.args,
                env: opts.env,
                preopens: opts.preopens,
            };
            worker.postMessage(start);
        });
    }

    private handleMessage(
        worker: MessagingWorker,
        syscalls: Syscalls,
        ext: Ext,
        message: WorkerInbound,
        resolve: (r: TransportSpawnResult) => void,
        reject: (e: Error) => void,
    ): void {
        switch (message.type) {
            case 'exit':
                worker.terminate();
                resolve({exitCode: message.exitCode});
                return;
            case 'error':
                worker.terminate();
                reject(new Error(message.message));
                return;
            case 'syscall':
                void this.serviceSyscall(worker, syscalls, message.request);
                return;
            case 'ext':
                void this.serviceExt(worker, ext, message.request);
                return;
        }
    }

    private async serviceSyscall(worker: MessagingWorker, syscalls: Syscalls, request: SyscallRequest): Promise<void> {
        try {
            const result = await dispatchSyscall(syscalls, request);
            const reply: SyscallReply = {type: 'syscallReply', reqId: request.reqId, ok: true, result: result as any};
            worker.postMessage(reply);
        } catch (e) {
            const reply: SyscallReply = {type: 'syscallReply', reqId: request.reqId, ok: false, errno: errnoFor(e)};
            worker.postMessage(reply);
        }
    }

    private async serviceExt(worker: MessagingWorker, ext: Ext, request: ExtRequest): Promise<void> {
        try {
            const result = await dispatchExt(ext, request);
            const reply: ExtReply = {type: 'extReply', reqId: request.reqId, ok: true, result};
            worker.postMessage(reply);
        } catch (e) {
            const reply: ExtReply = {type: 'extReply', reqId: request.reqId, ok: false, errno: errnoFor(e)};
            worker.postMessage(reply);
        }
    }

    private endRecord(end: PipeEnd): EndRecord {
        const rec = this.ends.get(end.id);
        if (!rec) throw new Error(`unknown pipe end id=${end.id}`);
        return rec;
    }
}

function errnoFor(e: unknown): number {
    if (e instanceof SyscallError) return e.errno;
    if (e instanceof FsError) return e.errno;
    return EIO;
}

async function dispatchSyscall(syscalls: Syscalls, req: SyscallRequest): Promise<unknown> {
    switch (req.op) {
        case 'fd_read': return syscalls.fdRead(req.fd, req.length);
        case 'fd_write': return syscalls.fdWrite(req.fd, req.bytes);
        case 'fd_pread': return syscalls.fdPread(req.fd, req.length, req.offset);
        case 'fd_pwrite': return syscalls.fdPwrite(req.fd, req.bytes, req.offset);
        case 'fd_close': await syscalls.fdClose(req.fd); return null;
        case 'fd_seek': return {position: await syscalls.fdSeek(req.fd, req.offset, req.whence)};
        case 'fd_tell': return {position: await syscalls.fdTell(req.fd)};
        case 'fd_filestat_get': return syscalls.fdFilestatGet(req.fd);
        case 'fd_filestat_set_size': await syscalls.fdFilestatSetSize(req.fd, req.size); return null;
        case 'fd_sync': await syscalls.fdSync(req.fd); return null;
        case 'fd_readdir': return {entries: await syscalls.fdReaddir(req.fd, req.cookie)};
        case 'path_open': return {fd: await syscalls.pathOpen(req.dirfd, req.path, req.flags)};
        case 'path_filestat_get': return syscalls.pathFilestatGet(req.dirfd, req.path);
        case 'path_create_directory': await syscalls.pathCreateDirectory(req.dirfd, req.path); return null;
        case 'path_remove_directory': await syscalls.pathRemoveDirectory(req.dirfd, req.path); return null;
        case 'path_unlink_file': await syscalls.pathUnlinkFile(req.dirfd, req.path); return null;
        case 'path_rename': await syscalls.pathRename(req.dirfd, req.from, req.toDirfd, req.to); return null;
    }
}

async function dispatchExt(ext: Ext, req: ExtRequest): Promise<any> {
    switch (req.op) {
        case 'fd_pipe': return ext.fdPipe();
        case 'proc_spawn': return ext.procSpawn(req.path, req.argv, req.env, req.fdmap);
        case 'proc_join': return ext.procJoin(req.pid);
    }
}
