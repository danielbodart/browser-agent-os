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

    it("-r copies directory tree", async () => {
        const {kernel, fs} = buildKernel(listener);
        await fs.mkdir("/src");
        await writeFile(fs, "/src/a", "A");
        await fs.mkdir("/src/sub");
        await writeFile(fs, "/src/sub/b", "B");
        const r = await kernel.spawn("cp", ["-r", "/src", "/dst"]);
        expect(r.exitCode).toBe(0);
        expect(new TextDecoder().decode(await readFile(fs, "/dst/a"))).toBe("A");
        expect(new TextDecoder().decode(await readFile(fs, "/dst/sub/b"))).toBe("B");
    });

    // Error-return paths (path_open returns ENOENT / EISDIR -> error.X -> exit 1)
    // currently trap with "Unreachable" due to the Zig 0.16 wasm "bitcast_invalid"
    // stub issue. The happy paths and -r work because path_open succeeds and
    // execution stays on the optimized direct-import call path. See ROADMAP
    // Stage 6 known limitations.
});
