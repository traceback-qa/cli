/**
 * Scrcpy capture agent — streams a locally-attached Android device's screen to a relay
 * session's public URL, using the real `scrcpy` protocol instead of `adb exec-out screenrecord`.
 *
 * Replaces the old pipeline (see git history / `relay-stream.mjs`, now unused):
 *
 *     adb exec-out screenrecord --output-format=h264 ...   ->  Annex-B H.264, no in-band PTS
 *
 * `screenrecord` is a one-shot recording tool, not built for live mirroring: it has no
 * presentation timestamps (the old viewer synthesized a fake constant-33ms step), and Android
 * caps a single invocation, forcing a kill/respawn loop that glitches on every restart.
 *
 * This module instead pushes the vendored scrcpy server (`assets/scrcpy/scrcpy-server.jar`,
 * NetrisTV's `scrcpy-ws` fork, version {@link SERVER_VERSION} — same jar `ws-scrcpy` itself
 * ships prebuilt at `vendor/Genymobile/scrcpy/scrcpy-server.jar`) to the device and launches it
 * in its plain "desktop client" mode (`DesktopConnection` / `tunnelForward`, NOT the `web`
 * WebSocketServer mode `ws-scrcpy` uses for its own always-on multi-viewer proxy — we don't need
 * that machinery since the backend's `StreamRelay` already fans out to multiple browser
 * viewers). That mode's wire protocol (verified against
 * `scrcpy-ws/server/src/main/java/com/genymobile/scrcpy/{Server,DesktopConnection,
 * Connection,ScreenEncoder}.java`) is:
 *
 *   1. Launch args (16 positional args after the client version — see {@link buildServerArgs})
 *      configure the encoder, including `sendFrameMeta=true` (arg 8), which is the whole
 *      point: real per-frame presentation timestamps instead of a synthesized guess.
 *   2. The server opens a `LocalServerSocket` named `scrcpy` and `accept()`s TWO connections in
 *      order: the video socket, then a control socket (required even with `control=false` —
 *      the constructor blocks on it regardless). `adb forward` maps a local TCP port to that
 *      abstract socket; each new TCP connection to the forwarded port triggers a fresh
 *      on-device `accept()`.
 *   3. On the video socket: 1 dummy byte, then a 68-byte header (64-byte device name + 2-byte
 *      BE width + 2-byte BE height), then a stream of frame packets: 8-byte BE PTS (µs; a
 *      sentinel value for the SPS/PPS config packet) + 4-byte BE payload size + that many bytes
 *      of raw H.264.
 *
 * This module doesn't parse any of that beyond what's needed to launch the server and open the
 * two sockets — the video-socket byte stream (dummy byte, header, and all frame packets) is
 * forwarded to the backend **verbatim**, same "no intermediate format" principle the old script
 * used. All protocol-aware parsing lives in exactly one place: the browser viewer page
 * (`backend-relay/src/adapters/api/static/relay_viewer.py`).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Must match the vendored jar's `BuildConfig.VERSION_NAME` (`Server.java` rejects a mismatch). */
const SERVER_VERSION = '1.19-ws7';
const SERVER_JAR_NAME = 'scrcpy-server.jar';
const DEVICE_JAR_PATH = `/data/local/tmp/${SERVER_JAR_NAME}`;
const LOCAL_SOCKET_NAME = 'scrcpy';

const CONNECT_RETRY_TIMEOUT_MS = 8_000;
const CONNECT_RETRY_INTERVAL_MS = 150;
const MAX_RECONNECT_DELAY_MS = 15_000;

export interface ScrcpyAgentOptions {
  /** Backend API base URL, e.g. `http://localhost:8000`. */
  apiUrl: string;
  /** Auth token for `/relay/agent/stream` — same credential the relay agent connection uses. */
  token: string;
  sessionId: string;
  /** adb serial / UDID of the device to mirror. */
  udid: string;
  /** Video bitrate in bits/sec. */
  bitrate?: number;
  /**
   * Max long-edge dimension in pixels. Defaults to 1024, NOT 0 (native resolution) —
   * verified live against a real device/AVD: native resolution (e.g. 1280x2848) made
   * `MediaCodec.configure` throw a bare `IllegalArgumentException` and kill the server
   * outright on a software-encoded headless emulator. 1024 is the bound this was actually
   * proven to work at end-to-end (real frames, correct PTS); pass 0 explicitly only against
   * a device/encoder already known to handle its native resolution.
   */
  maxSize?: number;
  /** Max encoder fps (0 = unlimited). */
  maxFps?: number;
  /** Path to the `adb` executable. Defaults to `adb` on PATH, or `$ANDROID_HOME/platform-tools/adb`. */
  adbPath?: string;
  onLog?: (line: string) => void;
}

