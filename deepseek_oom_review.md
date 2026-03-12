# DeepSeek Review: OOM Root Cause Analysis with Memory Log Evidence

## Crash Data
Memory log from the extension host process (PID 35784) just before OOM crash:

```
--- AutoAccept Memory Log (PID 35784) ---
16:30:22 | heap=145MB rss=480MB ext=6MB ab=0MB | sessions=0 ignored=4 pending=0
16:30:23 | heap=139MB rss=371MB ext=5MB ab=0MB | sessions=0 ignored=4 pending=0
16:30:40 | heap=164MB rss=423MB ext=5MB ab=0MB | sessions=0 ignored=3 pending=0
16:30:52 | heap=130MB rss=473MB ext=5MB ab=0MB | sessions=0 ignored=4 pending=0
16:30:53 | heap=149MB rss=368MB ext=6MB ab=0MB | sessions=0 ignored=4 pending=0
16:31:10 | heap=208MB rss=458MB ext=11MB ab=0MB | sessions=0 ignored=4 pending=0
16:31:22 | heap=133MB rss=474MB ext=6MB ab=0MB | sessions=0 ignored=4 pending=0
16:31:23 | heap=149MB rss=368MB ext=6MB ab=0MB | sessions=0 ignored=4 pending=0
```

Log ran for ~1 minute before OOM killed the window. Only 8 data points captured.

## Key Observations

### 1. Extension has 0 active sessions
- `sessions=0` — no CDP connections are active
- `pending=0` — no IPC calls in flight
- `ignored=3-4` — only a few filtered targets
- The extension is essentially IDLE, yet ext host uses 130-208MB heap

### 2. These metrics are for the ENTIRE extension host
- `process.memoryUsage()` reports the WHOLE Node.js process (all extensions combined)
- We cannot isolate our extension's memory from this
- The 145-208MB heap and 370-480MB RSS fluctuation suggests V8 GC pressure

### 3. Heap oscillates wildly
- Range: 130MB ↔ 208MB within 1 minute
- This pattern suggests periodic allocations + GC cycles
- The spike to 208MB @ 16:31:10 with ext=11MB suggests external allocations

## Architecture Recap
Our extension uses `child_process.fork()` to isolate WebSocket instances:

```
[AG Window 1] → ext host process (shared with ALL extensions)
                  └─ child process: cdp-worker.js (owns ws instances)

[AG Window 2] → ext host process (shared with ALL extensions)  
                  └─ child process: cdp-worker.js (owns ws instances)

[AG Window N] → ext host process...
                  └─ child process...
```

### Per-Window Memory Cost
| Component | Memory |
|-----------|--------|
| Extension code + require() | ~5-10MB |
| child_process.fork() (cdp-worker) | ~30-50MB |
| Worker ws allocations (ephemeral) | ~1-5MB |
| **Total per window** | **~36-65MB** |

## Potential Causes

### Theory A: child_process.fork() Memory Cost
Each window spawns a Node.js child process. On Windows, this is NOT a POSIX fork (no CoW); it creates a FULL new Node.js runtime. With 3-4 windows:
- 3-4 workers × 30-50MB = 90-200MB EXTRA system memory
- Plus each extension host process is 200-500MB
- Total: 600MB-2GB+ across all windows

**Problem**: Windows may hit per-process or system memory limits, triggering OOM in the weakest window.

### Theory B: IPC Channel Memory
`child_process.fork()` creates an IPC channel using Node.js's internal serialization (`node:v8`). Each IPC message is serialized/deserialized. The heartbeat sends the FULL DOMObserver script (~28KB) via IPC for each `burst-inject`. Over time:
- 28KB × 6 targets/heartbeat × 6 heartbeats/min × 60 min = ~60MB of serialized IPC data per hour
- If Node.js doesn't GC IPC buffers promptly, this could grow

### Theory C: buildDOMObserverScript() String Allocation
The `buildDOMObserverScript()` function generates a ~28KB JavaScript string on every call. It's called:
- Once per `_handleNewTarget()` (new webview discovered)
- Once per dead session re-injection in heartbeat
- Once per `reinjectAll()` (unpause, config change)

Each call creates a NEW 28KB string. These are NOT cached. V8 must GC each one.

### Theory D: log() Output Channel Growth
Every heartbeat generates 3-5 `outputChannel.appendLine()` calls. VS Code's OutputChannel stores the FULL history in memory. Over hours:
- ~5 lines × 100 chars × 6/min × 60 min = ~180KB/hour
- After 10 hours: ~1.8MB (probably not the culprit)

### Theory E: Not Our Extension At All
The memory log shows our extension has 0 sessions and 0 pending. The 130-208MB heap is from ALL extensions in the shared ext host process. Another extension (or AG IDE internals) could be the real culprit.

## Questions for DeepSeek
1. **Is `child_process.fork()` too expensive on Windows?** Each fork creates a ~30-50MB Node.js process. Should we switch to `worker_threads` (shares V8 heap, lower memory) even though it means TypedArrays from ws would be in the same V8 isolate?

2. **Can we cache `buildDOMObserverScript()`?** The script only changes when custom texts or filters change. We could memoize it and pass the cached string to the worker.

3. **Should we abandon the child process entirely?** Given that the memory log shows 0 sessions (the extension is idle), the child process overhead is wasted. Could we:
   - Only spawn the worker when sessions > 0
   - Kill it when sessions drop to 0
   - This would reduce idle memory by ~30-50MB per window

4. **Is the IPC serialization of the 28KB script a significant leak vector?** Node.js IPC uses structured clone. Does this create copies that aren't GC'd promptly?

5. **How can we isolate our extension's memory from the shared extension host?** The current logging shows the ENTIRE process. Is there a way to measure just our allocations?

## Proposed Immediate Fix: Lazy Worker
Instead of spawning the worker at `start()`, only spawn when first needed, and kill it after 60s of 0 sessions:

```javascript
// Only spawn worker when actually needed
_ensureWorker() {
    if (this._worker && !this._worker.killed) return this._worker;
    // ... spawn logic
    this._scheduleIdleKill();
}

// Auto-kill worker when idle (0 sessions for 60s)
_scheduleIdleKill() {
    this._idleKillTimer = setInterval(() => {
        if (this.sessions.size === 0 && this._worker) {
            this.log('[CDP] No sessions for 60s, killing idle worker');
            this._killWorker();
        }
    }, 60000);
}
```

This eliminates the ~30-50MB worker cost when the extension is not actively managing any webview targets.
