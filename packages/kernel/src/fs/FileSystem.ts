export interface OpenFlags {
    readonly read: boolean;
    readonly write: boolean;
    readonly create: boolean;
    readonly exclusive: boolean;
    readonly truncate: boolean;
    readonly append: boolean;
    readonly directory: boolean;
}

export interface FileStat {
    readonly type: 'file' | 'directory';
    readonly size: bigint;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
}

export interface DirEntry {
    readonly name: string;
    readonly type: 'file' | 'directory';
}

export interface FileHandle {
    read(buf: Uint8Array, offset: bigint): Promise<number>;
    write(buf: Uint8Array, offset: bigint): Promise<number>;
    truncate(size: bigint): Promise<void>;
    stat(): Promise<FileStat>;
    sync(): Promise<void>;
    close(): Promise<void>;
}

export interface DirHandle {
    readdir(): Promise<readonly DirEntry[]>;
    stat(): Promise<FileStat>;
    close(): Promise<void>;
}

export interface FileSystem {
    open(path: string, flags: OpenFlags): Promise<FileHandle>;
    opendir(path: string): Promise<DirHandle>;
    stat(path: string): Promise<FileStat>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
}

export class FsError extends Error {
    constructor(public readonly errno: number, message: string) {
        super(message);
        this.name = 'FsError';
    }
}
