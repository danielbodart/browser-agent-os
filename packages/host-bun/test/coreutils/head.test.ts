import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, startServer, writeFile} from "./helpers.ts";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("head", () => {
    it("default 10 lines from file", async () => {
        const {kernel, fs} = buildKernel(listener);
        const lines = Array.from({length: 20}, (_, i) => `line ${i + 1}`).join("\n") + "\n";
        await writeFile(fs, "/big.txt", lines);
        const r = await kernel.spawn("head", ["/big.txt"]);
        expect(r.exitCode).toBe(0);
        const out = dec.decode(r.stdout).split("\n").filter(s => s.length > 0);
        expect(out).toEqual(Array.from({length: 10}, (_, i) => `line ${i + 1}`));
    });

    it("-n 2 limits to 2 lines", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/x.txt", "a\nb\nc\nd\n");
        const r = await kernel.spawn("head", ["-n", "2", "/x.txt"]);
        expect(r.exitCode).toBe(0);
        expect(dec.decode(r.stdout)).toBe("a\nb\n");
    });

    it("-c 3 limits to 3 bytes", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/x.txt", "hello world\n");
        const r = await kernel.spawn("head", ["-c", "3", "/x.txt"]);
        expect(r.exitCode).toBe(0);
        expect(dec.decode(r.stdout)).toBe("hel");
    });

    it("missing file: exit 1", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("head", ["/no.txt"]);
        expect(r.exitCode).toBe(1);
        expect(dec.decode(r.stderr)).toContain("head: /no.txt");
    });
});
