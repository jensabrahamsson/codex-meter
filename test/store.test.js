import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const now = () => Date.now();
const storeModule = await import("../src/store.js");
const ingestModule = await import("../src/ingest-server.js");
const dashboardModule = await import("../src/dashboard-server.js");
const mcpModule = await import("../src/mcp-server.js");

test("aggregate sums token fields", async () => {
  const { aggregate } = storeModule;
  const summary = aggregate([
    { timestamp: 1, inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 4 },
    { timestamp: 2, inputTokens: 10, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 40 }
  ]);
  assert.equal(summary.totalTokens, 110);
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.lastEventAt, 2);
  assert.equal(summary.averageTokensPerEvent, 55);
});

test("normalizeEvent clamps invalid counts and preserves metadata", async () => {
  const { normalizeEvent } = storeModule;
  const event = normalizeEvent({
    timestamp: 123,
    thread_id: "thread-1",
    turnId: "turn-9",
    model: "gpt-5",
    usage: { input_tokens: -1, cached_input_tokens: "4", output_tokens: 6.2, reasoning_output_tokens: "bad" }
  });
  assert.equal(event.timestamp, 123);
  assert.equal(event.threadId, "thread-1");
  assert.equal(event.turnId, "turn-9");
  assert.equal(event.model, "gpt-5");
  assert.equal(event.inputTokens, 0);
  assert.equal(event.cachedInputTokens, 4);
  assert.equal(event.outputTokens, 6);
  assert.equal(event.reasoningOutputTokens, 0);
});

test("normalizeEvent supports token_usage fallback and missing metadata", async () => {
  const { normalizeEvent } = storeModule;
  const event = normalizeEvent({
    token_usage: { input: 1, cached_input: 2, output: 3, reasoning_output: 4 }
  });
  assert.equal(event.inputTokens, 1);
  assert.equal(event.cachedInputTokens, 2);
  assert.equal(event.outputTokens, 3);
  assert.equal(event.reasoningOutputTokens, 4);
  assert.equal(event.threadId, null);
  assert.equal(event.turnId, null);
  assert.equal(event.model, null);
});

test("normalizeEvent falls back to defaults when usage data is absent", async () => {
  const { normalizeEvent } = storeModule;
  const event = normalizeEvent({});
  assert.equal(typeof event.id, "string");
  assert.equal(typeof event.timestamp, "number");
  assert.equal(event.inputTokens, 0);
  assert.equal(event.cachedInputTokens, 0);
  assert.equal(event.outputTokens, 0);
  assert.equal(event.reasoningOutputTokens, 0);
});

test("store loads, appends, persists, and summarizes events", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codexmeter-"));
  process.env.CODEXMETER_DATA_DIR = tmp;
  const { UsageStore } = storeModule;
  const store = new UsageStore();
  await store.load();
  await store.load();
  const first = await store.append({
    timestamp: now(),
    thread_id: "thread-a",
    model: "gpt-5",
    usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 4 }
  });
  assert.equal(first.inputTokens, 2);
  const summary = await store.summarize(24 * 60 * 60 * 1000);
  assert.equal(summary.totalTokens, 10);
  assert.equal(summary.eventCount, 1);
  const recent = await store.recentThreads();
  assert.deepEqual(recent, [{ threadId: "thread-a", lastEventAt: first.timestamp, model: "gpt-5" }]);
  const series = await store.timeseries(60_000, 60_000);
  assert.ok(Array.isArray(series));
  const state = JSON.parse(await fs.readFile(path.join(tmp, "state.json"), "utf8"));
  assert.equal(state.totalEvents, 1);
  const contents = await fs.readFile(path.join(tmp, "usage.jsonl"), "utf8");
  assert.match(contents, /thread-a/);
});

test("aggregate handles empty inputs", async () => {
  const { aggregate } = storeModule;
  const summary = aggregate([]);
  assert.equal(summary.eventCount, 0);
  assert.equal(summary.totalTokens, 0);
  assert.equal(summary.lastEventAt, null);
  assert.equal(summary.averageTokensPerEvent, 0);
});

