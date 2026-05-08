import {ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY, EINVAL} from "../wasi/Errno.ts";
import {FsError, type DirEntry, type DirHandle, type FileHandle, type FileSystem, type FileStat, type OpenFlags} from "./FileSystem.ts";
import {basename, dirname, normalize, split} from "./Path.ts";

interface FileNode {
    readonly type: 'file';
    bytes: Uint8Array;
    mtimeMs: number;
    ctimeMs: number;
}

interface DirNode {
    readonly type: 'directory';
    readonly children: Map<string, Node>;
    mtimeMs: number;
    ctimeMs: number;
}

type Node = FileNode | DirNode;

function newDir(now: number): DirNode {
    return {type: 'directory', children: new Map(), mtimeMs: now, ctimeMs: now};
}

function newFile(now: number): FileNode {
    return {type: 'file', bytes: new Uint8Array(), mtimeMs: now, ctimeMs: now};
}

function statOf(node: Node): FileStat {
    if (node.type === 'file') {
        return {type: 'file', size: BigInt(node.bytes.length), mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs};
    }
    return {type: 'directory', size: 0n, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs};
}

export class MemoryFs implements FileSystem {
    private readonly root: DirNode = newDir(Date.now());
    private readonly clock: () => number;

    constructor(clock: () => number = () => Date.now()) {
        this.clock = clock;
    }

    async open(path: string, flags: OpenFlags): Promise<FileHandle> {
        const norm = normalize(path);
        if (norm === '/') throw new FsError(EISDIR, `is a directory: ${path}`);
        if (flags.directory) throw new FsError(EISDIR, `directory open via open() not supported`);
        const parent = this.parentDir(norm);
        const name = basename(norm);
        let node = parent.children.get(name);
        if (node === undefined) {
            if (!flags.create) throw new FsError(ENOENT, `no such file: ${path}`);
            node = newFile(this.clock());
            parent.children.set(name, node);
            parent.mtimeMs = this.clock();
        } else {
            if (flags.exclusive && flags.create) throw new FsError(EEXIST, `file exists: ${path}`);
            if (node.type === 'directory') {
                if (flags.write || flags.truncate) throw new FsError(EISDIR, `is a directory: ${path}`);
            }
        }
        if (node.type === 'directory') throw new FsError(EISDIR, `is a directory: ${path}`);
        if (flags.truncate && flags.write) {
            node.bytes = new Uint8Array();
            node.mtimeMs = this.clock();
        }
        return new MemoryFileHandle(node, flags, () => this.clock());
    }

    async opendir(path: string): Promise<DirHandle> {
        const node = this.lookup(path);
        if (node.type !== 'directory') throw new FsError(ENOTDIR, `not a directory: ${path}`);
        return new MemoryDirHandle(node);
    }

    async stat(path: string): Promise<FileStat> {
        return statOf(this.lookup(path));
    }

    async mkdir(path: string): Promise<void> {
        const norm = normalize(path);
        if (norm === '/') throw new FsError(EEXIST, `file exists: ${path}`);
        const parent = this.parentDir(norm);
        const name = basename(norm);
        if (parent.children.has(name)) throw new FsError(EEXIST, `file exists: ${path}`);
        parent.children.set(name, newDir(this.clock()));
        parent.mtimeMs = this.clock();
    }

    async rmdir(path: string): Promise<void> {
        const norm = normalize(path);
        if (norm === '/') throw new FsError(EINVAL, `cannot remove root`);
        const parent = this.parentDir(norm);
        const name = basename(norm);
        const node = parent.children.get(name);
        if (!node) throw new FsError(ENOENT, `no such file: ${path}`);
        if (node.type !== 'directory') throw new FsError(ENOTDIR, `not a directory: ${path}`);
        if (node.children.size > 0) throw new FsError(ENOTEMPTY, `directory not empty: ${path}`);
        parent.children.delete(name);
        parent.mtimeMs = this.clock();
    }

