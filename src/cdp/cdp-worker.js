// AntiGravity AutoAccept — CDP Worker Process
// Runs in a child process via child_process.fork().
// Owns ALL ws WebSocket instances — the main extension process has zero.
// Communicates with the main extension via IPC (process.send/on).

const WebSocket = require('ws');

// ─── P1: Memory Monitoring ───────────────────────────────────────

setInterval(() => {
    const mem = process.memoryUsage();
    try {
        process.send({
            type: 'memory-report',
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            rss: Math.round(mem.rss / 1024 / 1024)
        });
    } catch (e) { }
}, 60000);

// ─── IPC Message Handler ──────────────────────────────────────────

process.on('message', async (msg) => {
    switch (msg.type) {
        case 'eval': {
            const { id, wsUrl, expression } = msg;
            try {
                const result = await burstEval(wsUrl, expression);
                process.send({ type: 'eval-result', id, result });
            } catch (e) {
                process.send({ type: 'eval-result', id, error: e.message });
            }
            break;
        }

        case 'burst-inject': {
            const { id, wsUrl, targetId, script, isPaused } = msg;
            try {
                const result = await burstInject(wsUrl, targetId, script, isPaused);
                process.send({ type: 'burst-inject-result', id, targetId, result });
            } catch (e) {
                process.send({ type: 'burst-inject-result', id, targetId, error: e.message });
            }
            break;
        }

        case 'shutdown': {
            process.exit(0);
            break;
        }
    }
});

// ─── Ephemeral Burst Eval ─────────────────────────────────────────

function burstEval(wsUrl, expression) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const msgId = 1;
        let settled = false;

        const cleanup = () => {
            settled = true;
            ws.removeAllListeners();
            try { ws.close(); } catch (e) { }
        };

        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('timeout'));
        }, 5000);

        ws.on('open', () => {
            ws.send(JSON.stringify({
                id: msgId,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true }
            }));
        });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.id === msgId) {
                    clearTimeout(timeout);
                    cleanup();
                    resolve(msg);
                }
            } catch (e) { }
        });

        ws.on('error', () => {
            clearTimeout(timeout);
            if (!settled) { cleanup(); reject(new Error('ws error')); }
        });

        ws.on('close', () => {
            clearTimeout(timeout);
            if (!settled) { cleanup(); reject(new Error('ws closed')); }
        });
    });
}

// ─── Multi-step Burst Inject (P0: single message listener) ───────

function burstInject(wsUrl, targetId, script, isPaused) {
    return new Promise(async (resolve, reject) => {
        let ws;
        try {
            ws = await openSocket(wsUrl);
        } catch (e) {
            reject(e);
            return;
        }

        // P0 Fix: Single message listener routed by ID.
        // Previous version added a NEW listener per send() call, causing
        // listener accumulation if inner timeouts fired before cleanup.
        let id = 0;
        const pending = new Map(); // id → { resolve, reject, timer }

        const messageHandler = (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.id && pending.has(msg.id)) {
                    const handler = pending.get(msg.id);
                    pending.delete(msg.id);
                    clearTimeout(handler.timer);
                    handler.resolve(msg);
                }
            } catch (e) { }
        };
        ws.on('message', messageHandler);

        const send = (method, params = {}) => {
            return new Promise((res, rej) => {
                const myId = ++id;
                const timer = setTimeout(() => {
                    pending.delete(myId);
                    rej(new Error(`timeout: ${method}`));
                }, 5000);
                pending.set(myId, { resolve: res, reject: rej, timer });
                ws.send(JSON.stringify({ id: myId, method, params }));
            });
        };

        try {
            // Pre-check: window/document
            const windowCheck = await send('Runtime.evaluate', {
                expression: 'typeof window !== "undefined" && typeof document !== "undefined"'
            });
            if (windowCheck.result?.result?.value !== true) {
                resolve('no-window');
                return;
            }

            // Force-clear stale observer
            await send('Runtime.evaluate', {
                expression: 'if (typeof window !== "undefined") { if (typeof window.__AA_CLEANUP === "function") window.__AA_CLEANUP(); window.__AA_OBSERVER_ACTIVE = false; }'
            });

            // Inject MutationObserver script
            const evalMsg = await send('Runtime.evaluate', { expression: script });
            if (evalMsg.error) { resolve('cdp-error'); return; }
            const exDesc = evalMsg.result?.exceptionDetails;
            if (exDesc) { resolve('script-exception'); return; }
            const result = evalMsg.result?.result?.value || 'undefined';

            // If extension is paused, set pause flag
            if (isPaused && (result === 'observer-installed' || result === 'already-active')) {
                await send('Runtime.evaluate', {
                    expression: 'window.__AA_PAUSED = true; "paused-on-inject"'
                });
            }

            resolve(result);
        } catch (e) {
            reject(e);
        } finally {
            // Clean up ALL pending handlers and the single listener
            for (const [, handler] of pending) {
                clearTimeout(handler.timer);
            }
            pending.clear();
            ws.removeAllListeners();
            try { ws.close(); } catch (e) { }
        }
    });
}

function openSocket(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
            ws.removeAllListeners();
            try { ws.close(); } catch (e) { }
            reject(new Error('socket timeout'));
        }, 5000);

        ws.on('open', () => {
            clearTimeout(timeout);
            resolve(ws);
        });

        ws.on('error', () => {
            clearTimeout(timeout);
            ws.removeAllListeners();
            reject(new Error('socket error'));
        });
    });
}

// Keep child alive
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
