import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const SESSION_COOKIE_NAME = "pi_web_http_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const LOGIN_PATH = "/api/pi-web/http-auth/login";

export interface HttpBasicAuthPolicy {
  username: string;
  password: string;
}

export function httpBasicAuthPolicy(env: Readonly<NodeJS.ProcessEnv> = process.env): HttpBasicAuthPolicy | undefined {
  const username = env["PI_WEB_HTTP_USER"] ?? "";
  const password = env["PI_WEB_HTTP_PASSWORD"] ?? "";
  const required = parseBoolean(env["PI_WEB_REQUIRE_HTTP_AUTH"]);

  if (username === "" && password === "" && !required) return undefined;
  if (username === "" || password === "") {
    throw new Error("PI_WEB_HTTP_USER and PI_WEB_HTTP_PASSWORD must both be set when HTTP authentication is configured");
  }
  return { username, password };
}

export function registerHttpBasicAuth(app: FastifyInstance, policy: HttpBasicAuthPolicy | undefined): void {
  if (policy === undefined) return;

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post<{ Body: string }>(LOGIN_PATH, async (request, reply) => {
    const form = new URLSearchParams(request.body);
    const returnTo = safeReturnTo(form.get("returnTo"));
    const username = form.get("username") ?? "";
    const password = form.get("password") ?? "";

    if (!safeEqual(username, policy.username) || !safeEqual(password, policy.password)) {
      return sendLoginPage(reply, returnTo, true);
    }

    return reply
      .header("cache-control", "no-store")
      .header("set-cookie", sessionCookie(policy, request))
      .redirect(returnTo, 303);
  });

  app.addHook("onRequest", async (request, reply) => {
    // Railway's deployment health probe cannot supply credentials. This route
    // reports process readiness only and exposes no application state.
    if (request.url === "/api/pi-web/health") return;
    if (request.method === "POST" && request.url === LOGIN_PATH) return;
    if (matchesSessionCookie(request.headers.cookie, policy)) return;
    if (matchesBasicAuthorization(request.headers.authorization, policy)) {
      reply.header("set-cookie", sessionCookie(policy, request));
      return;
    }

    // Render a normal sign-in page for top-level navigation. In particular,
    // never send WWW-Authenticate here: browsers may silently reuse stale
    // Basic credentials and loop their native password prompt.
    if (isDocumentNavigation(request)) {
      return sendLoginPage(reply, request.url, false);
    }
    return reply
      .header("x-pi-web-auth", "required")
      .code(401)
      .send({ error: "Authentication required" });
  });
}

function sendLoginPage(
  reply: FastifyReply,
  returnTo: string,
  invalidCredentials: boolean,
) {
  return reply
    .header("cache-control", "no-store")
    .header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    )
    .type("text/html; charset=utf-8")
    .code(200)
    .send(loginPage(returnTo, invalidCredentials));
}

function loginPage(returnTo: string, invalidCredentials: boolean): string {
  const error = invalidCredentials
    ? '<p class="error" role="alert">Username or password is incorrect.</p>'
    : '<p class="hint">Enter the credentials configured for this deployment.</p>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · PI WEB</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #070a10; color: #f2f4f8; }
    main { width: min(100%, 400px); }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -0.02em; }
    .hint, .error { margin: 0 0 24px; color: #9ca6b8; line-height: 1.45; }
    .error { color: #ff7b8b; }
    label { display: block; margin: 16px 0 7px; color: #c9d0dc; font-size: 14px; font-weight: 600; }
    input { width: 100%; border: 1px solid #293144; border-radius: 10px; padding: 12px 13px; background: #0d121c; color: inherit; font: inherit; outline: none; }
    input:focus { border-color: #8b5cf6; box-shadow: 0 0 0 3px rgb(139 92 246 / 18%); }
    button { width: 100%; margin-top: 22px; border: 0; border-radius: 10px; padding: 12px 16px; background: #7c3aed; color: white; font: inherit; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Sign in to PI WEB</h1>
    ${error}
    <form method="post" action="api/pi-web/http-auth/login">
      <input type="hidden" name="returnTo" value="${escapeHtml(safeReturnTo(returnTo))}">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

function safeReturnTo(value: string | null): string {
  if (value === null || !value.startsWith("/") || value.startsWith("//") || /[\r\n]/u.test(value)) return "/";
  return value;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function matchesBasicAuthorization(header: string | undefined, policy: HttpBasicAuthPolicy): boolean {
  if (header?.startsWith("Basic ") !== true) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return false;
  }
  return safeEqual(decoded, `${policy.username}:${policy.password}`);
}

function matchesSessionCookie(header: string | undefined, policy: HttpBasicAuthPolicy): boolean {
  const actual = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  return actual !== undefined && safeEqual(actual, sessionToken(policy));
}

function sessionCookie(policy: HttpBasicAuthPolicy, request: FastifyRequest): string {
  const secure = request.protocol === "https" || forwardedProtocol(request) === "https";
  return [
    `${SESSION_COOKIE_NAME}=${sessionToken(policy)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(SESSION_COOKIE_MAX_AGE_SECONDS)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function sessionToken(policy: HttpBasicAuthPolicy): string {
  return createHmac("sha256", policy.password)
    .update(`pi-web-http-session\0${policy.username}`)
    .digest("base64url");
}

function forwardedProtocol(request: FastifyRequest): string | undefined {
  const value = request.headers["x-forwarded-proto"];
  return (Array.isArray(value) ? value[0] : value)?.split(",", 1)[0]?.trim().toLowerCase();
}

function isDocumentNavigation(request: FastifyRequest): boolean {
  if (request.method !== "GET") return false;
  if (request.headers["sec-fetch-mode"] === "navigate") return true;
  return request.headers.accept?.split(",").some((value) => value.trim().split(";", 1)[0] === "text/html") ?? false;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0" || value.toLowerCase() === "false") return false;
  if (value === "1" || value.toLowerCase() === "true") return true;
  throw new Error("PI_WEB_REQUIRE_HTTP_AUTH must be one of 0, 1, true, or false");
}
