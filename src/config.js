const DEFAULTS = {
  LISTEN_HOST: "127.0.0.1",
  LISTEN_PORT: "17777",
  UPSTREAM_AOAI_BASE_URL: "https://pmagent2.openai.azure.com/openai/v1",
  AZURE_OPENAI_SCOPE: "https://cognitiveservices.azure.com/.default",
  TOKEN_REFRESH_BUFFER_MS: String(5 * 60 * 1000),
  UPSTREAM_HEADERS_TIMEOUT_MS: String(30 * 1000),
  UPSTREAM_BODY_TIMEOUT_MS: String(10 * 60 * 1000)
};

function parsePositiveInt(env, name, fallback) {
  const raw = env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const listenHost = env.LISTEN_HOST ?? DEFAULTS.LISTEN_HOST;
  const listenPort = parsePositiveInt(env, "LISTEN_PORT", DEFAULTS.LISTEN_PORT);

  const upstreamBaseUrl = env.UPSTREAM_AOAI_BASE_URL ?? DEFAULTS.UPSTREAM_AOAI_BASE_URL;
  if (!/^https?:\/\//.test(upstreamBaseUrl)) {
    throw new Error(`UPSTREAM_AOAI_BASE_URL must be an absolute URL, got: ${upstreamBaseUrl}`);
  }

  const scope = env.AZURE_OPENAI_SCOPE ?? DEFAULTS.AZURE_OPENAI_SCOPE;
  const tokenRefreshBufferMs = parsePositiveInt(env, "TOKEN_REFRESH_BUFFER_MS", DEFAULTS.TOKEN_REFRESH_BUFFER_MS);
  const upstreamHeadersTimeoutMs = parsePositiveInt(env, "UPSTREAM_HEADERS_TIMEOUT_MS", DEFAULTS.UPSTREAM_HEADERS_TIMEOUT_MS);
  const upstreamBodyTimeoutMs = parsePositiveInt(env, "UPSTREAM_BODY_TIMEOUT_MS", DEFAULTS.UPSTREAM_BODY_TIMEOUT_MS);

  return {
    listenHost,
    listenPort,
    upstreamBaseUrl,
    scope,
    tokenRefreshBufferMs,
    upstreamHeadersTimeoutMs,
    upstreamBodyTimeoutMs
  };
}
