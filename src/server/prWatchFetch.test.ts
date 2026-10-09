import { mkdtemp, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildResult,
  classify,
  isAuthorizationError,
} from "../../deploy/pi-profile/agents/pr-watch-fetch.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("managed PR watcher", () => {
  it("executes and emits JSON when invoked through a symlink", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-symlink-"));
    tempDirs.push(tempDir);
    const helperPath = fileURLToPath(
      new URL("../../deploy/pi-profile/agents/pr-watch-fetch.mjs", import.meta.url),
    );
    const symlinkPath = join(tempDir, "pr-watch-fetch.mjs");
    await symlink(helperPath, symlinkPath);

    const result = spawnSync(process.execPath, [symlinkPath], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('{"error":"usage: pr-watch-fetch.mjs');
  });

  it("returns readable review activity immediately when CI permissions are unavailable", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-"));
    tempDirs.push(stateRoot);

    const result = buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10624, reset: false },
      {
        stateRoot,
        now: () => new Date("2026-10-09T22:09:17.000Z"),
        ghJson: (args: string[]) => {
          if (args.at(-1) === "statusCheckRollup") {
            throw new Error("HTTP 403: Resource not accessible by personal access token");
          }
          return {
            title: "Example", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN", reviewDecision: null, headRefName: "feature",
            headRefOid: "0123456789abcdef", baseRefName: "main", labels: [],
            reviewRequests: [], additions: 1, deletions: 0, changedFiles: 1,
          };
        },
        ghApiList: (path: string) => path.endsWith("/reviews")
          ? [{
              id: 1, state: "COMMENTED", user: { login: "reviewer" },
              author_association: "MEMBER", body: "Please address this.",
              submitted_at: "2026-10-09T22:00:00Z", commit_id: "0123456789abcdef",
              html_url: "https://github.com/airelabsresearch/siro/pull/10624#pullrequestreview-1",
            }]
          : [],
      },
    );

    expect(result.ciVisibility).toMatchObject({
      available: false,
      reason: "insufficient-permissions",
    });
    expect(result.reviews).toHaveLength(1);
    expect(result.counts).toMatchObject({ checks: 0, reviews: 1 });
    expect(result.allTerminal).toBe(false);
    expect(classify(result)).toBe("ci-unavailable");
  });

  it("distinguishes deterministic authorization failures from transient fetch failures", () => {
    expect(isAuthorizationError(new Error("HTTP 403: Forbidden"))).toBe(true);
    expect(isAuthorizationError(new Error("Resource not accessible by integration"))).toBe(true);
    expect(isAuthorizationError(new Error("connection reset by peer"))).toBe(false);
  });
});
