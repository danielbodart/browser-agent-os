import type {Dependency} from "@bodar/yadic/types.ts";
import type {Pipe, PipeEnd, FdMap} from "../pipe/Pipe.ts";
import type {PipeBuffer} from "../pipe/PipeBuffer.ts";
import {JsPipeBuffer, drainBuffer} from "../pipe/PipeBuffer.ts";
import type {Transport, TransportSpawnOpts, TransportSpawnResult} from "./Transport.ts";
import type {MessagingWorker, MessagingWorkerFactory} from "./MessagingWorker.ts";

export type JSPITransportDependencies =
    Dependency<'workerFactory', MessagingWorkerFactory> &
    Dependency<'runnerUrl', string>;

interface FdDescriptor {
    readonly guestFd: number;
    readonly kind: 'read' | 'write';
    readonly endId: number;
}

interface StartMessage {
    readonly type: 'start';
    readonly binaryUrl: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly fds: readonly FdDescriptor[];
}

interface PipeWriteRequest {
    readonly type: 'pipeWrite';
    readonly reqId: number;
    readonly endId: number;
    readonly bytes: Uint8Array;
}

interface PipeReadRequest {
    readonly type: 'pipeRead';
    readonly reqId: number;
    readonly endId: number;
    readonly length: number;
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

interface ExitMessage {
    readonly type: 'exit';
    readonly exitCode: number;
}

interface ErrorMessage {
    readonly type: 'error';
    readonly message: string;
}

type WorkerInbound = ExitMessage | ErrorMessage | PipeWriteRequest | PipeReadRequest;

interface EndRecord {
    readonly buffer: PipeBuffer;
    readonly kind: 'read' | 'write';
}

export class JSPITransport implements Transport {
    private nextEndId = 1;
    private readonly ends = new Map<number, EndRecord>();

    constructor(private readonly deps: JSPITransportDependencies) {}

    pipe(capacity: number): Pipe {
        const buffer = new JsPipeBuffer(capacity);
        const writeId = this.nextEndId++;
        const readId = this.nextEndId++;
        this.ends.set(writeId, {buffer, kind: 'write'});
        this.ends.set(readId, {buffer, kind: 'read'});
        return {
            writeEnd: {kind: 'write', id: writeId},
            readEnd: {kind: 'read', id: readId},
        };
    }

    drain(readEnd: PipeEnd): Promise<Uint8Array> {
        const {buffer, kind} = this.endRecord(readEnd);
        if (kind !== 'read') throw new Error(`drain requires a read end (got ${kind})`);
        return drainBuffer(buffer);
    }

    closeWriteEnd(end: PipeEnd): void {
        const rec = this.ends.get(end.id);
        if (!rec) return;
        if (rec.kind !== 'write') throw new Error(`closeWriteEnd requires a write end (got ${rec.kind})`);
        rec.buffer.closeWrite();
    }

    releaseEnd(end: PipeEnd): void {
        this.ends.delete(end.id);
    }

    bufferedBytes(end: PipeEnd): number {
        return this.endRecord(end).buffer.buffered;
    }

    spawn(opts: TransportSpawnOpts): Promise<TransportSpawnResult> {
        const fds = this.descriptorsFor(opts.fds);
        const worker = this.deps.workerFactory(this.deps.runnerUrl);
        return new Promise<TransportSpawnResult>((resolve, reject) => {
            worker.addMessageListener((message: WorkerInbound) => {
                this.handleMessage(worker, message, resolve, reject);
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
                fds,
            };
            worker.postMessage(start);
        });
    }

    private handleMessage(
        worker: MessagingWorker,
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
            case 'pipeWrite':
                this.servicePipeWrite(worker, message);
                return;
            case 'pipeRead':
                this.servicePipeRead(worker, message);
                return;
        }
    }

    private async servicePipeWrite(worker: MessagingWorker, req: PipeWriteRequest): Promise<void> {
        const rec = this.ends.get(req.endId);
        if (!rec || rec.kind !== 'write') {
            const err: PipeReplyError = {type: 'pipeError', reqId: req.reqId, message: `bad write end ${req.endId}`};
            worker.postMessage(err);
            return;
        }
        try {
            const n = await rec.buffer.write(req.bytes);
            const reply: PipeReply = {type: 'pipeReply', reqId: req.reqId, n};
            worker.postMessage(reply);
        } catch (e) {
            const err: PipeReplyError = {type: 'pipeError', reqId: req.reqId, message: (e as Error).message};
            worker.postMessage(err);
        }
    }

    private async servicePipeRead(worker: MessagingWorker, req: PipeReadRequest): Promise<void> {
        const rec = this.ends.get(req.endId);
        if (!rec || rec.kind !== 'read') {
            const err: PipeReplyError = {type: 'pipeError', reqId: req.reqId, message: `bad read end ${req.endId}`};
            worker.postMessage(err);
            return;
        }
        const buf = new Uint8Array(req.length);
        const n = await rec.buffer.read(buf);
        const reply: PipeReply = {type: 'pipeReply', reqId: req.reqId, n, bytes: buf.subarray(0, n)};
        worker.postMessage(reply);
    }

    private endRecord(end: PipeEnd): EndRecord {
        const rec = this.ends.get(end.id);
        if (!rec) throw new Error(`unknown pipe end id=${end.id}`);
        return rec;
    }

    private descriptorsFor(fds: FdMap): FdDescriptor[] {
        const out: FdDescriptor[] = [];
        for (const [guestFd, end] of fds) {
            const rec = this.endRecord(end);
            out.push({guestFd, kind: rec.kind, endId: end.id});
        }
        return out;
    }
}
