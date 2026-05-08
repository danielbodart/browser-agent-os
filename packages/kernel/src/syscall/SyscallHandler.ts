import {EBADF, EINVAL, ESPIPE, ENOTDIR, EISDIR} from "../wasi/Errno.ts";
import {FsError, type FileSystem} from "../fs/FileSystem.ts";
import type {FdTable} from "../fd/FdTable.ts";
import type {DirFdEntry, FdEntry, FileFdEntry, PipeFdEntry} from "../fd/FdEntry.ts";
import type {PipeBuffer} from "../pipe/PipeBuffer.ts";
import {resolve} from "../fs/Path.ts";
import type {DirReadEntry, ReadResult, Syscalls, WriteResult} from "./Syscalls.ts";
import type {FileStat, OpenFlags} from "../fs/FileSystem.ts";

export interface PipeBufferLookup {
    (end: PipeFdEntry['end']): PipeBuffer;
}

export class SyscallHandler implements Syscalls {
    constructor(
        private readonly fds: FdTable,
        private readonly fs: FileSystem,
        private readonly pipeBuffer: PipeBufferLookup,
    ) {}

    async fdRead(fd: number, length: number): Promise<ReadResult> {
        const entry = this.requireEntry(fd);
        if (entry.kind === 'pipe') {
            if (entry.direction !== 'read') throw new SyscallError(EBADF, 'fd not readable');
            const buf = new Uint8Array(length);
            const n = await this.pipeBuffer(entry.end).read(buf);
            return {n, bytes: buf.subarray(0, n)};
        }
        if (entry.kind === 'file') {
            const buf = new Uint8Array(length);
            const n = await this.fileRead(entry, buf, entry.position);
            entry.position += BigInt(n);
            return {n, bytes: buf.subarray(0, n)};
        }
        throw new SyscallError(EISDIR, 'fd is a directory');
    }

    async fdWrite(fd: number, bytes: Uint8Array): Promise<WriteResult> {
        const entry = this.requireEntry(fd);
        if (entry.kind === 'pipe') {
            if (entry.direction !== 'write') throw new SyscallError(EBADF, 'fd not writable');
            const n = await this.pipeBuffer(entry.end).write(bytes);
            return {n};
        }
        if (entry.kind === 'file') {
            const n = await this.fileWrite(entry, bytes, entry.position);
            entry.position += BigInt(n);
            return {n};
        }
        throw new SyscallError(EISDIR, 'fd is a directory');
    }

    async fdPread(fd: number, length: number, offset: bigint): Promise<ReadResult> {
        const entry = this.requireEntry(fd);
        if (entry.kind !== 'file') throw new SyscallError(ESPIPE, 'fd not seekable');
        const buf = new Uint8Array(length);
        const n = await this.fileRead(entry, buf, offset);
        return {n, bytes: buf.subarray(0, n)};
    }

    async fdPwrite(fd: number, bytes: Uint8Array, offset: bigint): Promise<WriteResult> {
        const entry = this.requireEntry(fd);
        if (entry.kind !== 'file') throw new SyscallError(ESPIPE, 'fd not seekable');
        const n = await this.fileWrite(entry, bytes, offset);
        return {n};
    }

    async fdClose(fd: number): Promise<void> {
        const entry = this.fds.close(fd);
        if (!entry) throw new SyscallError(EBADF, `bad fd ${fd}`);
        if (entry.kind === 'file') await entry.handle.close();
        if (entry.kind === 'dir') await entry.handle.close();
        // Pipe ends are owned by LocalKernel/Transport — we don't release here.
    }

    async fdSeek(fd: number, offset: bigint, whence: 0 | 1 | 2): Promise<bigint> {
        const entry = this.requireEntry(fd);
        if (entry.kind !== 'file') throw new SyscallError(ESPIPE, 'fd not seekable');
        let next: bigint;
        if (whence === 0) next = offset;
        else if (whence === 1) next = entry.position + offset;
        else {
            const stat = await entry.handle.stat();
            next = stat.size + offset;
        }
        if (next < 0n) throw new SyscallError(EINVAL, 'negative seek');
        entry.position = next;
        return next;
    }

