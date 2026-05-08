import type {MessagingWorker, MessagingWorkerFactory} from "@browser-agent-os/kernel";

const adaptWebWorker = (worker: Worker): MessagingWorker => ({
    postMessage(message, transfer) {
        if (transfer && transfer.length > 0) {
            worker.postMessage(message, {transfer: [...transfer] as Transferable[]});
        } else {
            worker.postMessage(message);
        }
    },
    addMessageListener(listener) {
        worker.addEventListener('message', e => listener((e as MessageEvent).data));
    },
    addErrorListener(listener) {
        worker.addEventListener('error', e => {
            const ev = e as ErrorEvent;
            listener(new Error(ev.message ?? 'worker error'));
        });
    },
    terminate() { worker.terminate(); },
});

export const webWorkerFactory: MessagingWorkerFactory = url =>
    adaptWebWorker(new Worker(url, {type: 'module'}));
