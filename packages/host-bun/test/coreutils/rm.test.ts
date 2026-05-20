import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, startServer, writeFile} from "./helpers.ts";
import {FsError} from "@browser-agent-os/kernel";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("rm", () => {
    it("removes a file", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/f.txt", "x");
        const r = await kernel.spawn("rm", ["/f.txt"]);
        expect(r.exitCode).toBe(0);
        await expect(fs.stat("/f.txt")).rejects.toBeInstanceOf(FsError);
    });

    it("-r removes directory tree", async () => {
        const {kernel, fs} = buildKernel(listener);
        await fs.mkdir("/d");
        await fs.mkdir("/d/sub");
        await writeFile(fs, "/d/sub/a", "a");
        await writeFile(fs, "/d/b", "b");
        const r = await kernel.spawn("rm", ["-r", "/d"]);
        expect(r.exitCode).toBe(0);
        await expect(fs.stat("/d")).rejects.toBeInstanceOf(FsError);
    });

    it("directory without -r: exit 1", async () => {
        const {kernel, fs} = buildKernel(listener);
        await fs.mkdir("/d");
        const r = await kernel.spawn("rm", ["/d"]);
        expect(r.exitCode).toBe(1);
        expect(dec.decode(r.stderr)).toContain("rm: /d");
    });

    it("-f silences missing file", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("rm", ["-f", "/nope"]);
        expect(r.exitCode).toBe(0);
        expect(r.stderr.length).toBe(0);
    });
});
