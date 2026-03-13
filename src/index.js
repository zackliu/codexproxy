import { DefaultAzureCredential } from "@azure/identity";
import { loadConfig } from "./config.js";
import { TokenManager } from "./auth.js";
import { createProxyServer } from "./proxy.js";

const config = loadConfig();

const logger = {
  info(meta, message) {
    console.log(JSON.stringify({ level: "info", message, ...meta }));
  },
  error(meta, message) {
    console.error(JSON.stringify({ level: "error", message, ...meta }));
  }
};

const credential = new DefaultAzureCredential();
const tokenManager = new TokenManager({
  credential,
  scope: config.scope,
  refreshBufferMs: config.tokenRefreshBufferMs,
  logger
});

const server = createProxyServer({ config, tokenManager, logger });

server.listen(config.listenPort, config.listenHost, () => {
  logger.info(
    {
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      upstreamBaseUrl: config.upstreamBaseUrl,
      scope: config.scope
    },
    "Codex proxy listening"
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    logger.info({ signal }, "Received shutdown signal");
    server.close(() => {
      logger.info({}, "Server closed");
      process.exit(0);
    });
  });
}
