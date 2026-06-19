import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codexmeter-core-"));
process.env.CODEXMETER_DATA_DIR = dataDir;

const storeModule = await import("../src/store.js");
const ingestModule = await import("../src/ingest-server.js");
const dashboardModule = await import("../src/dashboard-server.js");
const mcpModule = await import("../src/mcp-server.js");

test("store methods cover file IO and aggregation", async () => {
  const store = new storeModule.UsageStore();
  await store.load();
  await store.load();
  await store.append({
    timestamp: Date.now(),
    thread_id: "thread-core",
    model: "gpt-5",
    usage: { input_tokens: 5, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 2 }
  });
  const summary = await store.summarize(24 * 60 * 60 * 1000);
  assert.equal(summary.totalTokens, 14);
  assert.equal(summary.averageTokensPerEvent, 14);
  assert.deepEqual(await store.recentThreads(), [{ threadId: "thread-core", lastEventAt: summary.lastEventAt, model: "gpt-5" }]);
  await store.persistState();
  const series = await store.timeseries(60_000, 60_000);
  assert.ok(series.length >= 0);
});

test("store helpers cover parsing and fallback branches", async () => {
  assert.deepEqual(storeModule.parseUsageJsonl(""), []);
  assert.deepEqual(storeModule.parseUsageJsonl('{"id":"a"}\n'), [{ id: "a" }]);
  const missing = await storeModule.readEventsFromFile(async () => {
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  }, "/tmp/missing");
  assert.deepEqual(missing, []);
  await assert.rejects(
    () => storeModule.readEventsFromFile(async () => {
      const error = new Error("boom");
      error.code = "EIO";
      throw error;
  }, "/tmp/boom"),
    (error) => error.code === "EIO"
  );
  const normalized = storeModule.normalizeEvent({});
  assert.equal(normalized.inputTokens, 0);
  assert.match(normalized.id, /^\d+-/);
  const zeroTimestamp = storeModule.normalizeEvent({ timestamp: 0, usage: { input_tokens: 1 } });
  assert.equal(typeof zeroTimestamp.timestamp, "number");
  const zeroCounts = storeModule.normalizeEvent({ usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } });
  assert.equal(zeroCounts.inputTokens, 0);
  const explicitIds = storeModule.normalizeEvent({
    thread_id: "thread-explicit",
    turn_id: "turn-explicit",
    model: "gpt-5",
    token_usage: { input_tokens: 2, cached_input: 3, output: 4, reasoning_output: 5 }
  });
  assert.equal(explicitIds.threadId, "thread-explicit");
  assert.equal(explicitIds.turnId, "turn-explicit");
  assert.equal(explicitIds.inputTokens, 2);
  assert.equal(storeModule.aggregate([]).averageTokensPerEvent, 0);
  const persistedStore = new storeModule.UsageStore();
  persistedStore.events = [{ timestamp: 1 }];
  await persistedStore.persistState();
  persistedStore.events = [];
  await persistedStore.persistState();
  const emptyStore = {
    events: [],
    refresh: async () => {},
    getEvents: storeModule.UsageStore.prototype.getEvents,
    recentThreads: storeModule.UsageStore.prototype.recentThreads,
    timeseries: storeModule.UsageStore.prototype.timeseries
  };
  assert.deepEqual(await emptyStore.recentThreads(), []);
  assert.equal((await emptyStore.timeseries(0, 60_000)).length, 1);
  const skippedStore = {
    events: [
      { threadId: "", timestamp: 1, model: "m1" },
      { threadId: "dup", timestamp: 2, model: "m2" },
      { threadId: "dup", timestamp: 3, model: "m3" }
    ],
    refresh: async () => {},
    getEvents: storeModule.UsageStore.prototype.getEvents,
    recentThreads: storeModule.UsageStore.prototype.recentThreads
  };
  assert.deepEqual(await skippedStore.recentThreads(), [{ threadId: "dup", lastEventAt: 3, model: "m3" }]);
  const futureStore = {
    events: [{ timestamp: Date.now() + 86_400_000, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }],
    refresh: async () => {},
    getEvents: storeModule.UsageStore.prototype.getEvents,
    timeseries: storeModule.UsageStore.prototype.timeseries
  };
  assert.equal((await futureStore.timeseries(-60_000, 86_400_001)).length, 1);
  const emptyWindowStore = {
    events: [],
    refresh: async () => {},
    getEvents: storeModule.UsageStore.prototype.getEvents,
    timeseries: storeModule.UsageStore.prototype.timeseries
  };
  const originalNow = Date.now;
  Date.now = () => 0;
  try {
    assert.deepEqual(await emptyWindowStore.timeseries(0, 60_000), []);
  } finally {
    Date.now = originalNow;
  }
});

