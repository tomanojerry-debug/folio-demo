import { mkdir, writeFile, readdir, unlink, rmdir, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const busy = () => Object.assign(new Error("这份本地资料正在由另一个Folio服务使用，请等它退出后重试。"), { code: "DATA_DIRECTORY_LOCKED" });
const backoff = () => new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 20)));
function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// mkdir is the interprocess exclusion primitive. Each owner has a unique filename:
// a stale contender can never unlink the replacement owner's token. rmdir only
// succeeds on an empty directory, so publishing a new owner is also protected.
export async function acquireDataLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockDirectory = path.join(directory, "service.lock");
  const ownerName = `owner-${process.pid}-${randomUUID()}.json`;
  const ownerPath = path.join(lockDirectory, ownerName);
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      try {
        await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token: ownerName, createdAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
        const published = await readdir(lockDirectory);
        // If an empty, abandoned directory was reclaimed while this process
        // was paused before publishing, another owner may now occupy its path.
        // Never start writing state unless our token is the only published one.
        if (published.length !== 1 || published[0] !== ownerName) throw busy();
      } catch (error) {
        // A process that died before publishing its owner can leave an empty
        // directory. If a reclaimer removed ours before publication, try again.
        if (error.code === "ENOENT") continue;
        await unlink(ownerPath).catch(() => {});
        await rmdir(lockDirectory).catch(() => {});
        // macOS can report EINVAL from open() if another stale-lock reclaimer
        // replaced this directory during publication. Our unique token is
        // already cleaned up; re-enter the same bounded ownership check.
        if (error.code === "DATA_DIRECTORY_LOCKED" || (error.code === "EINVAL" && error.syscall === "open")) { await backoff(); continue; }
        throw error;
      }
      let released = false;
      return {
        path: lockDirectory,
        async release() {
          if (released) return;
          try { await unlink(ownerPath); }
          catch (error) {
            if (error.code === "ENOENT") { released = true; return; }
            throw error;
          }
          await rmdir(lockDirectory).catch((error) => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
          released = true;
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let entries;
    try { entries = await readdir(lockDirectory); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!entries.length) {
      const info = await stat(lockDirectory).catch((error) => { if (error.code !== "ENOENT") throw error; });
      if (!info) continue;
      if (Date.now() - info.mtimeMs < 5000) { await backoff(); continue; }
      await rmdir(lockDirectory).catch((error) => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
      continue;
    }
    if (entries.length !== 1) throw busy();
    const owner = /^owner-([1-9]\d*)-[a-f\d-]+\.json$/.exec(entries[0]);
    if (!owner || !Number.isSafeInteger(Number(owner[1])) || processExists(Number(owner[1]))) throw busy();
    try { await unlink(path.join(lockDirectory, entries[0])); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await rmdir(lockDirectory).catch((error) => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
  }
  throw busy();
}
