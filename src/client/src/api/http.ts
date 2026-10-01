import { resolveAppUrl } from "../appUrl";

interface AuthenticationRecoveryResponse {
  status: number;
  headers: Pick<Headers, "get">;
}

export function createAuthenticationRecovery(reload: () => void): (response: AuthenticationRecoveryResponse) => boolean {
  let started = false;
  return (response) => {
    if (response.status !== 401 || response.headers.get("x-pi-web-auth") !== "required") return false;
    if (!started) {
      started = true;
      reload();
    }
    return true;
  };
}

const recoverAuthentication = createAuthenticationRecovery(() => {
  window.location.reload();
});

/** A response-backed API failure, retaining the status needed at an ownership boundary. */
export class HttpRequestError extends Error {
  override name = "HttpRequestError";

  constructor(message: string, readonly status: number, options: ErrorOptions = {}) {
    super(message, options);
  }
}

export async function request<T>(url: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(resolveAppUrl(url), { ...init, headers });
  if (!response.ok) {
    // A restored page can predate the cookie session established by its current
    // server. Reload once to cross the document-auth boundary; keep concurrent
    // polling promises quiet while navigation tears this page down.
    if (recoverAuthentication(response)) return new Promise<T>(() => undefined);
    const body: unknown = await response.json().catch((): unknown => ({}));
    throw new HttpRequestError(errorMessage(body) ?? response.statusText, response.status);
  }
  const body: unknown = await response.json();
  return parse(body);
}

function errorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["error"] === "string" ? value["error"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
