import {Worker} from "node:worker_threads";
import {fileURLToPath} from "node:url";
import {application, JSPITransport} from "@browser-agent-os/kernel";
import {runContract} from "../pipe.contract.ts";

const baseUrl = process.argv[2];
if (!baseUrl) {
    console.error("usage: runner.mjs <baseUrl>");
    process.exit(2);
}

const workerScript = fileURLToPath(new URL("./worker.mjs", import.meta.url));

const workerFactory = (url) => {
    const w = new Worker(url, {
        execArgv: [
            "--experimental-transform-types",
            "--no-warnings",
        ],
    });
    return {
        postMessage(msg) {
            w.postMessage(msg);
        },
        addMessageListener(listener) {
            w.on("message", listener);
        },
        addErrorListener(listener) {
            w.on("error", err => listener(err instanceof Error ? err : new Error(String(err))));
        },
        terminate() {
            void w.terminate();
        },
    };
};

const transport = new JSPITransport({workerFactory, runnerUrl: workerScript});
const app = application({
    binaryResolver: name => new URL(`/bin/${name}`, baseUrl),
    transport,
});

const results = await runContract({kernel: app.kernel, transport});
process.stdout.write(JSON.stringify(results) + "\n");
process.exit(0);
