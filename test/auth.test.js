import test from "node:test";
import assert from "node:assert/strict";
import { TokenManager } from "../src/auth.js";

test("TokenManager coalesces concurrent refreshes", async () => {
  let callCount = 0;
  const now = Date.now();

  const credential = {
    async getToken() {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        token: "token-A",
        expiresOnTimestamp: now + 60_000
      };
    }
  };

  const manager = new TokenManager({
    credential,
    scope: "scope",
    refreshBufferMs: 5_000,
    now: () => now
  });

  const tokens = await Promise.all(Array.from({ length: 10 }, () => manager.getAccessToken()));

  assert.equal(callCount, 1);
  assert.deepEqual(new Set(tokens), new Set(["token-A"]));
});

test("TokenManager refreshes when token is near expiry", async () => {
  const baseNow = Date.now();
  let index = 0;
  const issued = [
    { token: "old-token", expiresOnTimestamp: baseNow + 2_000 },
    { token: "new-token", expiresOnTimestamp: baseNow + 120_000 }
  ];

  const credential = {
    async getToken() {
      const token = issued[index] ?? issued[issued.length - 1];
      index += 1;
      return token;
    }
  };

  let nowCursor = baseNow;
  const manager = new TokenManager({
    credential,
    scope: "scope",
    refreshBufferMs: 5_000,
    now: () => nowCursor
  });

  const first = await manager.getAccessToken();
  assert.equal(first, "old-token");

  nowCursor += 100;
  const second = await manager.getAccessToken();
  assert.equal(second, "new-token");
  assert.equal(index, 2);
});
