// AntiGravity AutoAccept — Anonymous Telemetry
// Fire-and-forget pings gated behind vscode.env.isTelemetryEnabled.
// No PII, no user IDs. Only event name + extension version.

const vscode = require('vscode');

const WORKER_URL = 'https://aa-telemetry.yazanbaker.workers.dev';

/**
 * Send an anonymous telemetry ping.
 * @param {'activate' | 'dashboard_open'} event
 * @param {Function} [log] - Optional logger
 */
function pingTelemetry(event, log) {
    if (!vscode.env.isTelemetryEnabled) {
        if (log) log(`[Telemetry] Skipped '${event}' — telemetry disabled by user`);
        return;
    }

    const version = require('../package.json').version;
    const url = `${WORKER_URL}/ping?e=${event}&v=${version}`;

    // Fire-and-forget — never blocks, never throws
    try {
        fetch(url).catch(() => { });
        if (log) log(`[Telemetry] Pinged '${event}' (v${version})`);
    } catch (_) { }
}

module.exports = { pingTelemetry };
