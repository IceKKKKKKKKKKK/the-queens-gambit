import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultHandle,
  getAuthenticatedIdentity,
  IdentityError,
  normalizeEmail,
  normalizeHandle,
  requireAuthenticatedIdentity,
} from "../lib/identity.ts";
import { rejectCrossOriginMutation } from "../app/api/security.ts";

test("authenticated identity requires both trusted Sites headers", () => {
  assert.equal(getAuthenticatedIdentity(new Request("https://example.test")), null);
  assert.throws(
    () =>
      getAuthenticatedIdentity(
        new Request("https://example.test", {
          headers: { "oai-authenticated-user-id": "user-1" },
        }),
      ),
    (error: unknown) => error instanceof IdentityError && error.code === "INVALID_AUTH_EMAIL",
  );
  assert.throws(
    () => requireAuthenticatedIdentity(new Request("https://example.test")),
    (error: unknown) => error instanceof IdentityError && error.code === "AUTH_REQUIRED",
  );
});

test("authenticated identity normalizes email without changing the stable subject", () => {
  const request = new Request("https://example.test", {
    headers: {
      "oai-authenticated-user-id": "  stable-user-42  ",
      "oai-authenticated-user-email": " Ice+Game@Example.COM ",
    },
  });
  assert.deepEqual(requireAuthenticatedIdentity(request), {
    authUserId: "stable-user-42",
    email: "ice+game@example.com",
  });
  assert.equal(normalizeEmail("Player@Example.COM"), "player@example.com");
  for (const email of ["missing-at", "a@@example.com", "a @example.com", "@example.com"]) {
    assert.throws(() => normalizeEmail(email), IdentityError);
  }
});

test("handles support Chinese names while enforcing a safe unique key shape", () => {
  assert.deepEqual(normalizeHandle("  棋圣_1  "), {
    handle: "棋圣_1",
    handleKey: "棋圣_1",
  });
  assert.deepEqual(normalizeHandle("IcePlayer"), {
    handle: "IcePlayer",
    handleKey: "iceplayer",
  });
  for (const handle of ["ab", "_player", "player name", "<script>", "a".repeat(17)]) {
    assert.throws(
      () => normalizeHandle(handle),
      (error: unknown) => error instanceof IdentityError && error.code === "INVALID_HANDLE",
    );
  }
});

test("default handles are deterministic, private, and valid", async () => {
  const identity = { authUserId: "private-platform-subject", email: "ice.game@example.com" };
  const first = await createDefaultHandle(identity);
  const retry = await createDefaultHandle(identity, "1");
  assert.deepEqual(first, await createDefaultHandle(identity));
  assert.notEqual(first.handle, retry.handle);
  assert.match(first.handle, /^棋手_[0-9a-f]{6}$/);
  assert.equal(first.handle.includes(identity.authUserId), false);
  assert.equal(first.handle.includes("ice"), false);
});

test("browser-authenticated mutations require a same-origin request", async () => {
  const responseHeaders = { "Cache-Control": "no-store" };
  assert.equal(
    rejectCrossOriginMutation(new Request("https://game.example/api/matchmaking"), responseHeaders),
    null,
  );
  assert.equal(
    rejectCrossOriginMutation(
      new Request("https://game.example/api/matchmaking", {
        headers: {
          Origin: "https://game.example",
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      responseHeaders,
    ),
    null,
  );

  const crossOriginHeaderSets: Array<Record<string, string>> = [
    { Origin: "https://attacker.example" },
    { Origin: "null" },
    { Origin: "https://game.example", "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of crossOriginHeaderSets) {
    const rejected = rejectCrossOriginMutation(
      new Request("https://game.example/api/matchmaking", { headers }),
      responseHeaders,
    );
    assert.ok(rejected);
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: "CROSS_ORIGIN_REQUEST" });
  }
});
