import {parentPort} from "node:worker_threads";
import {bootJspiRunner} from "@browser-agent-os/kernel";

if (!parentPort) {
    throw new Error("worker.mjs must be loaded as a worker_threads worker");
}

bootJspiRunner({
    onMessage(handler) {
        parentPort.on("message", handler);
    },
    postMessage(msg) {
        parentPort.postMessage(msg);
    },
});
