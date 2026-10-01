import { describe, expect, it, vi } from "vitest";
import { createAuthenticationRecovery } from "./http";

describe("createAuthenticationRecovery", () => {
  it("reloads once for gateway authentication failures and quiets concurrent failures", () => {
    const reload = vi.fn();
    const recover = createAuthenticationRecovery(reload);
    const gatewayUnauthorized = {
      status: 401,
      headers: new Headers({ "x-pi-web-auth": "required" }),
    };

    expect(recover(gatewayUnauthorized)).toBe(true);
    expect(recover(gatewayUnauthorized)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload for ordinary API or remote-machine failures", () => {
    const reload = vi.fn();
    const recover = createAuthenticationRecovery(reload);

    expect(recover({ status: 500, headers: new Headers() })).toBe(false);
    expect(recover({ status: 401, headers: new Headers() })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
