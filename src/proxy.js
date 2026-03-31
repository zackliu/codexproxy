import http from "node:http";
import { URL } from "node:url";
import { request as undiciRequest } from "undici";
import { CredentialUnavailableError } from "./auth.js";

function normalizeUpstreamHeaders(incomingHeaders, token) {
  const headers = { ...incomingHeaders };
  delete headers.host;
  delete headers.authorization;
  delete headers["api-key"];
  headers.authorization = `Bearer ${token}`;
  return headers;
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function createProxyServer({ config, tokenManager, logger = console, requestImpl = undiciRequest }) {
  return http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        writeJson(res, 400, { error: "bad_request", message: "Missing request URL" });
        return;
      }

      if (req.url === "/healthz") {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (req.url === "/readyz") {
        const readiness = await tokenManager.checkReady();
        writeJson(res, 200, readiness);
        return;
      }

      if (!req.url.startsWith("/openai/v1/")) {
        writeJson(res, 404, { error: "not_found", message: "Route not found" });
        return;
      }

      const token = await tokenManager.getAccessToken();
      const upstreamUrl = new URL(req.url, `${config.upstreamBaseUrl}/`);

      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const upstream = await requestImpl(upstreamUrl, {
        method: req.method,
        headers: normalizeUpstreamHeaders(req.headers, token),
        body: hasBody ? req : undefined,
        headersTimeout: config.upstreamHeadersTimeoutMs,
        bodyTimeout: config.upstreamBodyTimeoutMs
      });

      res.statusCode = upstream.statusCode;
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (value !== undefined) {
          res.setHeader(key, value);
        }
      }

      if (upstream.body) {
        for await (const chunk of upstream.body) {
          res.write(chunk);
        }
      }
      res.end();

      logger.info?.({ method: req.method, path: req.url, statusCode: upstream.statusCode }, "Upstream request completed");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (res.headersSent || res.writableEnded) {
        logger.error?.(
          { method: req.method, path: req.url, error: errorMessage },
          "Proxy request failed after response started"
        );

        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }

      if (error instanceof CredentialUnavailableError) {
        writeJson(res, 503, {
          error: error.code,
          message: error.message
        });
        return;
      }

      logger.error?.({ method: req.method, path: req.url, error: errorMessage }, "Proxy request failed");
      writeJson(res, 502, {
        error: "proxy_error",
        message: errorMessage
      });
    }
  });
}
