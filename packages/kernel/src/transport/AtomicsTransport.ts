import type {Dependency} from "@bodar/yadic/types.ts";
import type {Pipe, PipeEnd, FdMap} from "../pipe/Pipe.ts";
import {AtomicsPipeBuffer} from "../pipe/AtomicsPipeBuffer.ts";
import {drainBuffer} from "../pipe/PipeBuffer.ts";
import type {Transport, TransportSpawnOpts, TransportSpawnResult} from "./Transport.ts";
import type {MessagingWorker, MessagingWorkerFactory} from "./MessagingWorker.ts";

export type AtomicsTransportDependencies =
    Dependency<'workerFactory', MessagingWorkerFactory> &
    Dependency<'runnerUrl', string>;

interface FdDescriptor {
    readonly guestFd: number;
    readonly kind: 'read' | 'write';
    readonly sab: SharedArrayBuffer;
    readonly capacity: number;
}

interface StartMessage {
    readonly type: 'start';
    readonly binaryUrl: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly fds: readonly FdDescriptor[];
}

interface ExitMessage {
    readonly type: 'exit';
    readonly exitCode: number;
}

interface ErrorMessage {
    readonly type: 'error';
    readonly message: string;
}

type WorkerInbound = ExitMessage | ErrorMessage;

interface EndRecord {
    readonly buffer: AtomicsPipeBuffer;
    readonly kind: 'read' | 'write';
}

export class AtomicsTransport implements Transport {
    private nextEndId = 1;
    private readonly ends = new Map<number, EndRecord>();

    constructor(private readonly deps: AtomicsTransportDependencies) {}

    pipe(capacity: number): Pipe {
        const buffer = new AtomicsPipeBuffer(capacity);
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
                worker.terminate();
                if (message.type === 'exit') resolve({exitCode: message.exitCode});
                else reject(new Error(message.message));
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

    private endRecord(end: PipeEnd): EndRecord {
        const rec = this.ends.get(end.id);
        if (!rec) throw new Error(`unknown pipe end id=${end.id}`);
        return rec;
    }

    private descriptorsFor(fds: FdMap): FdDescriptor[] {
        const out: FdDescriptor[] = [];
        for (const [guestFd, end] of fds) {
            const rec = this.endRecord(end);
            out.push({
                guestFd,
                kind: rec.kind,
                sab: rec.buffer.sab,
                capacity: rec.buffer.capacity,
            });
        }
        return out;
    }
}