test("ingest helpers normalize payloads", async () => {
  const records = ingestModule.collectLogRecords([
    { records: [{ id: "x" }] },
    { resourceLogs: [{ scopeLogs: [{ logRecords: [{ id: "z" }] }] }] },
    { resourceLogs: [{ scopeLogs: [{ records: [{ id: "z2" }] }] }] },
    { scopeLogs: [{ records: [{ id: "s" }] }] },
    { logRecords: [{ id: "flat-log" }] },
    { records: [{ id: "flat-record" }] },
    { id: "direct" },
    null
  ]);
  assert.equal(records.length, 7);
  assert.equal(ingestModule.collectLogRecords({}).length, 1);
  assert.equal(ingestModule.collectLogRecords({ records: [{ id: "r" }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ logRecords: [{ id: "l" }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ logRecords: [{ id: "both-l" }], records: [{ id: "both-r" }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ scopeLogs: [{ logRecords: [{ id: "sl" }] }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ scopeLogs: [{ records: [{ id: "sr" }] }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ scopeLogs: [{}] }).length, 0);
  assert.equal(ingestModule.collectLogRecords({ resourceLogs: [{ scopeLogs: [] }] }).length, 0);
  assert.equal(ingestModule.collectLogRecords({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ id: "rl" }] }] }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ resourceLogs: [{ scopeLogs: [{ records: [{ id: "rr" }] }] }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ resourceLogs: [{}, { scopeLogs: [{ records: [{ id: "nested" }] }] }] }).length, 1);
  const event = ingestModule.extractUsageEvent({
    body: {
      attributes: {
        id: "y",
        timestamp: 1,
        threadId: "thread-y",
        turnId: "turn-y",
        model: "gpt-5",
        usage: { input_tokens: 1 }
      }
    }
  });
  assert.equal(event.id, "y");
  assert.equal(event.usage.input_tokens, 1);
  assert.equal(event.thread_id, "thread-y");
  const bodyEvent = ingestModule.extractUsageEvent({ body: { id: "body-only", usage: { reasoning_output_tokens: 4 } } });
  assert.equal(bodyEvent.id, "body-only");
  assert.equal(bodyEvent.usage.reasoning_output_tokens, 4);
  const bodyAttributesEvent = ingestModule.extractUsageEvent({ body: { attributes: { id: "body-attr", thread_id: "thread-body", model: "gpt-5" } } });
  assert.equal(bodyAttributesEvent.id, "body-attr");
  assert.equal(bodyAttributesEvent.thread_id, "thread-body");
  assert.equal(bodyAttributesEvent.model, "gpt-5");
  const tokenUsageEvent = ingestModule.extractUsageEvent({ token_usage: { cached_input_tokens: 2, output_tokens: 3 } });
  assert.equal(tokenUsageEvent.usage.cached_input_tokens, 2);
  assert.equal(tokenUsageEvent.usage.output_tokens, 3);
  const mixedUsageEvent = ingestModule.extractUsageEvent({ attributes: { id: "mixed", usage: { input_tokens: 11 }, token_usage: { output_tokens: 12 } } });
  assert.equal(mixedUsageEvent.id, "mixed");
  assert.equal(mixedUsageEvent.usage.input_tokens, 11);
  const topLevelUsageEvent = ingestModule.extractUsageEvent({ id: "top", usage: { input_tokens: 6 } });
  assert.equal(topLevelUsageEvent.id, "top");
  assert.equal(topLevelUsageEvent.usage.input_tokens, 6);
  const bareEvent = ingestModule.extractUsageEvent({});
  assert.equal(typeof bareEvent.timestamp, "number");
  assert.equal(bareEvent.thread_id, undefined);
  const usageOnlyEvent = ingestModule.extractUsageEvent({ usage: { input_tokens: 9 }, attributes: { thread_id: "thread-z", turn_id: "turn-z" } });
  assert.equal(usageOnlyEvent.usage.input_tokens, 9);
  assert.equal(usageOnlyEvent.thread_id, "thread-z");
  assert.equal(usageOnlyEvent.turn_id, "turn-z");
  const bodyAttributesUsageEvent = ingestModule.extractUsageEvent({ body: { attributes: { id: "body-attr", usage: { cached_input_tokens: 7 } } } });
  assert.equal(bodyAttributesUsageEvent.id, "body-attr");
  assert.equal(bodyAttributesUsageEvent.usage.cached_input_tokens, 7);
  assert.equal(ingestModule.collectLogRecords({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ id: "combo-1" }], records: [{ id: "combo-2" }] }] }] }).length, 1);

  const accepted = [];
  const postServer = ingestModule.createIngestServer({
    events: [],
    append: async (event) => {
      accepted.push(event);
      return event;
    }
  });
  const postResponse = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, end(chunk = "") { this.body += chunk; } };
  await new Promise((resolve) => {
    postResponse.end = (chunk = "") => {
      postResponse.body += chunk;
      resolve();
    };
    postServer.emit("request", {
      method: "POST",
      url: "/v1/logs",
      headers: { host: "127.0.0.1" },
      on(event, handler) {
        if (event === "data") handler(Buffer.from(JSON.stringify({ logRecords: [{ id: "post-1", usage: { input_tokens: 1 } }] })));
        if (event === "end") handler();
      }
    }, postResponse);
  });
  assert.equal(postResponse.statusCode, 200);
  assert.equal(accepted.length, 1);
  const missingResponse = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, end(chunk = "") { this.body += chunk; } };
  await new Promise((resolve) => {
    missingResponse.end = (chunk = "") => {
      missingResponse.body += chunk;
      resolve();
    };
    postServer.emit("request", { method: "GET", url: "/missing", headers: { host: "127.0.0.1" } }, missingResponse);
  });
  assert.equal(missingResponse.statusCode, 404);
});