export interface ScrcpyAgent {
  /** Stop the reconnect loop and tear down the current capture, if any. */
  stop: () => void;
}

function resolveAdbPath(explicit: string | undefined): string {
  if (explicit) return explicit;
  if (process.env['ADB_PATH']) return process.env['ADB_PATH'];
  if (process.env['ANDROID_HOME']) {
    return path.join(process.env['ANDROID_HOME'], 'platform-tools/adb');
  }
  return 'adb';
}

/** Args after the client version, per `Server.parseArguments`'s 16-parameter (non-"web") form. */
function buildServerArgs(opts: Required<Pick<ScrcpyAgentOptions, 'bitrate' | 'maxSize' | 'maxFps'>>): string[] {
  return [
    'info', // 1: log level
    String(opts.maxSize), // 2: maxSize (0 = native)
    String(opts.bitrate), // 3: bitRate
    String(opts.maxFps), // 4: maxFps (0 = unlimited)
    '-1', // 5: lockedVideoOrientation (unlocked)
    'true', // 6: tunnelForward — we `adb forward`; the server listens, we connect
    '-', // 7: crop (none)
    'true', // 8: sendFrameMeta — real per-frame PTS; the entire point of this module
    'false', // 9: control — view-only for now, no remote input injection
    '0', // 10: displayId (default display)
    'false', // 11: showTouches
    // 12: stayAwake — deliberately false, NOT the obviously-friendlier `true`. Verified live
    // against a real device/AVD: `stayAwake=true` makes `Connection`'s constructor write
    // `stay_on_while_plugged_in` via a reflection-based ContentProvider call
    // (Connection.java) that throws `SecurityException: Calling uid: 2000 doesn't match
    // source uid: 0` on newer Android (stricter `AttributionSource` enforcement) — and that
    // failure corrupts the JNI thread's pending-exception state badly enough that the
    // *next*, unrelated call (`MediaCodec.configure` for the video encoder) then also throws
    // and kills the whole server. `false` skips that content-provider call entirely.
    'false',
    '-', // 13: codecOptions (none)
    '-', // 14: encoderName (default)
    'false', // 15: powerOffScreenOnClose — never turn off the developer's own screen
  ];
}

