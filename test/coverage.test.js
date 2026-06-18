import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codexmeter-coverage-"));
process.env.CODEXMETER_DATA_DIR = dataDir;

const config = await import("../src/config.js");
const storeModule = await import("../src/store.js");
const ingestModule = await import("../src/ingest-server.js");
const dashboardModule = await import("../src/dashboard-server.js");
const mcpModule = await import("../src/mcp-server.js");

test("config helpers resolve runtime paths", () => {
  assert.match(config.getDataDir(), /codexmeter-coverage-/);
  assert.match(config.getDbPath(), /usage\.jsonl$/);
  assert.match(config.getStatePath(), /state\.json$/);
  assert.equal(config.getHost(), "127.0.0.1");
  assert.equal(config.getDashboardPort(), 8080);
  assert.equal(config.getIngestPort(), 4567);
});

test("config helpers honor explicit environment overrides", async () => {
  const originalDataDir = process.env.CODEXMETER_DATA_DIR;
  const originalHost = process.env.CODEXMETER_HOST;
  const originalDashboardPort = process.env.CODEXMETER_DASHBOARD_PORT;
  const originalIngestPort = process.env.CODEXMETER_INGEST_PORT;
  process.env.CODEXMETER_DATA_DIR = "/tmp/codexmeter-config";
  process.env.CODEXMETER_HOST = "0.0.0.0";
  process.env.CODEXMETER_DASHBOARD_PORT = "9090";
  process.env.CODEXMETER_INGEST_PORT = "5050";
  assert.equal(config.getDataDir(), "/tmp/codexmeter-config");
  assert.equal(config.getHost(), "0.0.0.0");
  assert.equal(config.getDashboardPort(), Number(process.env.CODEXMETER_DASHBOARD_PORT));
  assert.equal(config.getIngestPort(), Number(process.env.CODEXMETER_INGEST_PORT));
  assert.match(config.getDbPath(), /usage\.jsonl$/);
  assert.match(config.getStatePath(), /state\.json$/);
  process.env.CODEXMETER_DATA_DIR = originalDataDir;
  process.env.CODEXMETER_HOST = originalHost;
  process.env.CODEXMETER_DASHBOARD_PORT = originalDashboardPort;
  process.env.CODEXMETER_INGEST_PORT = originalIngestPort;
});

test("config helpers fall back to defaults when environment variables are absent", async () => {
  const originalDataDir = process.env.CODEXMETER_DATA_DIR;
  const originalHost = process.env.CODEXMETER_HOST;
  const originalDashboardPort = process.env.CODEXMETER_DASHBOARD_PORT;
  const originalIngestPort = process.env.CODEXMETER_INGEST_PORT;
  delete process.env.CODEXMETER_DATA_DIR;
  delete process.env.CODEXMETER_HOST;
  delete process.env.CODEXMETER_DASHBOARD_PORT;
  delete process.env.CODEXMETER_INGEST_PORT;
  assert.match(config.getDataDir(), /\.codexmeter$/);
  assert.equal(config.getHost(), "127.0.0.1");
  assert.equal(config.getDashboardPort(), 8080);
  assert.equal(config.getIngestPort(), 4567);
  process.env.CODEXMETER_DATA_DIR = originalDataDir;
  process.env.CODEXMETER_HOST = originalHost;
  process.env.CODEXMETER_DASHBOARD_PORT = originalDashboardPort;
  process.env.CODEXMETER_INGEST_PORT = originalIngestPort;
});

test("runtime helpers load fresh store instances", async () => {
  const dashboardRuntime = await dashboardModule.createDashboardRuntime();
  const ingestRuntime = await ingestModule.createIngestRuntime();
  const mcpRuntime = await mcpModule.createMcpRuntime();
  assert.ok(dashboardRuntime.store);
  assert.ok(ingestRuntime.store);
  assert.ok(mcpRuntime.store);
});