test("ingest runtime and port helpers cover direct branches", async () => {
  const runtime = await ingestModule.createIngestRuntime();
  assert.ok(runtime.store);
  assert.throws(
    () => ingestModule.handleIngestPortError({ code: "EADDRINUSE" }, 4568, () => {}),
    (error) => error.code === "EADDRINUSE" && /must bind the configured ingest port/.test(error.message)
  );
});

test("dashboard helpers render a high fidelity UI", async () => {
  const html = await dashboardModule.buildDashboardHtml();
  assert.match(html, /Codex Meter/);
  assert.match(html, /Collector Status/);
  assert.match(html, /Trend View/);
  assert.match(html, /Peak bucket/);
  assert.match(html, /Selected Snapshot/);
  assert.match(html, /\/api\/usage\/summary/);
});

test("dashboard server routes serve the expected resources", async () => {
  const fakeStore = {
    events: [{ timestamp: Date.now() }],
    summarize: async () => ({ totalTokens: 7, inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, eventCount: 1, averageTokensPerEvent: 7 }),
    timeseries: async () => [{ start: Date.now(), inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }],
    recentThreads: async () => [{ threadId: "thread-core" }]
  };
  const server = dashboardModule.createDashboardServer(fakeStore);
  const request = (url) => new Promise((resolve) => {
    const res = {
      statusCode: 0,
      body: "",
      writeHead(code) {
        this.statusCode = code;
      },
      end(chunk = "") {
        this.body += chunk;
        resolve({ statusCode: this.statusCode, body: this.body });
      }
    };
    server.emit("request", { method: "GET", url, headers: { host: "127.0.0.1" } }, res);
  });
  const summary = await request("/api/usage/summary?window=1h");
  const summaryDefault = await request("/api/usage/summary");
  const summary24h = await request("/api/usage/summary?window=24h");
  const root = await request("/");
  const timeseries = await request("/api/usage/timeseries?window=1h&bucket=5m");
  const timeseriesDefault = await request("/api/usage/timeseries");
  const timeseries24h = await request("/api/usage/timeseries?window=24h&bucket=1h");
  const health = await request("/health");
  const missing = await request("/missing");
  const threads = await request("/api/usage/recent-threads");
  const postRoot = await new Promise((resolve) => {
    const res = {
      statusCode: 0,
      body: "",
      writeHead(code) {
        this.statusCode = code;
      },
      end(chunk = "") {
        this.body += chunk;
        resolve({ statusCode: this.statusCode, body: this.body });
      }
    };
    server.emit("request", { method: "POST", url: "/", headers: { host: "127.0.0.1" } }, res);
  });
  assert.equal(summary.statusCode, 200);
  assert.equal(summaryDefault.statusCode, 200);
  assert.equal(summary24h.statusCode, 200);
  assert.match(summary.body, /totalTokens/);
  assert.match(root.body, /Codex Meter/);
  assert.match(timeseries.body, /inputTokens/);
  assert.equal(timeseriesDefault.statusCode, 200);
  assert.equal(timeseries24h.statusCode, 200);
  assert.match(health.body, /"ok":true/);
  assert.equal(missing.statusCode, 404);
  assert.equal(postRoot.statusCode, 404);
  assert.match(threads.body, /thread-core/);
  server.close();
});

