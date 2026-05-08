import type {FileStat, OpenFlags, DirEntry} from "../fs/FileSystem.ts";

export interface Syscalls {
    fdRead(fd: number, length: number): Promise<ReadResult>;
    fdWrite(fd: number, bytes: Uint8Array): Promise<WriteResult>;
    fdPread(fd: number, length: number, offset: bigint): Promise<ReadResult>;
    fdPwrite(fd: number, bytes: Uint8Array, offset: bigint): Promise<WriteResult>;
    fdClose(fd: number): Promise<void>;
    fdSeek(fd: number, offset: bigint, whence: 0 | 1 | 2): Promise<bigint>;
    fdTell(fd: number): Promise<bigint>;
    fdFilestatGet(fd: number): Promise<FileStat>;
    fdFilestatSetSize(fd: number, size: bigint): Promise<void>;
    fdSync(fd: number): Promise<void>;
    fdReaddir(fd: number, cookie: bigint): Promise<readonly DirReadEntry[]>;
    pathOpen(dirfd: number, path: string, flags: OpenFlags): Promise<number>;
    pathFilestatGet(dirfd: number, path: string): Promise<FileStat>;
    pathCreateDirectory(dirfd: number, path: string): Promise<void>;
    pathRemoveDirectory(dirfd: number, path: string): Promise<void>;
    pathUnlinkFile(dirfd: number, path: string): Promise<void>;
    pathRename(dirfd: number, from: string, toDirfd: number, to: string): Promise<void>;
}

export interface ReadResult {
    readonly n: number;
    readonly bytes: Uint8Array;
}

export interface WriteResult {
    readonly n: number;
}

export interface DirReadEntry extends DirEntry {
    readonly cookie: bigint;
    readonly inode: bigint;
}