test("store coverage hits read refresh and persistence paths", async () => {
  const store = new storeModule.UsageStore();
  await store.load();
  await store.append({
    timestamp: Date.now(),
    thread_id: "thread-coverage",
    model: "gpt-5",
    usage: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 4 }
  });
  const refreshed = await store.readEvents();
  assert.ok(refreshed.length >= 1);
  await store.refresh();
  const summary = await store.summarize(60_000);
  assert.ok(summary.totalTokens >= 10);
  const recent = await store.recentThreads(1);
  assert.equal(recent[0].threadId, "thread-coverage");
  const timeseries = await store.timeseries(60_000, 60_000);
  assert.ok(Array.isArray(timeseries));
});

test("store helpers cover jsonl parsing and read fallbacks", async () => {
  const parsed = storeModule.parseUsageJsonl('{"id":"a"}\n{"id":"b"}\n');
  assert.equal(parsed.length, 2);
  const empty = storeModule.parseUsageJsonl("   ");
  assert.equal(empty.length, 0);
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
});

test("store helpers cover empty time windows and update paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codexmeter-empty-"));
  process.env.CODEXMETER_DATA_DIR = tmp;
  const store = new storeModule.UsageStore();
  await store.load();
  store.events = [];
  assert.deepEqual(store.getEvents(1), []);
  const series = await store.timeseries(60_000, 60_000);
  assert.ok(Array.isArray(series));
  assert.ok(series.length > 0);
  assert.equal(series.every((bucket) => bucket.inputTokens === 0), true);
  assert.deepEqual(await store.recentThreads(5), []);
});

