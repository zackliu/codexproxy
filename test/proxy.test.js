import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProxyServer } from "../src/proxy.js";
import { CredentialUnavailableError } from "../src/auth.js";

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const address = server.address();
      resolve(address);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

function requestAndCaptureClose(url, onData = () => {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      let aborted = false;
      let ended = false;
      let error = null;

      res.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        onData();
      });

      res.on("aborted", () => {
        aborted = true;
      });

      res.on("end", () => {
        ended = true;
      });
      res.on("error", (responseError) => {
        error = responseError;
      });
      res.on("close", () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
          aborted,
          ended,
          error,
          complete: res.complete
        });
      });
    });

    req.on("error", reject);
  });
}

function createTestProxy({ config = {}, ...options } = {}) {
  return createProxyServer({
    config: {
      upstreamBaseUrl: "http://127.0.0.1:1/openai/v1",
      upstreamHeadersTimeoutMs: 5_000,
      upstreamBodyTimeoutMs: 5_000,
      ...config
    },
    tokenManager: {
      async getAccessToken() {
        return "token";
      },
      async checkReady() {
        return { ok: true };
      }
    },
    logger: { info() {}, error() {} },
    ...options
  });
}

test("proxy forwards request with bearer token and strips api-key", async () => {
  let captured = null;

  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    captured = {
      url: req.url,
      authorization: req.headers.authorization,
      apiKey: req.headers["api-key"],
      body
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  const upstreamAddr = await listen(upstream);

  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddr.port}/openai/v1`,
      upstreamHeadersTimeoutMs: 5_000,
      upstreamBodyTimeoutMs: 5_000
    },
    tokenManager: {
      async getAccessToken() {
        return "token-from-proxy";
      },
      async checkReady() {
        return { ok: true };
      }
    },
    logger: { info() {}, error() {} }
  });

  const proxyAddr = await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxyAddr.port}/openai/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer user-token",
      "api-key": "secret"
    },
    body: JSON.stringify({ model: "gpt-5.4", input: "ping" })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  assert.equal(captured.url, "/openai/v1/responses");
  assert.equal(captured.authorization, "Bearer token-from-proxy");
  assert.equal(captured.apiKey, undefined);
  assert.match(captured.body, /\"model\":\"gpt-5.4\"/);

  await close(proxy);
  await close(upstream);
});

test("readiness endpoints return expected statuses", async () => {
  const proxy = createProxyServer({
    config: {
      upstreamBaseUrl: "http://127.0.0.1:1/openai/v1",
      upstreamHeadersTimeoutMs: 5_000,
      upstreamBodyTimeoutMs: 5_000
    },
    tokenManager: {
      async getAccessToken() {
        return "token";
      },
      async checkReady() {
        return { ok: true, hasToken: true };
      }
    },
    logger: { info() {}, error() {} }
  });

  const proxyAddr = await listen(proxy);

  const health = await fetch(`http://127.0.0.1:${proxyAddr.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const ready = await fetch(`http://127.0.0.1:${proxyAddr.port}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, hasToken: true });

  const miss = await fetch(`http://127.0.0.1:${proxyAddr.port}/unknown`);
  assert.equal(miss.status, 404);

  await close(proxy);
});

