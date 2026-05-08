import {ESUCCESS} from "../wasi/Errno.ts";
import type {MemoryAccessors} from "./wasiCommon.ts";
import type {ExtClient} from "./ExtClient.ts";

export function extPreview1(opts: {
    readonly client: ExtClient;
    readonly mem: MemoryAccessors;
}): Record<string, unknown> {
    const {client, mem} = opts;

    const readSlices = (basePtr: number, count: number) => {
        const out: Array<{ptr: number; len: number}> = [];
        for (let i = 0; i < count; i++) {
            const ptr = mem.view().getUint32(basePtr + i * 8, true);
            const len = mem.view().getUint32(basePtr + i * 8 + 4, true);
            out.push({ptr, len});
        }
        return out;
    };

    const readStrings = (basePtr: number, count: number): string[] =>
        readSlices(basePtr, count).map(s => mem.readString(s.ptr, s.len));

    return {
        async fd_pipe(readFdOutPtr: number, writeFdOutPtr: number): Promise<number> {
            const reply = await client.invoke({op: 'fd_pipe'});
            if (!reply.ok) return reply.errno;
            const r = reply.result as {readFd: number; writeFd: number};
            mem.view().setUint32(readFdOutPtr, r.readFd, true);
            mem.view().setUint32(writeFdOutPtr, r.writeFd, true);
            return ESUCCESS;
        },
        async proc_spawn(
            pathPtr: number, pathLen: number,
            argvPtr: number, argvLen: number,
            envPtr: number, envLen: number,
            fdmapPtr: number, fdmapLen: number,
            pidOutPtr: number,
        ): Promise<number> {
            const path = mem.readString(pathPtr, pathLen);
            const argv = readStrings(argvPtr, argvLen);
            const envEntries = readStrings(envPtr, envLen);
            const env: Record<string, string> = {};
            for (const e of envEntries) {
                const eq = e.indexOf('=');
                if (eq < 0) env[e] = '';
                else env[e.slice(0, eq)] = e.slice(eq + 1);
            }
            const fdmap: Array<[number, number]> = [];
            for (let i = 0; i < fdmapLen; i++) {
                const childFd = mem.view().getInt32(fdmapPtr + i * 8, true);
                const parentFd = mem.view().getInt32(fdmapPtr + i * 8 + 4, true);
                fdmap.push([childFd, parentFd]);
            }
            const reply = await client.invoke({op: 'proc_spawn', path, argv, env, fdmap});
            if (!reply.ok) return reply.errno;
            const r = reply.result as {pid: number};
            mem.view().setUint32(pidOutPtr, r.pid, true);
            return ESUCCESS;
        },
        async proc_join(pid: number, exitOutPtr: number): Promise<number> {
            const reply = await client.invoke({op: 'proc_join', pid});
            if (!reply.ok) return reply.errno;
            const r = reply.result as {exitCode: number};
            mem.view().setInt32(exitOutPtr, r.exitCode, true);
            return ESUCCESS;
        },
    };
}
