import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, readFile, startServer, writeFile} from "./helpers.ts";
import {FsError} from "@browser-agent-os/kernel";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("mv", () => {
    it("renames a file", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/a.txt", "hi");
        const r = await kernel.spawn("mv", ["/a.txt", "/b.txt"]);
        expect(r.exitCode).toBe(0);
        expect(new TextDecoder().decode(await readFile(fs, "/b.txt"))).toBe("hi");
        await expect(fs.stat("/a.txt")).rejects.toBeInstanceOf(FsError);
    });

    it("missing source: exit 1", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("mv", ["/no.txt", "/b.txt"]);
        expect(r.exitCode).toBe(1);
        expect(dec.decode(r.stderr)).toContain("mv:");
    });
});