test("upstream disconnect aborts the downstream HTTP response instead of completing it", { timeout: 10_000 }, async (t) => {
  const loggerErrors = [];
  const firstEvent = 'event: response.output_text.delta\ndata: {"delta":"partial response"}\n\n';
  let upstreamResponse;

  const upstream = http.createServer((req, res) => {
    upstreamResponse = res;
    res.setHeader("content-type", "text/event-stream");
    res.write(firstEvent);
  });
  t.after(() => close(upstream));
  const upstreamAddr = await listen(upstream);

  const proxy = createTestProxy({
    config: {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddr.port}/openai/v1`
    },
    logger: {
      info() {},
      error(meta, message) {
        loggerErrors.push({ meta, message });
      }
    }
  });
  t.after(() => close(proxy));
  const proxyAddr = await listen(proxy);

  const partial = await requestAndCaptureClose(
    `http://127.0.0.1:${proxyAddr.port}/openai/v1/responses`,
    () => upstreamResponse.destroy()
  );
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.body, firstEvent);
  assert.equal(partial.complete, false);
  assert.equal(partial.aborted, true);
  assert.equal(partial.ended, false);
  assert.equal(partial.error?.code, "ECONNRESET");

  const health = await fetch(`http://127.0.0.1:${proxyAddr.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  assert.equal(loggerErrors.length, 1);
  assert.equal(loggerErrors[0].message, "Proxy request failed after response started");
  assert.match(loggerErrors[0].meta.error, /other side closed/);
});

test("upstream body timeout rejects a fetch stream reader", { timeout: 10_000 }, async (t) => {
  const firstEvent = 'data: {"type":"response.in_progress"}\n\n';
  const loggerErrors = [];
  const upstream = http.createServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write(firstEvent);
  });
  t.after(() => close(upstream));
  const upstreamAddr = await listen(upstream);

  const proxy = createTestProxy({
    config: {
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddr.port}/openai/v1`,
      upstreamBodyTimeoutMs: 100
    },
    logger: {
      info() {},
      error(meta, message) {
        loggerErrors.push({ meta, message });
      }
    }
  });
  t.after(() => close(proxy));
  const proxyAddr = await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxyAddr.port}/openai/v1/responses`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(new TextDecoder().decode(first.value), firstEvent);
  await assert.rejects(reader.read(), { name: "TypeError", message: "terminated" });
  assert.equal(loggerErrors.length, 1);
  assert.equal(loggerErrors[0].meta.error, "Body Timeout Error");
});

for (const failureStage of ["request", "body-before-first-chunk"]) {
  test(`upstream ${failureStage} failure returns a complete 502 JSON response`, { timeout: 10_000 }, async (t) => {
    const loggerErrors = [];
    const proxy = createTestProxy({
      logger: {
        info() {},
        error(meta, message) {
          loggerErrors.push({ meta, message });
        }
      },
      async requestImpl() {
        if (failureStage === "request") {
          throw new Error("upstream unavailable");
        }
        return {
          statusCode: 200,
          headers: {
            "content-type": "text/event-stream",
            "content-length": "9999",
            "content-encoding": "gzip"
          },
          body: (async function* () {
            throw new Error("upstream unavailable");
          })()
        };
      }
    });
    t.after(() => close(proxy));
    const proxyAddr = await listen(proxy);

    const response = await fetch(`http://127.0.0.1:${proxyAddr.port}/openai/v1/responses`);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("content-encoding"), null);
    assert.deepEqual(await response.json(), {
      error: "proxy_error",
      message: "upstream unavailable"
    });
    assert.equal(loggerErrors.length, 1);
  });
}

test("credential failure remains a complete 503 JSON response", async (t) => {
  const proxy = createTestProxy({
    tokenManager: {
      async getAccessToken() {
        throw new CredentialUnavailableError("credential unavailable");
      }
    }
  });
  t.after(() => close(proxy));
  const proxyAddr = await listen(proxy);
  const response = await fetch(`http://127.0.0.1:${proxyAddr.port}/openai/v1/responses`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "credential_unavailable",
    message: "credential unavailable"
  });
});

test("complete upstream HTTP errors preserve status, headers and body", async (t) => {
  const body = JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Try later" } });
  const proxy = createTestProxy({
    async requestImpl() {
      return {
        statusCode: 429,
        headers: { "content-type": "application/json", "retry-after": "5" },
        body: (async function* () {
          yield body;
        })()
      };
    }
  });
  t.after(() => close(proxy));
  const proxyAddr = await listen(proxy);
  const response = await fetch(`http://127.0.0.1:${proxyAddr.port}/openai/v1/responses`);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(await response.text(), body);
});

for (const eventType of ["response.completed", "response.failed"]) {
  test(`complete SSE ${eventType} events pass through unchanged`, async (t) => {
    const body = `event: ${eventType}\ndata: ${JSON.stringify({ type: eventType })}\n\n`;
    const proxy = createTestProxy({
      async requestImpl() {
        return {
          statusCode: 200,
          headers: { "content-type": "text/event-stream" },
          body: (async function* () {
            yield body;
          })()
        };
      }
    });
    t.after(() => close(proxy));
    const proxyAddr = await listen(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyAddr.port}/openai/v1/responses`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), body);
  });
}
