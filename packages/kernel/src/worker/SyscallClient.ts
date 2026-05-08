import type {SyscallEnvelope, SyscallReply, SyscallRequest, SyscallRequestPartial} from "../syscall/wire.ts";

type Pending = (reply: SyscallReply) => void;

export interface SyscallChannel {
    sendRequest(envelope: SyscallEnvelope): void;
    onReply(handler: (reply: SyscallReply) => void): void;
}

export class SyscallClient {
    private nextReqId = 1;
    private readonly pending = new Map<number, Pending>();

    constructor(private readonly channel: SyscallChannel) {
        channel.onReply(reply => {
            const cb = this.pending.get(reply.reqId);
            if (cb) {
                this.pending.delete(reply.reqId);
                cb(reply);
            }
        });
    }

    async invoke(request: SyscallRequestPartial): Promise<SyscallReply> {
        const reqId = this.nextReqId++;
        const full = {...request, reqId} as SyscallRequest;
        return new Promise<SyscallReply>(resolve => {
            this.pending.set(reqId, resolve);
            this.channel.sendRequest({type: 'syscall', request: full});
        });
    }
}
