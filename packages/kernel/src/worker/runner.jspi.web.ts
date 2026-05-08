/// <reference lib="webworker" />
import {bootJspiRunner} from "./jspi.ts";

bootJspiRunner({
    onMessage(handler) {
        self.addEventListener('message', e => handler((e as MessageEvent).data));
    },
    postMessage(msg) {
        self.postMessage(msg);
    },
});
