import {FsError, type DirEntry, type DirHandle, type FileHandle, type FileSystem, type FileStat, type OpenFlags} from "./FileSystem.ts";
import {EIO} from "../wasi/Errno.ts";

interface OpfsRequest {
    readonly id: number;
    readonly op: string;
    readonly [k: string]: unknown;
}

interface OpfsReply {
    readonly id: number;
    readonly ok: boolean;
    readonly errno?: number;
    readonly message?: string;
    readonly result?: unknown;
}

export interface OpfsFsBackend {
    postMessage(msg: unknown): void;
    addReplyListener(handler: (reply: OpfsReply) => void): void;
}

export class OpfsFs implements FileSystem {
    private nextId = 1;
    private readonly pending = new Map<number, (reply: OpfsReply) => void>();

    constructor(private readonly backend: OpfsFsBackend) {
        backend.addReplyListener(reply => {
            const cb = this.pending.get(reply.id);
            if (cb) {
                this.pending.delete(reply.id);
                cb(reply);
            }
        });
    }

    private rpc<R>(op: string, payload: Record<string, unknown> = {}): Promise<R> {
        const id = this.nextId++;
        return new Promise<R>((resolve, reject) => {
            this.pending.set(id, reply => {
                if (reply.ok) resolve(reply.result as R);
                else reject(new FsError(reply.errno ?? EIO, reply.message ?? `opfs ${op} failed`));
            });
            const msg: OpfsRequest = {id, op, ...payload};
            this.backend.postMessage(msg);
        });
    }

    async open(path: string, flags: OpenFlags): Promise<FileHandle> {
        const handleId = await this.rpc<number>('open', {path, flags});
        return new OpfsFileHandle(this, handleId);
    }

    async opendir(path: string): Promise<DirHandle> {
        const handleId = await this.rpc<number>('opendir', {path});
        return new OpfsDirHandle(this, handleId);
    }

    async stat(path: string): Promise<FileStat> {
        return this.rpc<FileStat>('stat', {path});
    }

    async mkdir(path: string): Promise<void> {
        await this.rpc<null>('mkdir', {path});
    }

    async rmdir(path: string): Promise<void> {
        await this.rpc<null>('rmdir', {path});
    }

    async unlink(path: string): Promise<void> {
        await this.rpc<null>('unlink', {path});
    }

    async rename(from: string, to: string): Promise<void> {
        await this.rpc<null>('rename', {from, to});
    }

    fileRead(handleId: number, length: number, offset: bigint): Promise<{n: number; bytes: Uint8Array}> {
        return this.rpc('file_read', {handleId, length, offset});
    }

    fileWrite(handleId: number, bytes: Uint8Array, offset: bigint): Promise<{n: number}> {
        return this.rpc('file_write', {handleId, bytes, offset});
    }

    fileTruncate(handleId: number, size: bigint): Promise<void> {
        return this.rpc<null>('file_truncate', {handleId, size}).then(() => {});
    }

    fileStat(handleId: number): Promise<FileStat> {
        return this.rpc('file_stat', {handleId});
    }

    fileSync(handleId: number): Promise<void> {
        return this.rpc<null>('file_sync', {handleId}).then(() => {});
    }

    fileClose(handleId: number): Promise<void> {
        return this.rpc<null>('file_close', {handleId}).then(() => {});
    }

    dirReaddir(handleId: number): Promise<readonly DirEntry[]> {
        return this.rpc('dir_readdir', {handleId});
    }

    dirStat(handleId: number): Promise<FileStat> {
        return this.rpc('dir_stat', {handleId});
    }

    dirClose(handleId: number): Promise<void> {
        return this.rpc<null>('dir_close', {handleId}).then(() => {});
    }
}

class OpfsFileHandle implements FileHandle {
    constructor(private readonly fs: OpfsFs, private readonly id: number) {}
    async read(buf: Uint8Array, offset: bigint): Promise<number> {
        const r = await this.fs.fileRead(this.id, buf.length, offset);
        if (r.n > 0) buf.set(r.bytes);
        return r.n;
    }
    async write(buf: Uint8Array, offset: bigint): Promise<number> {
        const r = await this.fs.fileWrite(this.id, buf, offset);
        return r.n;
    }
    async truncate(size: bigint): Promise<void> { await this.fs.fileTruncate(this.id, size); }
    async stat(): Promise<FileStat> { return this.fs.fileStat(this.id); }
    async sync(): Promise<void> { await this.fs.fileSync(this.id); }
    async close(): Promise<void> { await this.fs.fileClose(this.id); }
}

class OpfsDirHandle implements DirHandle {
    constructor(private readonly fs: OpfsFs, private readonly id: number) {}
    async readdir(): Promise<readonly DirEntry[]> { return this.fs.dirReaddir(this.id); }
    async stat(): Promise<FileStat> { return this.fs.dirStat(this.id); }
    async close(): Promise<void> { await this.fs.dirClose(this.id); }
}