test("recentThreads deduplicates thread ids and skips empty ids", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codexmeter-"));
  process.env.CODEXMETER_DATA_DIR = tmp;
  const { UsageStore } = storeModule;
  const store = {
    events: [
      { threadId: "dup", timestamp: 1, model: "m1", inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      { threadId: null, timestamp: 2, model: "m2", inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      { threadId: "dup", timestamp: 3, model: "m3", inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
    ],
    refresh: async () => {},
    recentThreads: UsageStore.prototype.recentThreads
  };
  const recent = await store.recentThreads(10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].threadId, "dup");
  assert.equal(recent[0].lastEventAt, 3);
});

test("timeseries returns empty buckets for zero windows", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codexmeter-"));
  process.env.CODEXMETER_DATA_DIR = tmp;
  const { UsageStore } = storeModule;
  const store = new UsageStore();
  await store.load();
  const series = await store.timeseries(0, 60_000);
  assert.equal(Array.isArray(series), true);
  assert.equal(series.length, 1);
  assert.equal(series[0].inputTokens, 0);
});

test("collectLogRecords and extractUsageEvent normalize OTel payloads", async () => {
  const { collectLogRecords, extractUsageEvent } = ingestModule;
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: {
                  id: "evt-1",
                  timestamp: 123,
                  thread_id: "thread-7",
                  model: "gpt-5",
                  usage: { input_tokens: 2, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 7 }
                }
              }
            ]
          }
        ]
      }
    ]
  };
  const records = collectLogRecords(payload);
  assert.equal(records.length, 1);
  const normalized = extractUsageEvent(records[0]);
  assert.equal(normalized.id, "evt-1");
  assert.equal(normalized.thread_id, "thread-7");
  assert.equal(normalized.usage.output_tokens, 5);
});

test("dashboard html includes Codex Meter and local endpoints", async () => {
  const { buildDashboardHtml } = dashboardModule;
  const html = await buildDashboardHtml();
  assert.match(html, /Codex Meter/);
  assert.match(html, /127\.0\.0\.1:8080/);
  assert.match(html, /\/api\/usage\/summary/);
});

test("dashboard server routes return usage data", async () => {
  const { createDashboardServer } = dashboardModule;
  const fakeStore = {
    events: [{ timestamp: 1 }],
    summarize: async (windowMs) => ({ windowMs, totalTokens: 42, inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 4, eventCount: 1, averageTokensPerEvent: 42 }),
    timeseries: async () => [{ start: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }],
    recentThreads: async () => [{ threadId: "thread-x" }]
  };
  const server = createDashboardServer(fakeStore);
  const request = async (pathName) => {
    const req = { method: "GET", url: pathName, headers: { host: "127.0.0.1" } };
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(chunk = "") {
        this.body += chunk;
      }
    };
    await server.emit("request", req, res);
    return res;
  };
  const summary = await request("/api/usage/summary?window=1h");
  assert.equal(summary.statusCode, 200);
  assert.match(summary.body, /totalTokens/);
  const health = await request("/health");
  assert.match(health.body, /"ok":true/);
  server.close();
});

test("ingest server routes accept telemetry payloads", async () => {
  const { createIngestServer } = ingestModule;
  const stored = [];
  const fakeStore = {
    events: [],
    append: async (event) => {
      stored.push(event);
      return event;
    }
  };
  const server = createIngestServer(fakeStore);
  const req = { method: "POST", url: "/v1/logs", headers: { host: "127.0.0.1" }, on(event, handler) {
    if (event === "data") handler(Buffer.from(JSON.stringify({
      logRecords: [
        {
          attributes: {
            id: "evt-2",
            timestamp: now(),
            thread_id: "thread-y",
            usage: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 4 }
          }
        }
      ]
    })));
    if (event === "end") handler();
  } };
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    }
  };
  await server.emit("request", req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].thread_id, "thread-y");

  const missingRes = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, end(chunk = "") { this.body += chunk; } };
  await new Promise((resolve) => {
    missingRes.end = (chunk = "") => {
      missingRes.body += chunk;
      resolve();
    };
    server.emit("request", { method: "GET", url: "/missing", headers: { host: "127.0.0.1" } }, missingRes);
  });
  assert.equal(missingRes.statusCode, 404);
  server.close();
});

test("mcp tool dispatch returns structured text results", async () => {
  const { dispatchToolCall, listTools, handleMcpMessage } = mcpModule;
  assert.ok(Array.isArray(listTools()));
  const fakeStore = {
    summarize: async () => ({ totalTokens: 99 }),
    timeseries: async () => [{ start: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }],
    recentThreads: async () => [{ threadId: "thread-1" }]
  };
  const result = await dispatchToolCall(fakeStore, "usage_summary", { window: "1h" });
  assert.match(result.content[0].text, /99/);
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  await handleMcpMessage(fakeStore, { method: "tools/list", id: 1 }, stdout);
  assert.match(stdout.chunks.join(""), /usage_summary/);
});
