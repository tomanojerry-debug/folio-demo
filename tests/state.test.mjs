import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLedger } from "../worker/state.mjs";
import { claim } from "../server/idempotency.mjs";
test("persistent quotas cannot be exceeded by concurrent calls and survive restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forme-state-"));
  try {
    const db = await createLedger(root);
    const results = await Promise.all(Array.from({ length: 20 }, () => db(["EVAL", "quota", "1", "forme:test:quota", "1", "5", "120"])));
    assert.equal(results.filter(Boolean).length, 5);
    const restarted = await createLedger(root);
    assert.equal(await restarted(["GET", "forme:test:quota"]), "5");
    const claimed = await Promise.all(Array.from({ length: 5 }, () => restarted(["SET", "forme:test:request", "pending", "NX", "EX", "120"])));
    assert.equal(claimed.filter(Boolean).length, 1);
    await assert.rejects(restarted(["FLUSHALL", "forme:test:anything"]), /INVALID_COMMAND/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("duplicate requests reuse the prior result instead of billing a second model call", async () => {
  const body = { requestId: "idempotent-request-123456", content: "source text" };
  const first = await claim("visitor", "ingest", body);
  await assert.rejects(claim("visitor", "ingest", body), /REQUEST_RUNNING/);
  await first.complete({ collection: { id: "saved" } });
  assert.deepEqual((await claim("visitor", "ingest", body)).cached, { collection: { id: "saved" } });
  await assert.rejects(claim("visitor", "ingest", { ...body, content: "changed" }), /INVALID_REQUEST/);
});