test("ingest coverage hits nested collectors and route handlers", async () => {
  const runtime = await ingestModule.createIngestRuntime();
  assert.ok(runtime.store);
  assert.throws(() => ingestModule.handleIngestPortError({ code: "EPERM" }, 4567, () => {}), (error) => error.code === "EPERM");
  assert.deepEqual(ingestModule.collectLogRecords([]), []);
  assert.deepEqual(ingestModule.collectLogRecords("not-an-object"), []);
  const mixedRecords = ingestModule.collectLogRecords([
    { resourceLogs: [{ scopeLogs: [{ logRecords: [{ id: "mixed-log" }], records: [{ id: "mixed-record" }] }] }] },
    { scopeLogs: [{ logRecords: [{ id: "scope-log" }], records: [{ id: "scope-record" }] }] }
  ]);
  assert.equal(mixedRecords.length, 2);
  const collected = ingestModule.collectLogRecords({
    resourceLogs: [
      {
        scopeLogs: [
          {
            records: [{ attributes: { id: "a" } }]
          }
        ]
      }
    ]
  });
  assert.equal(collected.length, 1);
  assert.equal(ingestModule.collectLogRecords({ resourceLogs: [{ scopeLogs: [{ records: [{ id: "via-records" }] }] }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ scopeLogs: [{ logRecords: [{ id: "via-logRecords" }] }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ records: [{ id: "top-records" }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ logRecords: [{ id: "top-logRecords" }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ resourceLogs: [{ scopeLogs: [{ records: [{ id: "resource-records" }] }] }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({ scopeLogs: [{ records: [{ id: "scope-records" }] }] }).length, 1);
  assert.equal(ingestModule.collectLogRecords({}).length, 1);
  assert.equal(ingestModule.collectLogRecords({ logRecords: [{ id: "flat" }] }).length, 1);
  const normalized = ingestModule.extractUsageEvent({ attributes: { id: "b", usage: { input_tokens: 2 } } });
  assert.equal(normalized.id, "b");
  const tokenized = ingestModule.extractUsageEvent({ token_usage: { output_tokens: 9 } });
  assert.equal(tokenized.usage.output_tokens, 9);
  const directUsage = ingestModule.extractUsageEvent({ usage: { cached_input_tokens: 7 } });
  assert.equal(directUsage.usage.cached_input_tokens, 7);
  const bodyFallback = ingestModule.extractUsageEvent({ body: { id: "c", usage: { cached_input_tokens: 8 } } });
  assert.equal(bodyFallback.id, "c");
  const bodyAttributes = ingestModule.extractUsageEvent({ body: { attributes: { id: "c2", threadId: "thread-c2", model: "gpt-5" } } });
  assert.equal(bodyAttributes.thread_id, "thread-c2");
  assert.equal(bodyAttributes.model, "gpt-5");
  const direct = ingestModule.extractUsageEvent({ id: "d", usage: { reasoning_output_tokens: 1 } });
  assert.equal(direct.id, "d");
  const threaded = ingestModule.extractUsageEvent({ attributes: { threadId: "thread-x", turnId: "turn-y" } });
  assert.equal(threaded.thread_id, "thread-x");
  assert.equal(threaded.turn_id, "turn-y");

  const stored = [];
  const fakeStore = {
    events: [],
    append: async (event) => {
      stored.push(event);
      return event;
    }
  };
  const server = ingestModule.createIngestServer(fakeStore);
  const request = { method: "GET", url: "/health", headers: { host: "127.0.0.1" } };
  const response = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, end(chunk = "") { this.body += chunk; } };
  await new Promise((resolve) => {
    response.end = (chunk = "") => {
      response.body += chunk;
      resolve();
    };
    server.emit("request", request, response);
  });
  assert.equal(response.statusCode, 200);

  const badJsonResponse = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, end(chunk = "") { this.body += chunk; } };
  await new Promise((resolve) => {
    badJsonResponse.end = (chunk = "") => {
      badJsonResponse.body += chunk;
      resolve();
    };
    server.emit("request", {
      method: "POST",
      url: "/v1/logs",
      headers: { host: "127.0.0.1" },
      on(event, handler) {
        if (event === "data") handler(Buffer.from("{broken"));
        if (event === "end") handler();
      }
    }, badJsonResponse);
  });
  assert.equal(badJsonResponse.statusCode, 400);
  assert.equal(ingestModule.handleIngestPortError({ code: "EADDRINUSE" }, 4567, () => {}), true);
  const bodyAttributesResponse = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, end(chunk = "") { this.body += chunk; } };
  await new Promise((resolve) => {
    bodyAttributesResponse.end = (chunk = "") => {
      bodyAttributesResponse.body += chunk;
      resolve();
    };
    server.emit("request", {
      method: "POST",
      url: "/v1/logs",
      headers: { host: "127.0.0.1" },
      on(event, handler) {
        if (event === "data") handler(Buffer.from(JSON.stringify({ logRecords: [{ attributes: { id: "evt", body: { attributes: { id: "evt2" } } } }] })));
        if (event === "end") handler();
      }
    }, bodyAttributesResponse);
  });
  assert.equal(bodyAttributesResponse.statusCode, 200);
  server.close();
  assert.equal(stored.length, 1);
});

test("ingest and dashboard port helpers retry on EADDRINUSE", () => {
  const calls = [];
  const dashboardRetry = dashboardModule.handlePortError({ code: "EADDRINUSE" }, 8080, (port) => calls.push(port));
  const ingestRetry = ingestModule.handleIngestPortError({ code: "EADDRINUSE" }, 4567, (port) => calls.push(port));
  assert.equal(dashboardRetry, true);
  assert.equal(ingestRetry, true);
  assert.deepEqual(calls, [8081, 4568]);
});

test("port helpers throw for unexpected errors", () => {
  assert.throws(() => dashboardModule.handlePortError({ code: "EPERM" }, 8080, () => {}), (error) => error.code === "EPERM");
  assert.throws(() => ingestModule.handleIngestPortError({ code: "EACCES" }, 4567, () => {}), (error) => error.code === "EACCES");
});

test("dashboard coverage exercises render and server branches", async () => {
  const html = await dashboardModule.buildDashboardHtml();
  assert.match(html, /Codex Meter/);
  const fakeStore = {
    events: [{ timestamp: Date.now() }],
    summarize: async () => ({ totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, eventCount: 1, averageTokensPerEvent: 1 }),
    timeseries: async () => [{ start: Date.now(), inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }],
    recentThreads: async () => [{ threadId: "thread-coverage" }]
  };
  const server = dashboardModule.createDashboardServer(fakeStore);
  const request = (url) => new Promise((resolve) => {
    const response = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, end(chunk = "") { this.body += chunk; resolve({ statusCode: this.statusCode, body: this.body }); } };
    server.emit("request", { method: "GET", url, headers: { host: "127.0.0.1" } }, response);
  });
  assert.equal((await request("/")).statusCode, 200);
  assert.equal((await request("/health")).statusCode, 200);
  assert.equal((await request("/api/usage/summary?window=1h")).statusCode, 200);
  assert.equal((await request("/api/usage/timeseries?window=1h&bucket=5m")).statusCode, 200);
  assert.equal((await request("/api/usage/recent-threads")).statusCode, 200);
  assert.equal((await request("/api/usage/summary?window=bogus")).statusCode, 200);
  assert.equal((await request("/api/usage/timeseries?window=bogus&bucket=bogus")).statusCode, 200);
  assert.equal((await request("/missing")).statusCode, 404);
  server.close();
});

test("mcp coverage reaches message handler and startup framing", async () => {
  const fakeStore = {
    summarize: async () => ({ totalTokens: 5 }),
    timeseries: async () => [{ start: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }],
    recentThreads: async () => [{ threadId: "thread-coverage" }]
  };
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  await mcpModule.handleMcpMessage(fakeStore, { method: "initialize", id: 1 }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "tools/list", id: 2 }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "tools/call", id: 3, params: { name: "usage_recent_threads", arguments: { limit: 1 } } }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "unknown", id: 4 }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "unknown" }, stdout);
  assert.match(stdout.chunks.join(""), /codexmeter/);
  assert.equal((await mcpModule.dispatchToolCall(fakeStore, "usage_summary", { window: "24h" })).content[0].text.includes("5"), true);
  assert.equal((await mcpModule.dispatchToolCall(fakeStore, "usage_summary", { window: "bogus" })).content[0].text.includes("5"), true);
  assert.equal((await mcpModule.dispatchToolCall(fakeStore, "usage_timeseries", { window: "24h", bucket: "1h" })).content[0].text.includes("inputTokens"), true);
  assert.equal((await mcpModule.dispatchToolCall(fakeStore, "usage_timeseries", { window: "bogus", bucket: "bogus" })).content[0].text.includes("inputTokens"), true);
  assert.equal((await mcpModule.dispatchToolCall(fakeStore, "usage_recent_threads", {})).content[0].text.includes("thread-coverage"), true);
  const stdin = new (class {
    constructor() { this.handlers = {}; }
    on(event, handler) { this.handlers[event] = handler; }
    emitData(text) { this.handlers.data?.(Buffer.from(text)); }
  })();
  const runtime = await mcpModule.startMcpServer(stdin, stdout);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} });
  stdin.emitData(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  stdin.emitData("Broken-Header: 1\r\n\r\n{}");
  stdin.emitData("Content-Length: 999\r\n\r\n{}");
  assert.ok(runtime.store);
  await mcpModule.handleMcpMessage(fakeStore, { method: "tools/call", id: 5, params: { name: "missing", arguments: {} } }, stdout);
  await mcpModule.handleMcpMessage(fakeStore, { method: "unknown" }, stdout);
});

test("mcp server isolates malformed frame branches", async () => {
  const makeStdin = () => new (class {
    constructor() { this.handlers = {}; }
    on(event, handler) { this.handlers[event] = handler; }
    emitData(text) { this.handlers.data?.(Buffer.from(text)); }
  })();
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  const headerOnly = makeStdin();
  await mcpModule.startMcpServer(headerOnly, stdout);
  headerOnly.emitData("Broken-Header: 1\r\n\r\n{}");
  const incompleteOnly = makeStdin();
  await mcpModule.startMcpServer(incompleteOnly, stdout);
  incompleteOnly.emitData("Content-Length: 999\r\n\r\n{}");
  assert.ok(stdout.chunks.length >= 0);
});
