import { getHost, getIngestPort } from "./config.js";
import { createIngestRuntime, createIngestServer, handleIngestPortError } from "./ingest-server.js";

export async function startIngestMain(options = {}) {
  const runtime = options.runtime || (await createIngestRuntime());
  const server = options.server || createIngestServer(runtime.store);
  const bindHost = options.host || getHost();
  let currentPort = options.port || getIngestPort();

  function listen(port) {
    currentPort = port;
    server.listen(port, bindHost, () => {
      console.log(`Ingest server listening on http://${bindHost}:${port}`);
    });
  }

  server.on("error", (error) => handleIngestPortError(error, currentPort, listen));
  listen(currentPort);
  return { server, port: currentPort };
}
