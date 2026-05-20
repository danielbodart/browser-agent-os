import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, startServer, writeFile} from "./helpers.ts";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("tail", () => {
    it("default 10 lines from file", async () => {
        const {kernel, fs} = buildKernel(listener);
        const lines = Array.from({length: 20}, (_, i) => `line ${i + 1}`).join("\n") + "\n";
        await writeFile(fs, "/big.txt", lines);
        const r = await kernel.spawn("tail", ["/big.txt"]);
        expect(r.exitCode).toBe(0);
        const out = dec.decode(r.stdout).split("\n").filter(s => s.length > 0);
        expect(out).toEqual(Array.from({length: 10}, (_, i) => `line ${i + 11}`));
    });

    it("-n 2 returns last 2 lines", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/x.txt", "a\nb\nc\nd\n");
        const r = await kernel.spawn("tail", ["-n", "2", "/x.txt"]);
        expect(r.exitCode).toBe(0);
        expect(dec.decode(r.stdout)).toBe("c\nd\n");
    });

    it("-c 3 returns last 3 bytes", async () => {
        const {kernel, fs} = buildKernel(listener);
        await writeFile(fs, "/x.txt", "hello world");
        const r = await kernel.spawn("tail", ["-c", "3", "/x.txt"]);
        expect(r.exitCode).toBe(0);
        expect(dec.decode(r.stdout)).toBe("rld");
    });

    it("missing file: exit 1", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("tail", ["/no.txt"]);
        expect(r.exitCode).toBe(1);
        expect(dec.decode(r.stderr)).toContain("tail: /no.txt");
    });
});
