import type {ExtEnvelope, ExtReply, ExtRequest, ExtRequestPartial} from "../ext/wire.ts";

type Pending = (reply: ExtReply) => void;

export interface ExtChannel {
    sendRequest(envelope: ExtEnvelope): void;
    onReply(handler: (reply: ExtReply) => void): void;
}

export class ExtClient {
    private nextReqId = 1;
    private readonly pending = new Map<number, Pending>();

    constructor(private readonly channel: ExtChannel) {
        channel.onReply(reply => {
            const cb = this.pending.get(reply.reqId);
            if (cb) {
                this.pending.delete(reply.reqId);
                cb(reply);
            }
        });
    }

    async invoke(request: ExtRequestPartial): Promise<ExtReply> {
        const reqId = this.nextReqId++;
        const full = {...request, reqId} as ExtRequest;
        return new Promise<ExtReply>(resolve => {
            this.pending.set(reqId, resolve);
            this.channel.sendRequest({type: 'ext', request: full});
        });
    }
}
