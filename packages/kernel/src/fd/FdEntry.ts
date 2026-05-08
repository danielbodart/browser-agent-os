import type {PipeEnd} from "../pipe/Pipe.ts";
import type {DirHandle, FileHandle, OpenFlags} from "../fs/FileSystem.ts";

export interface PipeFdEntry {
    readonly kind: 'pipe';
    readonly direction: 'read' | 'write';
    readonly end: PipeEnd;
}

export interface FileFdEntry {
    readonly kind: 'file';
    readonly handle: FileHandle;
    readonly flags: OpenFlags;
    position: bigint;
}

export interface DirFdEntry {
    readonly kind: 'dir';
    readonly handle: DirHandle;
    readonly path: string;
    readonly preopen: boolean;
}

export type FdEntry = PipeFdEntry | FileFdEntry | DirFdEntry;
