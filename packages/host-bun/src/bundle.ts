// Shared browser-bundle helper for dev servers and tests.
//
// Bun.build intermittently fails with `error: Unexpected reading file: <path>`
// when it runs during `bun test`: the test runtime is transpiling the same
// shared source (kernel/src/index.ts, imported by every browser entrypoint and
// by many test files) while the bundler reads it. It only trips on CI's runner
// scheduling — never reproduced locally or in the CI container image.
//
// Guards: serialise every build process-wide so no two run at once, and retry
// the transient failure with a short delay so the contended read can settle.

let chain: Promise<unknown> = Promise.resolve();

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 300;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Bundle a browser ESM entrypoint to a JS string. Serialised process-wide; retried on transient bundler errors. */
export function bundle(entry: string, label: string): Promise<string> {
    const run = chain.then(() => buildOnce(entry, label));
    // Keep the chain alive even if this build rejects, so later builds still serialise.
    chain = run.then(() => {}, () => {});
    return run;
}

async function buildOnce(entry: string, label: string): Promise<string> {
    let lastDetail = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const out = await Bun.build({entrypoints: [entry], target: "browser", format: "esm"});
            if (out.success) return out.outputs[0].text();
            lastDetail = out.logs.map(String).join("\n");
        } catch (e) {
            // Bun.build throws AggregateError on failure; its .errors hold the real messages.
            const errs = (e as {errors?: unknown[]}).errors;
            lastDetail = Array.isArray(errs) ? errs.map(String).join("\n") : String(e);
        }
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
    throw new Error(`${label} bundle failed after ${MAX_ATTEMPTS} attempts:\n${lastDetail}`);
}
