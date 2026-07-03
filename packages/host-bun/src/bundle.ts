// Shared browser-bundle helper for dev servers and tests.
//
// Bun.build intermittently throws `error: Unexpected reading file: <path>` when
// several builds run at once and race to read a shared source module (e.g.
// kernel/src/index.ts, imported by every browser entrypoint). It reproduces only
// under load — green locally, flaky on CI's slower container FS.
//
// Two guards, both cheap: serialise every build process-wide so no two run
// concurrently, and retry the transient failure a few times.

let chain: Promise<unknown> = Promise.resolve();

const MAX_ATTEMPTS = 3;

/** Bundle a browser ESM entrypoint to a JS string. Serialised process-wide; retried on transient bundler errors. */
export function bundle(entry: string, label: string): Promise<string> {
    const run = chain.then(() => buildOnce(entry, label));
    // Keep the chain alive even if this build rejects, so later builds still serialise.
    chain = run.then(() => {}, () => {});
    return run;
}

async function buildOnce(entry: string, label: string): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const out = await Bun.build({entrypoints: [entry], target: "browser", format: "esm"});
            if (!out.success) throw new Error(`${label} bundle failed:\n${out.logs.join("\n")}`);
            return out.outputs[0].text();
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`${label} bundle failed after ${MAX_ATTEMPTS} attempts: ${String(lastErr)}`);
}
