export type PipeEndKind = 'read' | 'write';

export interface PipeEnd {
    readonly kind: PipeEndKind;
    readonly id: number;
}

export interface Pipe {
    readonly readEnd: PipeEnd;
    readonly writeEnd: PipeEnd;
}

export type FdMap = ReadonlyMap<number, PipeEnd>;

export const DEFAULT_PIPE_CAPACITY = 64 * 1024;
