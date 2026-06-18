import { getDashboardPort, getHost } from "./config.js";
import { createDashboardRuntime, createDashboardServer, handlePortError } from "./dashboard-server.js";

export async function startDashboardMain(options = {}) {
  const runtime = options.runtime || (await createDashboardRuntime());
  const server = options.server || createDashboardServer(runtime.store);
  const bindHost = options.host || getHost();
  let currentPort = options.port || getDashboardPort();

  function listen(port) {
    currentPort = port;
    server.listen(port, bindHost, () => {
      console.log(`Dashboard listening on http://${bindHost}:${port}`);
    });
  }

  server.on("error", (error) => handlePortError(error, currentPort, listen));
  listen(currentPort);
  return { server, port: currentPort };
}
