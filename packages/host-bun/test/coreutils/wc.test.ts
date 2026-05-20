import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, startServer, writeFile} from "./helpers.ts";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("wc", () => {
    it("default counts lines, words, bytes", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/f.txt", "hello world\nfoo bar baz\n");
        const r = await kernel.spawn("wc", ["/f.txt"]);
        expect(r.exitCode).toBe(0);
        const cols = dec.decode(r.stdout).trim().split(/\s+/);
        expect(cols.slice(0, 3)).toEqual(["2", "5", "24"]);
        expect(cols[3]).toBe("/f.txt");
    });

    it("-l counts lines only", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/f.txt", "a\nb\nc\n");
        const r = await kernel.spawn("wc", ["-l", "/f.txt"]);
        expect(r.exitCode).toBe(0);
        expect(dec.decode(r.stdout).trim().split(/\s+/)[0]).toBe("3");
    });

    it("missing file: exit 1", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("wc", ["/no.txt"]);
        expect(r.exitCode).toBe(1);
        expect(dec.decode(r.stderr)).toContain("wc: /no.txt");
    });
});
