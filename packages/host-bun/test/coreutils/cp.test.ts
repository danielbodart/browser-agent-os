import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, readFile, startServer, writeFile} from "./helpers.ts";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("cp", () => {
    it("copies a file", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/src.txt", "hello\n");
        const r = await kernel.spawn("cp", ["/src.txt", "/dst.txt"]);
        expect(r.exitCode).toBe(0);
        expect(new TextDecoder().decode(await readFile(fs, "/dst.txt"))).toBe("hello\n");
    });

    it("overwrites existing dest", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/src.txt", "new\n");
        await writeFile(fs, "/dst.txt", "old-and-longer\n");
        const r = await kernel.spawn("cp", ["/src.txt", "/dst.txt"]);
        expect(r.exitCode).toBe(0);
        expect(new TextDecoder().decode(await readFile(fs, "/dst.txt"))).toBe("new\n");
    });
});
