import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  httpBasicAuthPolicy,
  matchesBasicAuthorization,
  registerHttpBasicAuth,
  type HttpBasicAuthPolicy,
} from "./httpBasicAuth.js";

const policy: HttpBasicAuthPolicy = { username: "jesse", password: "correct horse" };

describe("httpBasicAuthPolicy", () => {
  it("is disabled when no credentials or requirement are configured", () => {
    expect(httpBasicAuthPolicy({})).toBeUndefined();
  });

  it("fails closed when authentication is required without complete credentials", () => {
    expect(() => httpBasicAuthPolicy({ PI_WEB_REQUIRE_HTTP_AUTH: "true" })).toThrow(/must both be set/u);
    expect(() => httpBasicAuthPolicy({ PI_WEB_HTTP_USER: "jesse" })).toThrow(/must both be set/u);
  });

  it("returns complete credentials without logging or transforming them", () => {
    expect(httpBasicAuthPolicy({ PI_WEB_HTTP_USER: "jesse", PI_WEB_HTTP_PASSWORD: "correct horse" })).toEqual(policy);
  });
});
describe("matchesBasicAuthorization", () => {
  it("accepts only the configured username and password", () => {
    expect(matchesBasicAuthorization(`Basic ${Buffer.from("jesse:correct horse").toString("base64")}`, policy)).toBe(true);
    expect(matchesBasicAuthorization(`Basic ${Buffer.from("jesse:wrong").toString("base64")}`, policy)).toBe(false);
    expect(matchesBasicAuthorization("Bearer token", policy)).toBe(false);
  });
});

describe("registerHttpBasicAuth", () => {
  it("mints a durable cookie after Basic authentication while leaving the state-free health probe available", async () => {
    const app = Fastify({ logger: false });
    registerHttpBasicAuth(app, policy);
    app.get("/api/pi-web/health", () => ({ ok: true }));
    app.get("/private", () => ({ secret: true }));

    const health = await app.inject({ method: "GET", url: "/api/pi-web/health" });
    expect(health.statusCode).toBe(200);

    const denied = await app.inject({
      method: "GET",
      url: "/private",
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["www-authenticate"]).toBe('Basic realm="PI WEB", charset="UTF-8"');

    const allowed = await app.inject({
      method: "GET",
      url: "/private",
      headers: {
        authorization: `Basic ${Buffer.from("jesse:correct horse").toString("base64")}`,
        "x-forwarded-proto": "https",
      },
    });
    expect(allowed.statusCode).toBe(200);
    const cookie = allowed.headers["set-cookie"];
    expect(cookie).toContain("pi_web_http_session=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("Secure");

    const requestCookie = (Array.isArray(cookie) ? cookie[0] : cookie)?.split(";", 1)[0];
    const allowedByCookie = await app.inject({ method: "GET", url: "/private", headers: { cookie: requestCookie } });
    expect(allowedByCookie.statusCode).toBe(200);

    await app.close();
  });

  it("denies background API requests without opening another Basic-auth challenge", async () => {
    const app = Fastify({ logger: false });
    registerHttpBasicAuth(app, policy);
    app.get("/api/pi-web/status", () => ({ ok: true }));

    const denied = await app.inject({ method: "GET", url: "/api/pi-web/status" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["www-authenticate"]).toBeUndefined();

    await app.close();
  });

  it("invalidates an existing session cookie when the configured credentials rotate", async () => {
    const firstApp = Fastify({ logger: false });
    registerHttpBasicAuth(firstApp, policy);
    firstApp.get("/private", () => ({ secret: true }));
    const signedIn = await firstApp.inject({
      method: "GET",
      url: "/private",
      headers: { authorization: `Basic ${Buffer.from("jesse:correct horse").toString("base64")}` },
    });
    const cookie = signedIn.headers["set-cookie"];
    expect(cookie).toBeDefined();
    const requestCookie = (Array.isArray(cookie) ? cookie[0] : cookie)?.split(";", 1)[0];
    await firstApp.close();

    const rotatedApp = Fastify({ logger: false });
    registerHttpBasicAuth(rotatedApp, { username: "jesse", password: "new horse" });
    rotatedApp.get("/private", () => ({ secret: true }));
    const denied = await rotatedApp.inject({ method: "GET", url: "/private", headers: { cookie: requestCookie } });
    expect(denied.statusCode).toBe(401);

    await rotatedApp.close();
  });
});
