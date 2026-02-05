import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { signJwt, verifyJwt } from "../src/lib/jwt.js";

test("jwt: signJwt + verifyJwt roundtrip", async () => {
  const secret = "test-secret";
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    sub: "123",
    login: "ribelo",
    avatar_url: "https://example.com/a.png",
    exp: now + 60,
    extra: "x",
  };

  const token = await Effect.runPromise(signJwt(payload, secret));
  const verified = await Effect.runPromise(verifyJwt(token, secret));

  assert.ok(verified);
  assert.equal(verified.sub, payload.sub);
  assert.equal(verified.login, payload.login);
  assert.equal(verified.avatar_url, payload.avatar_url);
  assert.equal(verified.extra, payload.extra);
});

test("jwt: verifyJwt rejects expired tokens", async () => {
  const secret = "test-secret";
  const now = Math.floor(Date.now() / 1000);

  const token = await Effect.runPromise(signJwt({ sub: "1", exp: now - 1 }, secret));
  const verified = await Effect.runPromise(verifyJwt(token, secret));

  assert.equal(verified, null);
});

test("jwt: verifyJwt rejects malformed tokens", async () => {
  const verified = await Effect.runPromise(verifyJwt("not-a-jwt", "secret"));
  assert.equal(verified, null);
});
