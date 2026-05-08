// Lives inside an OPFS-capable Worker. Hosts FileSystemSyncAccessHandle ops
// behind the OpfsFs RPC protocol.
//
// The owning Worker calls `bootOpfsBackend({onMessage, postMessage})`.

import {EBADF, EEXIST, EINVAL, EIO, EISDIR, ENOENT, ENOTDIR, ENOTEMPTY} from "../wasi/Errno.ts";
import {basename, dirname, normalize, split} from "./Path.ts";
import type {DirEntry, FileStat, OpenFlags} from "./FileSystem.ts";
import type {RunnerIo} from "../worker/wasiCommon.ts";

interface FsErrorish {
    readonly errno: number;
    readonly message: string;
}

class FsErr extends Error implements FsErrorish {
    constructor(public readonly errno: number, message: string) {
        super(message);
        this.name = 'OpfsBackendError';
    }
}

interface FileEntry {
    readonly type: 'file';
    sync: FileSystemSyncAccessHandle;
    fileHandle: FileSystemFileHandle;
    parent: FileSystemDirectoryHandle;
    name: string;
    flags: OpenFlags;
    ctimeMs: number;
}

interface DirEntryRecord {
    readonly type: 'dir';
    handle: FileSystemDirectoryHandle;
    path: string;
}

type Entry = FileEntry | DirEntryRecord;

const isFsaDirectory = (e: any): e is FileSystemDirectoryHandle => e?.kind === 'directory';
const isFsaFile = (e: any): e is FileSystemFileHandle => e?.kind === 'file';

async function navigate(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
    const parts = split(path);
    let cur = root;
    for (const part of parts) {
        try {
            cur = await cur.getDirectoryHandle(part);
        } catch (e: any) {
            if (e.name === 'NotFoundError') throw new FsErr(ENOENT, `no such directory: ${path}`);
            if (e.name === 'TypeMismatchError') throw new FsErr(ENOTDIR, `not a directory in path: ${path}`);
            throw e;
        }
    }
    return cur;
}

