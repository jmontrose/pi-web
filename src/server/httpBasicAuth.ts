import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

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
    if (matchesBasicAuthorization(request.headers.authorization, policy)) return;

    return reply
      .header("www-authenticate", 'Basic realm="PI WEB", charset="UTF-8"')
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
