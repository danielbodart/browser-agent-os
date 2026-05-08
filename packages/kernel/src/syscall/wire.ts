import type {DirReadEntry, ReadResult, WriteResult} from "./Syscalls.ts";
import type {FileStat, OpenFlags} from "../fs/FileSystem.ts";

export type SyscallRequest =
    | {readonly op: 'fd_read'; readonly reqId: number; readonly fd: number; readonly length: number}
    | {readonly op: 'fd_write'; readonly reqId: number; readonly fd: number; readonly bytes: Uint8Array}
    | {readonly op: 'fd_pread'; readonly reqId: number; readonly fd: number; readonly length: number; readonly offset: bigint}
    | {readonly op: 'fd_pwrite'; readonly reqId: number; readonly fd: number; readonly bytes: Uint8Array; readonly offset: bigint}
    | {readonly op: 'fd_close'; readonly reqId: number; readonly fd: number}
    | {readonly op: 'fd_seek'; readonly reqId: number; readonly fd: number; readonly offset: bigint; readonly whence: 0 | 1 | 2}
    | {readonly op: 'fd_tell'; readonly reqId: number; readonly fd: number}
    | {readonly op: 'fd_filestat_get'; readonly reqId: number; readonly fd: number}
    | {readonly op: 'fd_filestat_set_size'; readonly reqId: number; readonly fd: number; readonly size: bigint}
    | {readonly op: 'fd_sync'; readonly reqId: number; readonly fd: number}
    | {readonly op: 'fd_readdir'; readonly reqId: number; readonly fd: number; readonly cookie: bigint}
    | {readonly op: 'path_open'; readonly reqId: number; readonly dirfd: number; readonly path: string; readonly flags: OpenFlags}
    | {readonly op: 'path_filestat_get'; readonly reqId: number; readonly dirfd: number; readonly path: string}
    | {readonly op: 'path_create_directory'; readonly reqId: number; readonly dirfd: number; readonly path: string}
    | {readonly op: 'path_remove_directory'; readonly reqId: number; readonly dirfd: number; readonly path: string}
    | {readonly op: 'path_unlink_file'; readonly reqId: number; readonly dirfd: number; readonly path: string}
    | {readonly op: 'path_rename'; readonly reqId: number; readonly dirfd: number; readonly from: string; readonly toDirfd: number; readonly to: string};

export type SyscallResult =
    | ReadResult
    | WriteResult
    | FileStat
    | {readonly fd: number}
    | {readonly position: bigint}
    | {readonly entries: readonly DirReadEntry[]}
    | null;

export interface SyscallEnvelope {
    readonly type: 'syscall';
    readonly request: SyscallRequest;
}

export interface SyscallReplyOk {
    readonly type: 'syscallReply';
    readonly reqId: number;
    readonly ok: true;
    readonly result: SyscallResult;
}

export interface SyscallReplyErr {
    readonly type: 'syscallReply';
    readonly reqId: number;
    readonly ok: false;
    readonly errno: number;
}

export type SyscallReply = SyscallReplyOk | SyscallReplyErr;

export type WithoutReqId<T> = T extends {readonly reqId: number} ? Omit<T, 'reqId'> : never;
export type SyscallRequestPartial = WithoutReqId<SyscallRequest>;

export interface ExitMessage {
    readonly type: 'exit';
    readonly exitCode: number;
}

export interface ErrorMessage {
    readonly type: 'error';
    readonly message: string;
}

export interface StartMessage {
    readonly type: 'start';
    readonly binaryUrl: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly preopens: readonly PreopenDescriptor[];
}

export interface PreopenDescriptor {
    readonly fd: number;
    readonly path: string;
}
