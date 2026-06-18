import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("aggregate sums token fields", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codexmeter-"));
  process.env.CODEXMETER_DATA_DIR = tmp;
  const { aggregate } = await import(`../src/store.js?ts=${Date.now()}`);
  const summary = aggregate([
    { timestamp: 1, inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 4 },
    { timestamp: 2, inputTokens: 10, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 40 }
  ]);
  assert.equal(summary.totalTokens, 110);
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.lastEventAt, 2);
});

test("timeseries handles empty windows", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codexmeter-"));
  process.env.CODEXMETER_DATA_DIR = tmp;
  const { UsageStore } = await import(`../src/store.js?ts=${Date.now()}-empty`);
  const store = new UsageStore();
  await store.load();
  const series = await store.timeseries(60_000, 60_000);
  assert.ok(Array.isArray(series));
});
