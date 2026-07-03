// Shared browser-bundle helper for dev servers and tests.
//
// We shell out to the `bun build` CLI instead of the in-process `Bun.build`
// API on purpose. Under `bun test`, the runtime has already imported
// kernel/src/index.ts (many test files use it), and calling Bun.build on an
// entrypoint that also imports it makes the bundler's file layer collide with
// the loaded module — Bun throws `Unexpected reading file: .../index.ts`. It's
// deterministic on CI's runner and unreproducible locally. A separate `bun
// build` process has its own module registry, so there's no collision.

/** Bundle a browser ESM entrypoint to a JS string via a separate `bun build` process. */
export async function bundle(entry: string, label: string): Promise<string> {
    const proc = Bun.spawn(
        ["bun", "build", entry, "--target=browser", "--format=esm"],
        {stdout: "pipe", stderr: "pipe"},
    );
    const [code, js, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    if (code !== 0 || js.length === 0) {
        throw new Error(`${label} bundle failed (exit ${code}):\n${err}`);
    }
    return js;
}
