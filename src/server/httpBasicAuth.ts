import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

const SESSION_COOKIE_NAME = "pi_web_http_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

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

  app.addHook("onRequest", async (request, reply) => {
    // Railway's deployment health probe cannot supply credentials. This route
    // reports process readiness only and exposes no application state.
    if (request.url === "/api/pi-web/health") return;
    if (matchesSessionCookie(request.headers.cookie, policy)) return;
    if (matchesBasicAuthorization(request.headers.authorization, policy)) {
      reply.header("set-cookie", sessionCookie(policy, request));
      return;
    }

    // Only a top-level document navigation should open the browser's native
    // Basic-auth prompt. Polling APIs fail closed without queuing one prompt
    // per request while the document is already waiting for credentials.
    if (isDocumentNavigation(request)) {
      reply.header("www-authenticate", 'Basic realm="PI WEB", charset="UTF-8"');
    }
    return reply
      .header("x-pi-web-auth", "required")
      .code(401)
      .send({ error: "Authentication required" });
  });
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
