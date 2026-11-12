import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
// Single Worker process owns this ledger. Writes serialize and finish before replying.
export async function createLedger(root) {
  const file = path.join(root, "ledger.json");
  let entries = {};
  try { entries = JSON.parse(await readFile(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  let chain = Promise.resolve();
  return function command(args) {
    const run = chain.then(async () => {
      const next = structuredClone(entries);
      const now = Date.now();
      for (const [key, entry] of Object.entries(next)) if (entry.exp < now) delete next[key];
      const [op] = args;
      const key = op === "EVAL" ? args[3] : args[1];
      if (typeof key !== "string" || !/^forme:[\w:-]{1,200}$/.test(key)) throw new Error("INVALID_KEY");
      let result;
      if (op === "GET") result = next[key]?.value ?? null;
      else if (op === "DEL") { result = next[key] ? 1 : 0; delete next[key]; }
      else if (op === "SET") {
        const nx = args.includes("NX"), ttl = Number(args[args.indexOf("EX") + 1]);
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > 172800 || typeof args[2] !== "string" || args[2].length > 1_000_000) throw new Error("INVALID_VALUE");
        if (nx && next[key]) result = null;
        else { next[key] = { value: args[2], exp: now + ttl * 1000 }; result = "OK"; }
      } else if (op === "EVAL") {
        // Interpret only the quota operation; never execute caller-supplied code.
        const cost = Number(args[4]), limit = Number(args[5]), ttl = Number(args[6]);
        if (![cost, limit, ttl].every(Number.isInteger) || cost < 1 || limit < 1 || ttl < 1 || ttl > 172800) throw new Error("INVALID_QUOTA");
        const count = Number(next[key]?.value || 0);
        result = count + cost <= limit ? 1 : 0;
        if (result) next[key] = { value: String(count + cost), exp: now + ttl * 1000 };
      } else throw new Error("INVALID_COMMAND");
      if (op !== "GET") {
        await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
        await rename(`${file}.tmp`, file); entries = next;
      }
      return result;
    });
    chain = run.catch(() => {});
    return run;
  };
}
