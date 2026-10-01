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
  it("shows an explicit sign-in page and mints a durable cookie after Basic authentication", async () => {
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
    expect(denied.statusCode).toBe(200);
    expect(denied.headers["content-type"]).toContain("text/html");
    expect(denied.headers["www-authenticate"]).toBeUndefined();
    expect(denied.body).toContain("Sign in to PI WEB");
    expect(denied.body).toContain('name="returnTo" value="/private"');

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

  it("reports invalid form credentials instead of repeating a browser challenge", async () => {
    const app = Fastify({ logger: false });
    registerHttpBasicAuth(app, policy);

    const denied = await app.inject({
      method: "POST",
      url: "/api/pi-web/http-auth/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ username: "jesse", password: "wrong", returnTo: "/?session=123" }).toString(),
    });

    expect(denied.statusCode).toBe(200);
    expect(denied.headers["www-authenticate"]).toBeUndefined();
    expect(denied.headers["set-cookie"]).toBeUndefined();
    expect(denied.body).toContain("Username or password is incorrect.");
    expect(denied.body).toContain('name="returnTo" value="/?session=123"');

    await app.close();
  });

  it("signs in through the form and safely returns to the requested page", async () => {
    const app = Fastify({ logger: false });
    registerHttpBasicAuth(app, policy);

    const signedIn = await app.inject({
      method: "POST",
      url: "/api/pi-web/http-auth/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "https",
      },
      payload: new URLSearchParams({
        username: "jesse",
        password: "correct horse",
        returnTo: "/?project=abc&session=123",
      }).toString(),
    });

    expect(signedIn.statusCode).toBe(303);
    expect(signedIn.headers.location).toBe("/?project=abc&session=123");
    expect(signedIn.headers["set-cookie"]).toContain("pi_web_http_session=");
    expect(signedIn.headers["set-cookie"]).toContain("Secure");

    const unsafeRedirect = await app.inject({
      method: "POST",
      url: "/api/pi-web/http-auth/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        username: "jesse",
        password: "correct horse",
        returnTo: "//example.com/steal-session",
      }).toString(),
    });
    expect(unsafeRedirect.statusCode).toBe(303);
    expect(unsafeRedirect.headers.location).toBe("/");

    await app.close();
  });

  it("denies background API requests without opening another Basic-auth challenge", async () => {
    const app = Fastify({ logger: false });
    registerHttpBasicAuth(app, policy);
    app.get("/api/pi-web/status", () => ({ ok: true }));

    const denied = await app.inject({ method: "GET", url: "/api/pi-web/status" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["www-authenticate"]).toBeUndefined();
    expect(denied.headers["x-pi-web-auth"]).toBe("required");

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