    async unlink(path: string): Promise<void> {
        const norm = normalize(path);
        if (norm === '/') throw new FsError(EISDIR, `is a directory: ${path}`);
        const parent = this.parentDir(norm);
        const name = basename(norm);
        const node = parent.children.get(name);
        if (!node) throw new FsError(ENOENT, `no such file: ${path}`);
        if (node.type === 'directory') throw new FsError(EISDIR, `is a directory: ${path}`);
        parent.children.delete(name);
        parent.mtimeMs = this.clock();
    }

    async rename(from: string, to: string): Promise<void> {
        const fromN = normalize(from);
        const toN = normalize(to);
        if (fromN === '/' || toN === '/') throw new FsError(EINVAL, `cannot rename root`);
        const fromParent = this.parentDir(fromN);
        const fromName = basename(fromN);
        const node = fromParent.children.get(fromName);
        if (!node) throw new FsError(ENOENT, `no such file: ${from}`);
        const toParent = this.parentDir(toN);
        const toName = basename(toN);
        const existing = toParent.children.get(toName);
        if (existing) {
            if (existing.type === 'directory' && (existing as DirNode).children.size > 0) {
                throw new FsError(ENOTEMPTY, `target not empty: ${to}`);
            }
            if (existing.type !== node.type) {
                if (existing.type === 'directory') throw new FsError(EISDIR, `target is a directory: ${to}`);
                throw new FsError(ENOTDIR, `target not a directory: ${to}`);
            }
        }
        fromParent.children.delete(fromName);
        toParent.children.set(toName, node);
        const now = this.clock();
        fromParent.mtimeMs = now;
        toParent.mtimeMs = now;
    }

    private lookup(path: string): Node {
        const parts = split(path);
        let node: Node = this.root;
        for (const part of parts) {
            if (node.type !== 'directory') throw new FsError(ENOTDIR, `not a directory in path: ${path}`);
            const next = node.children.get(part);
            if (!next) throw new FsError(ENOENT, `no such file: ${path}`);
            node = next;
        }
        return node;
    }

    private parentDir(path: string): DirNode {
        const parent = this.lookup(dirname(path));
        if (parent.type !== 'directory') throw new FsError(ENOTDIR, `parent not a directory: ${path}`);
        return parent;
    }
}

class MemoryFileHandle implements FileHandle {
    constructor(
        private readonly node: FileNode,
        private readonly flags: OpenFlags,
        private readonly now: () => number,
    ) {}

    async read(buf: Uint8Array, offset: bigint): Promise<number> {
        if (!this.flags.read) throw new FsError(EINVAL, 'fd not opened for read');
        const off = Number(offset);
        if (off >= this.node.bytes.length) return 0;
        const take = Math.min(buf.length, this.node.bytes.length - off);
        buf.set(this.node.bytes.subarray(off, off + take));
        return take;
    }

    async write(buf: Uint8Array, offset: bigint): Promise<number> {
        if (!this.flags.write) throw new FsError(EINVAL, 'fd not opened for write');
        const off = Number(offset);
        const end = off + buf.length;
        if (end > this.node.bytes.length) {
            const grown = new Uint8Array(end);
            grown.set(this.node.bytes);
            this.node.bytes = grown;
        }
        this.node.bytes.set(buf, off);
        this.node.mtimeMs = this.now();
        return buf.length;
    }

    async truncate(size: bigint): Promise<void> {
        const n = Number(size);
        if (n < 0) throw new FsError(EINVAL, 'negative size');
        const next = new Uint8Array(n);
        next.set(this.node.bytes.subarray(0, Math.min(n, this.node.bytes.length)));
        this.node.bytes = next;
        this.node.mtimeMs = this.now();
    }

    async stat(): Promise<FileStat> {
        return statOf(this.node);
    }

    async sync(): Promise<void> {}

    async close(): Promise<void> {}
}

class MemoryDirHandle implements DirHandle {
    constructor(private readonly node: DirNode) {}

    async readdir(): Promise<readonly DirEntry[]> {
        const out: DirEntry[] = [];
        for (const [name, child] of this.node.children) {
            out.push({name, type: child.type});
        }
        return out;
    }

    async stat(): Promise<FileStat> {
        return statOf(this.node);
    }

    async close(): Promise<void> {}
}