    async fdTell(fd: number): Promise<bigint> {
        const entry = this.requireEntry(fd);
        if (entry.kind !== 'file') throw new SyscallError(ESPIPE, 'fd not seekable');
        return entry.position;
    }

    async fdFilestatGet(fd: number): Promise<FileStat> {
        const entry = this.requireEntry(fd);
        if (entry.kind === 'file') return entry.handle.stat();
        if (entry.kind === 'dir') return entry.handle.stat();
        throw new SyscallError(EINVAL, 'no stat for pipe fd');
    }

    async fdFilestatSetSize(fd: number, size: bigint): Promise<void> {
        const entry = this.requireEntry(fd);
        if (entry.kind !== 'file') throw new SyscallError(EINVAL, 'fd not a file');
        await entry.handle.truncate(size);
    }

    async fdSync(fd: number): Promise<void> {
        const entry = this.requireEntry(fd);
        if (entry.kind !== 'file') return;
        await entry.handle.sync();
    }

    async fdReaddir(fd: number, cookie: bigint): Promise<readonly DirReadEntry[]> {
        const entry = this.requireEntry(fd);
        if (entry.kind !== 'dir') throw new SyscallError(ENOTDIR, 'fd not a directory');
        const all = await entry.handle.readdir();
        const start = Number(cookie);
        const out: DirReadEntry[] = [];
        for (let i = start; i < all.length; i++) {
            out.push({...all[i], cookie: BigInt(i + 1), inode: 0n});
        }
        return out;
    }

    async pathOpen(dirfd: number, path: string, flags: OpenFlags): Promise<number> {
        const dir = this.requireDir(dirfd);
        const abs = resolve(dir.path, path);
        if (flags.directory) {
            const handle = await this.fs.opendir(abs);
            return this.fds.allocate({kind: 'dir', handle, path: abs, preopen: false});
        }
        const handle = await this.fs.open(abs, flags);
        return this.fds.allocate({kind: 'file', handle, flags, position: 0n});
    }

    async pathFilestatGet(dirfd: number, path: string): Promise<FileStat> {
        const dir = this.requireDir(dirfd);
        return this.fs.stat(resolve(dir.path, path));
    }

    async pathCreateDirectory(dirfd: number, path: string): Promise<void> {
        const dir = this.requireDir(dirfd);
        await this.fs.mkdir(resolve(dir.path, path));
    }

    async pathRemoveDirectory(dirfd: number, path: string): Promise<void> {
        const dir = this.requireDir(dirfd);
        await this.fs.rmdir(resolve(dir.path, path));
    }

    async pathUnlinkFile(dirfd: number, path: string): Promise<void> {
        const dir = this.requireDir(dirfd);
        await this.fs.unlink(resolve(dir.path, path));
    }

    async pathRename(dirfd: number, from: string, toDirfd: number, to: string): Promise<void> {
        const fromDir = this.requireDir(dirfd);
        const toDir = this.requireDir(toDirfd);
        await this.fs.rename(resolve(fromDir.path, from), resolve(toDir.path, to));
    }

    private async fileRead(entry: FileFdEntry, buf: Uint8Array, offset: bigint): Promise<number> {
        try {
            return await entry.handle.read(buf, offset);
        } catch (e) {
            if (e instanceof FsError) throw new SyscallError(e.errno, e.message);
            throw e;
        }
    }

    private async fileWrite(entry: FileFdEntry, bytes: Uint8Array, offset: bigint): Promise<number> {
        try {
            return await entry.handle.write(bytes, offset);
        } catch (e) {
            if (e instanceof FsError) throw new SyscallError(e.errno, e.message);
            throw e;
        }
    }

    private requireEntry(fd: number): FdEntry {
        const e = this.fds.get(fd);
        if (!e) throw new SyscallError(EBADF, `bad fd ${fd}`);
        return e;
    }

    private requireDir(fd: number): DirFdEntry {
        const e = this.requireEntry(fd);
        if (e.kind !== 'dir') throw new SyscallError(ENOTDIR, `fd ${fd} not a directory`);
        return e;
    }
}

export class SyscallError extends Error {
    constructor(public readonly errno: number, message: string) {
        super(message);
        this.name = 'SyscallError';
    }
}
