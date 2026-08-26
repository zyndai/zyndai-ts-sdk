import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const LOCK_FILE = path.join(
  process.env["ZYND_HOME"] ?? path.join(os.homedir(), ".zynd"),
  "bridge.lock"
);

let lockAcquired = false;

export function acquireLock(): void {
  if (fs.existsSync(LOCK_FILE)) {
    const existing = fs.readFileSync(LOCK_FILE, "utf8").trim();
    const existingPid = parseInt(existing, 10);

    // Check if the PID that wrote the lock is still running
    if (!isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0); // signal 0 = existence check only
        throw new Error(
          `ERR_DAEMON_LOCK_HELD: bridge daemon already running (PID ${existingPid}). Use "zynd bridge stop" to stop it.`
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          // Process doesn't exist — stale lockfile, remove it
          fs.unlinkSync(LOCK_FILE);
        } else {
          throw err;
        }
      }
    }
  }

  const dir = path.dirname(LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
  lockAcquired = true;
}

export function releaseLock(): void {
  if (!lockAcquired) return;
  try {
    fs.unlinkSync(LOCK_FILE);
    lockAcquired = false;
  } catch {
    // Already removed — fine
  }
}

export function registerShutdownHandlers(onShutdown?: () => void | Promise<void>): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[bridge] Received ${signal} — shutting down...`);
    try {
      await onShutdown?.();
    } finally {
      releaseLock();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("exit", () => { releaseLock(); });
}

export function isDaemonRunning(): boolean {
  if (!fs.existsSync(LOCK_FILE)) return false;

  const raw = fs.readFileSync(LOCK_FILE, "utf8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getDaemonPid(): number | null {
  if (!fs.existsSync(LOCK_FILE)) return null;
  const raw = fs.readFileSync(LOCK_FILE, "utf8").trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}
