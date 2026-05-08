import type {WithoutReqId} from "../syscall/wire.ts";

export type ExtRequest =
    | {readonly op: 'fd_pipe'; readonly reqId: number}
    | {
        readonly op: 'proc_spawn';
        readonly reqId: number;
        readonly path: string;
        readonly argv: readonly string[];
        readonly env: Readonly<Record<string, string>>;
        readonly fdmap: readonly (readonly [number, number])[];
    }
    | {readonly op: 'proc_join'; readonly reqId: number; readonly pid: number};

export type ExtResult =
    | {readonly readFd: number; readonly writeFd: number}
    | {readonly pid: number}
    | {readonly exitCode: number};

export interface ExtEnvelope {
    readonly type: 'ext';
    readonly request: ExtRequest;
}

export interface ExtReplyOk {
    readonly type: 'extReply';
    readonly reqId: number;
    readonly ok: true;
    readonly result: ExtResult;
}

export interface ExtReplyErr {
    readonly type: 'extReply';
    readonly reqId: number;
    readonly ok: false;
    readonly errno: number;
}

export type ExtReply = ExtReplyOk | ExtReplyErr;

export type ExtRequestPartial = WithoutReqId<ExtRequest>;