export function bootOpfsBackend(io: RunnerIo): Promise<void> {
    const entries = new Map<number, Entry>();
    let nextId = 1;
    let root: FileSystemDirectoryHandle | null = null;
    const queue: any[] = [];
    let ready = false;

    const handle = async (msg: any) => {
        const {id, op} = msg;
        try {
            const result = await dispatch(op, msg);
            io.postMessage({id, ok: true, result});
        } catch (e) {
            const err = e instanceof FsErr ? e : new FsErr(EIO, (e as Error).message ?? String(e));
            io.postMessage({id, ok: false, errno: err.errno, message: err.message});
        }
    };

    io.onMessage((msg: any) => {
        if (!ready) { queue.push(msg); return; }
        void handle(msg);
    });

    return (async () => {
        root = await (navigator as any).storage.getDirectory() as FileSystemDirectoryHandle;
        ready = true;
        while (queue.length > 0) {
            const m = queue.shift();
            void handle(m);
        }
    })();

    async function dispatch(op: string, msg: any): Promise<unknown> {
        switch (op) {
            case 'open': return openFile(msg.path, msg.flags);
            case 'opendir': return openDir(msg.path);
            case 'stat': return statPath(msg.path);
            case 'mkdir': return mkdir(msg.path);
            case 'rmdir': return rmdir(msg.path);
            case 'unlink': return unlink(msg.path);
            case 'rename': return rename(msg.from, msg.to);
            case 'file_read': return fileRead(msg.handleId, msg.length, msg.offset);
            case 'file_write': return fileWrite(msg.handleId, msg.bytes, msg.offset);
            case 'file_truncate': return fileTruncate(msg.handleId, msg.size);
            case 'file_stat': return fileStat(msg.handleId);
            case 'file_sync': return fileSync(msg.handleId);
            case 'file_close': return fileClose(msg.handleId);
            case 'dir_readdir': return dirReaddir(msg.handleId);
            case 'dir_stat': return dirStat(msg.handleId);
            case 'dir_close': return dirClose(msg.handleId);
            default: throw new FsErr(EINVAL, `unknown op ${op}`);
        }
    }

    async function openFile(path: string, flags: OpenFlags): Promise<number> {
        const norm = normalize(path);
        if (norm === '/') throw new FsErr(EISDIR, 'is root');
        if (flags.directory) throw new FsErr(EISDIR, 'directory open requested');
        const parentPath = dirname(norm);
        const name = basename(norm);
        const parent = await navigate(root!, parentPath);
        if (flags.exclusive && flags.create) {
            // OPFS has no native EXCL — pre-check then create.
            try {
                await parent.getFileHandle(name);
                throw new FsErr(EEXIST, `file exists: ${path}`);
            } catch (e: any) {
                if (e instanceof FsErr) throw e;
                if (e.name !== 'NotFoundError') {
                    if (e.name === 'TypeMismatchError') throw new FsErr(EISDIR, `is a directory: ${path}`);
                    throw e;
                }
            }
        }
        let fileHandle: FileSystemFileHandle;
        try {
            fileHandle = await parent.getFileHandle(name, {create: flags.create});
        } catch (e: any) {
            if (e.name === 'NotFoundError') throw new FsErr(ENOENT, `no such file: ${path}`);
            if (e.name === 'TypeMismatchError') throw new FsErr(EISDIR, `is a directory: ${path}`);
            throw e;
        }
        let sync: FileSystemSyncAccessHandle;
        try {
            sync = await fileHandle.createSyncAccessHandle();
        } catch (e: any) {
            throw new FsErr(EIO, `createSyncAccessHandle: ${e.message ?? e.name}`);
        }
        if (flags.truncate && flags.write) sync.truncate(0);
        const id = nextId++;
        entries.set(id, {
            type: 'file',
            sync,
            fileHandle,
            parent,
            name,
            flags,
            ctimeMs: Date.now(),
        });
        return id;
    }

    async function openDir(path: string): Promise<number> {
        const handle = await navigate(root!,path);
        const id = nextId++;
        entries.set(id, {type: 'dir', handle, path: normalize(path)});
        return id;
    }

    async function statPath(path: string): Promise<FileStat> {
        const norm = normalize(path);
        if (norm === '/') return dirStatHandle(root!);
        const parentPath = dirname(norm);
        const name = basename(norm);
        const parent = await navigate(root!,parentPath);
        for await (const [n, h] of (parent as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            if (n === name) {
                if (isFsaFile(h)) {
                    const file = await (h as FileSystemFileHandle).getFile();
                    return {type: 'file', size: BigInt(file.size), mtimeMs: file.lastModified, ctimeMs: file.lastModified};
                }
                if (isFsaDirectory(h)) return dirStatHandle(h as FileSystemDirectoryHandle);
            }
        }
        throw new FsErr(ENOENT, `no such file: ${path}`);
    }

    async function dirStatHandle(_h: FileSystemDirectoryHandle): Promise<FileStat> {
        const now = Date.now();
        return {type: 'directory', size: 0n, mtimeMs: now, ctimeMs: now};
    }

    async function mkdir(path: string): Promise<null> {
        const norm = normalize(path);
        if (norm === '/') throw new FsErr(EEXIST, 'root exists');
        const parentPath = dirname(norm);
        const name = basename(norm);
        const parent = await navigate(root!,parentPath);
        // Reject if exists.
        for await (const n of (parent as any).keys() as AsyncIterable<string>) {
            if (n === name) throw new FsErr(EEXIST, `file exists: ${path}`);
        }
        await parent.getDirectoryHandle(name, {create: true});
        return null;
    }

    async function rmdir(path: string): Promise<null> {
        const norm = normalize(path);
        if (norm === '/') throw new FsErr(EINVAL, 'cannot remove root');
        const parentPath = dirname(norm);
        const name = basename(norm);
        const parent = await navigate(root!,parentPath);
        let target: FileSystemHandle | null = null;
        for await (const [n, h] of (parent as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            if (n === name) { target = h; break; }
        }
        if (!target) throw new FsErr(ENOENT, `no such file: ${path}`);
        if (!isFsaDirectory(target)) throw new FsErr(ENOTDIR, `not a directory: ${path}`);
        const dh = target as FileSystemDirectoryHandle;
        for await (const _ of (dh as any).keys() as AsyncIterable<string>) {
            throw new FsErr(ENOTEMPTY, `directory not empty: ${path}`);
        }
        await parent.removeEntry(name);
        return null;
    }

    async function unlink(path: string): Promise<null> {
        const norm = normalize(path);
        if (norm === '/') throw new FsErr(EISDIR, 'is root');
        const parentPath = dirname(norm);
        const name = basename(norm);
        const parent = await navigate(root!,parentPath);
        let target: FileSystemHandle | null = null;
        for await (const [n, h] of (parent as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            if (n === name) { target = h; break; }
        }
        if (!target) throw new FsErr(ENOENT, `no such file: ${path}`);
        if (isFsaDirectory(target)) throw new FsErr(EISDIR, `is a directory: ${path}`);
        await parent.removeEntry(name);
        return null;
    }

    async function rename(from: string, to: string): Promise<null> {
        // OPFS exposes `move` on handles in modern Chrome. Fall back to copy-then-delete otherwise.
        const fromN = normalize(from);
        const toN = normalize(to);
        if (fromN === '/' || toN === '/') throw new FsErr(EINVAL, 'cannot rename root');
        const fromParentPath = dirname(fromN);
        const fromName = basename(fromN);
        const toParentPath = dirname(toN);
        const toName = basename(toN);
        const fromParent = await navigate(root!,fromParentPath);
        const toParent = await navigate(root!,toParentPath);
        let target: FileSystemHandle | null = null;
        for await (const [n, h] of (fromParent as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            if (n === fromName) { target = h; break; }
        }
        if (!target) throw new FsErr(ENOENT, `no such file: ${from}`);
        const moveFn = (target as any).move as undefined | ((parent: FileSystemDirectoryHandle, name: string) => Promise<void>);
        if (moveFn) {
            try {
                await moveFn.call(target, toParent, toName);
                return null;
            } catch (e: any) {
                if (e.name === 'TypeError') {
                    // Some implementations expose move(name) only.
                    if (toParentPath === fromParentPath) {
                        await (target as any).move(toName);
                        return null;
                    }
                }
                throw new FsErr(EIO, `move: ${e.message ?? e.name}`);
            }
        }
        // Fallback: only files, copy bytes
        if (isFsaFile(target)) {
            const src = await (target as FileSystemFileHandle).getFile();
            const newHandle = await toParent.getFileHandle(toName, {create: true});
            const writable = await (newHandle as any).createWritable();
            await writable.write(await src.arrayBuffer());
            await writable.close();
            await fromParent.removeEntry(fromName);
            return null;
        }
        throw new FsErr(EINVAL, 'rename of directory unsupported on this browser');
    }

    function entry(id: number): Entry {
        const e = entries.get(id);
        if (!e) throw new FsErr(EBADF, `bad handle ${id}`);
        return e;
    }

    function fileEntry(id: number): FileEntry {
        const e = entry(id);
        if (e.type !== 'file') throw new FsErr(EBADF, `not a file handle ${id}`);
        return e;
    }

    function dirEntryRec(id: number): DirEntryRecord {
        const e = entry(id);
        if (e.type !== 'dir') throw new FsErr(EBADF, `not a dir handle ${id}`);
        return e;
    }

    async function fileRead(id: number, length: number, offset: bigint): Promise<{n: number; bytes: Uint8Array}> {
        const e = fileEntry(id);
        const buf = new Uint8Array(length);
        const n = e.sync.read(buf, {at: Number(offset)});
        return {n, bytes: buf.subarray(0, n)};
    }

    async function fileWrite(id: number, bytes: Uint8Array, offset: bigint): Promise<{n: number}> {
        const e = fileEntry(id);
        const n = e.sync.write(bytes, {at: Number(offset)});
        return {n};
    }

    async function fileTruncate(id: number, size: bigint): Promise<null> {
        const e = fileEntry(id);
        e.sync.truncate(Number(size));
        return null;
    }

    async function fileStat(id: number): Promise<FileStat> {
        const e = fileEntry(id);
        const size = BigInt(e.sync.getSize());
        const file = await e.fileHandle.getFile();
        return {type: 'file', size, mtimeMs: file.lastModified, ctimeMs: e.ctimeMs};
    }

    async function fileSync(id: number): Promise<null> {
        const e = fileEntry(id);
        e.sync.flush();
        return null;
    }

    async function fileClose(id: number): Promise<null> {
        const e = fileEntry(id);
        e.sync.close();
        entries.delete(id);
        return null;
    }

    async function dirReaddir(id: number): Promise<readonly DirEntry[]> {
        const e = dirEntryRec(id);
        const out: DirEntry[] = [];
        for await (const [name, h] of (e.handle as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            out.push({name, type: isFsaDirectory(h) ? 'directory' : 'file'});
        }
        return out;
    }

    async function dirStat(_id: number): Promise<FileStat> {
        const now = Date.now();
        return {type: 'directory', size: 0n, mtimeMs: now, ctimeMs: now};
    }

    async function dirClose(id: number): Promise<null> {
        entries.delete(id);
        return null;
    }
}
