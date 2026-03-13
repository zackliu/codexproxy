export class CredentialUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "CredentialUnavailableError";
    this.code = "credential_unavailable";
    this.cause = cause;
  }
}

export class TokenManager {
  constructor({ credential, scope, refreshBufferMs = 5 * 60 * 1000, now = () => Date.now(), logger = console }) {
    this.credential = credential;
    this.scope = scope;
    this.refreshBufferMs = refreshBufferMs;
    this.now = now;
    this.logger = logger;
    this.cachedToken = null;
    this.inflightRefresh = null;
  }

  shouldRefresh(token = this.cachedToken) {
    if (!token) {
      return true;
    }
    return token.expiresOnTimestamp - this.now() < this.refreshBufferMs;
  }

  async refreshToken() {
    try {
      const result = await this.credential.getToken(this.scope);
      if (!result?.token || !result?.expiresOnTimestamp) {
        throw new Error("Azure credential returned an invalid token payload");
      }

      this.cachedToken = {
        token: result.token,
        expiresOnTimestamp: result.expiresOnTimestamp
      };

      this.logger.info?.(
        { expiresOn: new Date(result.expiresOnTimestamp).toISOString() },
        "Token refresh succeeded"
      );

      return this.cachedToken;
    } catch (error) {
      this.logger.error?.({ error: String(error) }, "Token refresh failed");
      throw new CredentialUnavailableError(
        "DefaultAzureCredential could not acquire an Azure OpenAI token inside WSL",
        error
      );
    }
  }

  async getAccessToken() {
    if (!this.shouldRefresh()) {
      return this.cachedToken.token;
    }

    if (!this.inflightRefresh) {
      this.inflightRefresh = this.refreshToken().finally(() => {
        this.inflightRefresh = null;
      });
    }

    const refreshed = await this.inflightRefresh;
    return refreshed.token;
  }

  async checkReady() {
    const token = await this.getAccessToken();
    return {
      ok: true,
      hasToken: Boolean(token),
      expiresOnTimestamp: this.cachedToken?.expiresOnTimestamp ?? null
    };
  }
}
