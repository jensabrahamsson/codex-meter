import { startMcpServer } from "./mcp-server.js";

export async function startMcpMain() {
  return startMcpServer();
}

if (process.argv[1] && process.argv[1].endsWith("mcp-main.js")) {
  await startMcpMain();
}
