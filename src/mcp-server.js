import { UsageStore } from "./store.js";

const tools = [
  {
    name: "usage_summary",
    description: "Return token usage summary for a rolling window.",
    inputSchema: {
      type: "object",
      properties: { window: { type: "string", enum: ["1m", "1h", "24h"] } },
      required: ["window"]
    }
  },
  {
    name: "usage_timeseries",
    description: "Return token usage timeseries for a rolling window.",
    inputSchema: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["1h", "24h"] },
        bucket: { type: "string", enum: ["1m", "5m", "1h"] }
      },
      required: ["window", "bucket"]
    }
  },
  {
    name: "usage_recent_threads",
    description: "Return recently active thread identifiers.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 100 } }
    }
  }
];

export function listTools() {
  return tools;
}

export async function dispatchToolCall(storeInstance, name, args = {}) {
  if (name === "usage_summary") {
    const windowMs = { "1m": 60_000, "1h": 3_600_000, "24h": 86_400_000 }[args.window] ?? 3_600_000;
    return { content: [{ type: "text", text: JSON.stringify(await storeInstance.summarize(windowMs), null, 2) }] };
  }
  if (name === "usage_timeseries") {
    const bucketMs = args.bucket === "1h" ? 3_600_000 : args.bucket === "5m" ? 300_000 : 60_000;
    const windowMs = args.window === "24h" ? 86_400_000 : args.window === "1m" ? 60_000 : 3_600_000;
    return { content: [{ type: "text", text: JSON.stringify(await storeInstance.timeseries(windowMs, bucketMs), null, 2) }] };
  }
  if (name === "usage_recent_threads") {
    const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 10;
    return { content: [{ type: "text", text: JSON.stringify(await storeInstance.recentThreads(limit), null, 2) }] };
  }
  return { error: { code: -32601, message: "Method not found" } };
}

function encodeMessage(message) {
  const payload = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
}

function reply(stdout, id, result) {
  stdout.write(encodeMessage({ jsonrpc: "2.0", id, result }));
}

export async function handleMcpMessage(storeInstance, message, stdout = process.stdout) {
  if (message.method === "initialize") {
    reply(stdout, message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "codexmeter", version: "0.1.0" }
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(stdout, message.id, { tools: listTools() });
    return;
  }
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params || {};
    const result = await dispatchToolCall(storeInstance, name, args);
    if (result.error) {
      reply(stdout, message.id, { error: result.error });
      return;
    }
    reply(stdout, message.id, result);
    return;
  }
  if (message.id != null) {
    reply(stdout, message.id, { error: { code: -32601, message: "Method not found" } });
  }
}

export async function createMcpRuntime() {
  const store = new UsageStore();
  await store.load();
  return { store };
}

export async function startMcpServer(stdin = process.stdin, stdout = process.stdout) {
  const { store } = await createMcpRuntime();
  let buffer = "";
  function consumeBuffer() {
    while (buffer.length > 0) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.slice(start, start + length);
      buffer = buffer.slice(start + length);
      handleMcpMessage(store, JSON.parse(body), stdout);
    }
  }
  stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    consumeBuffer();
  });
  return { store };
}