function run(
  adb: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(adb, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          proc.kill();
          reject(new Error(`adb ${args.join(' ')} timed out`));
        }, opts.timeoutMs)
      : null;
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`adb ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Kill any scrcpy server left running from a previous cycle before launching a new one.
 *
 * Verified live against a real device: killing our Node-side `adb shell` child process
 * (`serverProc.kill()` in {@link captureOnce}'s cleanup) only kills the *local* adb client —
 * `nohup` makes the on-device process explicitly survive that. Without this step, every
 * reconnect (network blip, WS drop, anything that makes the outer loop retry) leaves the old
 * server still holding the `scrcpy` `LocalServerSocket`, so the next launch can't bind it and
 * the new connections silently pair up with the stale server instead — no error, just an
 * instant, silent, zero-byte connect/close loop.
 */
async function killStaleServer(adb: string, udid: string): Promise<void> {
  try {
    const { stdout } = await run(adb, ['-s', udid, 'shell', 'ps', '-A', '-o', 'PID,ARGS'], {
      timeoutMs: 5_000,
    });
    const pids = stdout
      .split('\n')
      .filter((line) => line.includes('com.genymobile.scrcpy.Server'))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((pid): pid is string => Boolean(pid && /^\d+$/.test(pid)));
    for (const pid of pids) {
      await run(adb, ['-s', udid, 'shell', 'kill', pid], { timeoutMs: 3_000 }).catch(() => {
        // best-effort — already gone is fine
      });
    }
  } catch {
    // `ps` failing (e.g. device briefly unreachable) just means we skip this cycle's
    // cleanup — the next launch attempt tries again.
  }
}

async function pushServer(adb: string, udid: string): Promise<void> {
  const jarPath = path.join(__dirname, SERVER_JAR_NAME);
  await run(adb, ['-s', udid, 'push', jarPath, DEVICE_JAR_PATH], { timeoutMs: 15_000 });
}

/** `adb forward tcp:0 <remote>` picks a free local port and prints it to stdout. */
async function forwardPort(adb: string, udid: string): Promise<{ port: number; remove: () => Promise<void> }> {
  const { stdout } = await run(adb, ['-s', udid, 'forward', 'tcp:0', `localabstract:${LOCAL_SOCKET_NAME}`], {
    timeoutMs: 10_000,
  });
  const port = Number(stdout.trim());
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`adb forward did not return a port (got ${JSON.stringify(stdout)})`);
  }
  return {
    port,
    remove: async () => {
      try {
        await run(adb, ['-s', udid, 'forward', '--remove', `tcp:${port}`], { timeoutMs: 5_000 });
      } catch {
        // best-effort — the adb server cleans up stale forwards on its own too
      }
    },
  };
}

/** Launch the server on-device. Kept alive as a tracked child process so we can kill it on teardown. */
function launchServer(
  adb: string,
  udid: string,
  args: string[],
  onLog: (line: string) => void,
): ChildProcessByStdio<null, Readable, Readable> {
  const command = `CLASSPATH=${DEVICE_JAR_PATH} nohup app_process / com.genymobile.scrcpy.Server ${[SERVER_VERSION, ...args].join(' ')}`;
  const proc = spawn(adb, ['-s', udid, 'shell', command], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;
  proc.stdout.on('data', (d) => {
    const text = d.toString().trim();
    if (text) onLog(`scrcpy-server: ${text}`);
  });
  proc.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text) onLog(`scrcpy-server: ${text}`);
  });
  return proc;
}

// After a local TCP connect succeeds, wait this long watching for an immediate close/reset
// before trusting the connection -- see the big comment on `connectWithRetry` for why.
const CONNECT_GRACE_MS = 250;

/**
 * Connect to the forwarded port, retrying while the on-device `LocalServerSocket` isn't up yet.
 *
 * Verified live against a real device: a local TCP `connect` succeeding does NOT mean the
 * on-device `LocalServerSocket` was actually there to accept it. `adb forward`'s host-side
 * proxy accepts the local TCP connection first, then relays an `open:localabstract:scrcpy`
 * request to the device -- if nothing is listening there yet (the java process is still
 * starting: JVM boot, class loading, `Connection`'s constructor work all happen before
 * `DesktopConnection` ever reaches `new LocalServerSocket(...)`), adb resets the local
 * connection almost immediately afterward. A naive "resolve on 'connect'" here produces a
 * socket that looks connected but silently closes moments later with zero bytes ever
 * exchanged -- which is exactly what an early version of this function did in practice.
 * So: after 'connect', wait {@link CONNECT_GRACE_MS} watching for an immediate close/error
 * before trusting the socket; if one fires, that's a failed attempt like any other refusal.
 */
function connectWithRetry(port: number, deadline: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const retryOrGiveUp = (socket: net.Socket) => {
      socket.destroy();
      if (signal.aborted) return; // onAbort already rejected
      if (Date.now() >= deadline) {
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`could not connect to forwarded scrcpy port ${port}`));
        return;
      }
      timer = setTimeout(attempt, CONNECT_RETRY_INTERVAL_MS);
    };

    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const onPreConnectError = () => retryOrGiveUp(socket);
      socket.once('error', onPreConnectError);
      socket.once('connect', () => {
        socket.off('error', onPreConnectError);

        // Grace window: confirm the remote side didn't immediately drop us.
        let settled = false;
        const graceTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          socket.off('close', onEarlyClose);
          socket.off('error', onEarlyError);
          signal.removeEventListener('abort', onAbort);
          resolve(socket);
        }, CONNECT_GRACE_MS);
        const onEarlyClose = () => {
          if (settled) return;
          settled = true;
          clearTimeout(graceTimer);
          retryOrGiveUp(socket);
        };
        const onEarlyError = onEarlyClose;
        socket.once('close', onEarlyClose);
        socket.once('error', onEarlyError);
      });
    };
    attempt();
  });
}

/** Open the backend stream WS. Rejects on any pre-open failure; the caller's loop retries. */
function connectRelayWs(apiUrl: string, token: string, sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = `${apiUrl.replace(/^http/, 'ws')}/relay/agent/stream?token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, handshakeTimeout: 15_000 });
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // already gone
      }
    }, 20_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${err.message}`));
    });
  });
}

/** One capture cycle: push+launch scrcpy, open both sockets, pump the video socket to the relay WS. */
async function captureOnce(options: Required<ScrcpyAgentOptions>, signal: AbortSignal): Promise<void> {
  const { adbPath, udid, onLog } = options;

  await killStaleServer(adbPath, udid);
  await pushServer(adbPath, udid);
  const forward = await forwardPort(adbPath, udid);
  const args = buildServerArgs(options);
  const serverProc = launchServer(adbPath, udid, args, onLog);

  let videoSocket: net.Socket | null = null;
  let controlSocket: net.Socket | null = null;
  let ws: WebSocket | null = null;

  const cleanup = async () => {
    try {
      videoSocket?.destroy();
    } catch {
      /* already closed */
    }
    try {
      controlSocket?.destroy();
    } catch {
      /* already closed */
    }
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    try {
      serverProc.kill();
    } catch {
      /* already dead */
    }
    await forward.remove();
  };

  try {
    if (signal.aborted) return;
    ws = await connectRelayWs(options.apiUrl, options.token, options.sessionId);
    const deadline = Date.now() + CONNECT_RETRY_TIMEOUT_MS;
    // Order matters: the server accepts video first, then control (Connection.java).
    videoSocket = await connectWithRetry(forward.port, deadline, signal);
    controlSocket = await connectWithRetry(forward.port, deadline, signal);
    onLog(`scrcpy connected (session ${options.sessionId}, device ${udid})`);

    let bytes = 0;
    let windowBytes = 0;
    const throughputTimer = setInterval(() => {
      onLog(`pumped ${(windowBytes / 1024).toFixed(0)} KB/s (${(bytes / 1024 / 1024).toFixed(2)} MB total)`);
      windowBytes = 0;
    }, 1000);

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (why: string) => {
        if (done) return;
        done = true;
        clearInterval(throughputTimer);
        signal.removeEventListener('abort', onAbort);
        onLog(why);
        resolve();
      };
      const onAbort = () => finish('scrcpy agent stopped');
      signal.addEventListener('abort', onAbort, { once: true });
      videoSocket!.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        windowBytes += chunk.length;
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(chunk);
          } catch {
            /* dropped frame — next chunk will still arrive, or the socket will error out below */
          }
        }
      });
      videoSocket!.once('close', () => finish('scrcpy video socket closed — restarting'));
      videoSocket!.once('error', (err: Error) => finish(`scrcpy video socket error: ${err.message} — restarting`));
      controlSocket!.once('close', () => finish('scrcpy control socket closed — restarting'));
      serverProc.once('exit', () => finish('scrcpy-server exited — restarting'));
      ws!.on('close', () => finish('stream ws closed — restarting'));
      ws!.on('error', () => {
        /* surfaced via 'close' too */
      });
    });
  } finally {
    await cleanup();
  }
}

/**
 * Start the scrcpy capture agent for a session. Self-healing: if the device socket, the
 * on-device server, or the relay WS drops, the whole cycle (push/launch/connect) restarts with
 * exponential backoff — mirrors the old script's reconnect loop, minus the periodic-restart
 * logic `screenrecord`'s time limit forced (scrcpy has no such cap).
 */
export function startScrcpyAgent(options: ScrcpyAgentOptions): ScrcpyAgent {
  const resolved: Required<ScrcpyAgentOptions> = {
    apiUrl: options.apiUrl,
    token: options.token,
    sessionId: options.sessionId,
    udid: options.udid,
    bitrate: options.bitrate ?? 6_000_000,
    maxSize: options.maxSize ?? 1024,
    maxFps: options.maxFps ?? 0,
    adbPath: resolveAdbPath(options.adbPath),
    onLog: options.onLog ?? (() => {}),
  };

  const controller = new AbortController();

  void (async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        await captureOnce(resolved, controller.signal);
        attempt = 0;
      } catch (err) {
        resolved.onLog(`scrcpy agent error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!controller.signal.aborted) {
        const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
        attempt += 1;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  })();

  return {
    stop: () => {
      controller.abort();
    },
  };
}