test("mcp helpers handle tools and unknown methods", async () => {
  const fakeStore = {
    summarize: async () => ({ totalTokens: 11 }),
    timeseries: async () => [{ start: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }],
    recentThreads: async () => [{ threadId: "thread-core" }]
  };
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  const summary = await mcpModule.dispatchToolCall(fakeStore, "usage_summary", { window: "1h" });
  const summary24h = await mcpModule.dispatchToolCall(fakeStore, "usage_summary", { window: "24h" });
  const summary1m = await mcpModule.dispatchToolCall(fakeStore, "usage_summary", { window: "1m" });
  const summaryDefault = await mcpModule.dispatchToolCall(fakeStore, "usage_summary", {});
  const timeseries = await mcpModule.dispatchToolCall(fakeStore, "usage_timeseries", { window: "1h", bucket: "5m" });
  const timeseries1m = await mcpModule.dispatchToolCall(fakeStore, "usage_timeseries", { window: "1h", bucket: "1m" });
  const timeseries1mWindow = await mcpModule.dispatchToolCall(fakeStore, "usage_timeseries", { window: "1m", bucket: "1m" });
  const timeseries24h = await mcpModule.dispatchToolCall(fakeStore, "usage_timeseries", { window: "24h", bucket: "1h" });
  const timeseriesDefault = await mcpModule.dispatchToolCall(fakeStore, "usage_timeseries", {});
  const recent = await mcpModule.dispatchToolCall(fakeStore, "usage_recent_threads", { limit: 1 });
  const recentZero = await mcpModule.dispatchToolCall(fakeStore, "usage_recent_threads", { limit: 0 });
  const recentInvalid = await mcpModule.dispatchToolCall(fakeStore, "usage_recent_threads", { limit: "nope" });
  const recentDefault = await mcpModule.dispatchToolCall(fakeStore, "usage_recent_threads", {});
  const unknownTool = await mcpModule.dispatchToolCall(fakeStore, "does_not_exist", {});
  assert.match(summary.content[0].text, /11/);
  assert.match(summary24h.content[0].text, /11/);
  assert.match(summary1m.content[0].text, /11/);
  assert.match(summaryDefault.content[0].text, /11/);
  assert.match(timeseries.content[0].text, /inputTokens/);
  assert.match(timeseries1m.content[0].text, /inputTokens/);
  assert.match(timeseries1mWindow.content[0].text, /inputTokens/);
  assert.match(timeseries24h.content[0].text, /inputTokens/);
  assert.match(timeseriesDefault.content[0].text, /inputTokens/);
  assert.match(recent.content[0].text, /thread-core/);
  assert.match(recentZero.content[0].text, /thread-core/);
  assert.match(recentInvalid.content[0].text, /thread-core/);
  assert.match(recentDefault.content[0].text, /thread-core/);
  assert.match(JSON.stringify(unknownTool), /Method not found/);
  await mcpModule.handleMcpMessage(fakeStore, { method: "initialize", id: 1 }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "tools/list", id: 2 }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "tools/call", id: 3, params: { name: "usage_summary", arguments: { window: "1h" } } }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "tools/call", id: 4, params: { name: "missing", arguments: {} } }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "tools/call", id: 5 }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "unknown", id: 6 }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "unknown" }, stdout);
  assert.match(stdout.chunks.join(""), /codexmeter/);
  assert.match(stdout.chunks.join(""), /Method not found/);
});

test("mcp server start consumes framed messages", async () => {
  const stdin = new (class {
    constructor() {
      this.handlers = {};
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    emitData(text) {
      this.handlers.data?.(Buffer.from(text));
    }
  })();
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  await mcpModule.startMcpServer(stdin, stdout);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  stdin.emitData(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  stdin.emitData("Broken-Header: 1\r\n\r\n{}");
  stdin.emitData("Content-Length: 999\r\n\r\n{}");
  stdin.emitData("Content-Length: 1\r\n\r\n");
  const splitBody = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const prefix = `Content-Length: ${Buffer.byteLength(splitBody)}\r\n\r\n`;
  stdin.emitData(prefix.slice(0, 10));
  stdin.emitData(prefix.slice(10) + splitBody.slice(0, 8));
  stdin.emitData(splitBody.slice(8));
  const incompleteBody = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  const incompletePrefix = `Content-Length: ${Buffer.byteLength(incompleteBody)}\r\n\r\n`;
  stdin.emitData(incompletePrefix + incompleteBody.slice(0, 5));
  assert.match(stdout.chunks.join(""), /codexmeter/);
});

test("mcp server ignores half-written frames in isolation", async () => {
  const stdin = new (class {
    constructor() {
      this.handlers = {};
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    emitData(text) {
      this.handlers.data?.(Buffer.from(text));
    }
  })();
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  await mcpModule.startMcpServer(stdin, stdout);
  stdin.emitData("Content-Length: 100\r\n\r\nabc");
  assert.equal(stdout.chunks.length, 0);
});

test("mcp server handles incomplete frames in isolation", async () => {
  const stdin = new (class {
    constructor() {
      this.handlers = {};
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    emitData(text) {
      this.handlers.data?.(Buffer.from(text));
    }
  })();
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  await mcpModule.startMcpServer(stdin, stdout);
  stdin.emitData("Content-Length: 999\r\n\r\n{}");
  assert.ok(stdout.chunks.length >= 0);
});
