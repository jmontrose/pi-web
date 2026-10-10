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
        ghActionsRuns: () => {
          throw new Error("HTTP 403: Resource not accessible by personal access token");
        },
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

  it("falls back to current-revision Actions runs and surfaces Moon CI failure", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-"));
    tempDirs.push(stateRoot);
    const headRefOid = "0123456789abcdef";

    const result = buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      {
        stateRoot,
        now: () => new Date("2026-10-10T12:00:00.000Z"),
        ghJson: (args: string[]) => {
          if (args.at(-1) === "statusCheckRollup") {
            throw new Error("HTTP 403: Resource not accessible by personal access token");
          }
          return {
            title: "Example", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN", reviewDecision: null, headRefName: "feature",
            headRefOid, baseRefName: "main", labels: [], reviewRequests: [],
            additions: 1, deletions: 0, changedFiles: 1,
          };
        },
        ghApiList: () => [],
        ghActionsRuns: () => [
          {
            id: 101, name: "Moon CI", path: ".github/workflows/moon-ci.yaml@main",
            status: "completed", conclusion: "failure", run_attempt: 1,
            head_sha: headRefOid,
            run_started_at: "2026-10-10T11:50:00Z", updated_at: "2026-10-10T11:59:00Z",
            html_url: "https://github.com/airelabsresearch/siro/actions/runs/101",
            pull_requests: [{ number: 10646, head: { sha: headRefOid } }],
          },
          {
            id: 102, name: "Proto CI", path: ".github/workflows/proto-ci.yml@main",
            status: "in_progress", conclusion: null, run_attempt: 1,
            head_sha: headRefOid,
            run_started_at: "2026-10-10T11:51:00Z", updated_at: "2026-10-10T11:58:00Z",
            html_url: "https://github.com/airelabsresearch/siro/actions/runs/102",
            pull_requests: [{ number: 10646, head: { sha: headRefOid } }],
          },
          {
            id: 99, name: "Moon CI", path: ".github/workflows/moon-ci.yaml@main",
            status: "completed", conclusion: "success", run_attempt: 1,
            head_sha: "stale-head", pull_requests: [{ number: 10646, head: { sha: headRefOid } }],
          },
        ],
      },
    );

    expect(result.ciVisibility).toMatchObject({
      available: true,
      source: "actions",
      coverage: "pull-request-actions-only",
      complete: false,
      currentRunsFound: true,
    });
    expect(result.counts).toMatchObject({ checks: 2, failing: 1, running: 1 });
    expect(result.currentFailures).toEqual([
      expect.objectContaining({ name: "Moon CI", conclusion: "FAILURE" }),
    ]);
    expect(result.runningChecks).toEqual(["Proto CI"]);
    expect(result.allTerminal).toBe(false);
    expect(classify(result)).toBe("moon-ci-failing");
  });

  it("keeps Actions-only CI pending until current-revision runs appear", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-"));
    tempDirs.push(stateRoot);

    const result = buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      {
        stateRoot,
        ghJson: (args: string[]) => {
          if (args.at(-1) === "statusCheckRollup") throw new Error("HTTP 403: Forbidden");
          return {
            title: "Example", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN", reviewDecision: null, headRefName: "feature",
            headRefOid: "current-head", baseRefName: "main", labels: [], reviewRequests: [],
            additions: 1, deletions: 0, changedFiles: 1,
          };
        },
        ghApiList: () => [],
        ghActionsRuns: () => [],
      },
    );

    expect(result.ciVisibility).toMatchObject({
      source: "actions",
      currentRunsFound: false,
    });
    expect(result.runningChecks).toEqual(["Current-revision Actions runs have not appeared yet"]);
    expect(result.allTerminal).toBe(false);
    expect(classify(result)).toBeNull();
  });

  it("requires a second poll before settling an all-green Actions-only baseline", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-"));
    tempDirs.push(stateRoot);
    const headRefOid = "current-head";
    const deps = {
      stateRoot,
      ghJson: (args: string[]) => {
        if (args.at(-1) === "statusCheckRollup") throw new Error("HTTP 403: Forbidden");
        return {
          title: "Example", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN", reviewDecision: null, headRefName: "feature",
          headRefOid, baseRefName: "main", labels: [], reviewRequests: [],
          additions: 1, deletions: 0, changedFiles: 1,
        };
      },
      ghApiList: () => [],
      ghActionsRuns: () => [{
        id: 101, name: "Moon CI", path: ".github/workflows/moon-ci.yaml@main",
        status: "completed", conclusion: "success", run_attempt: 1,
        head_sha: headRefOid,
        pull_requests: [{ number: 10646, head: { sha: headRefOid } }],
      }],
    };

    const baseline = buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      deps,
    );
    expect(baseline.allTerminal).toBe(true);
    expect(classify(baseline)).toBeNull();

    const secondPoll = buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      deps,
    );
    expect(secondPoll.allTerminal).toBe(true);
    expect(classify(secondPoll)).toBe("settled");
  });

  it("does not settle Actions-only CI before Moon CI appears", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-"));
    tempDirs.push(stateRoot);
    const headRefOid = "current-head";
    const deps = {
      stateRoot,
      ghJson: (args: string[]) => {
        if (args.at(-1) === "statusCheckRollup") throw new Error("HTTP 403: Forbidden");
        return {
          title: "Example", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN", reviewDecision: null, headRefName: "feature",
          headRefOid, baseRefName: "main", labels: [], reviewRequests: [],
          additions: 1, deletions: 0, changedFiles: 1,
        };
      },
      ghApiList: () => [],
      ghActionsRuns: () => [{
        id: 100, name: "Proto CI", path: ".github/workflows/proto-ci.yml@main",
        status: "completed", conclusion: "success", run_attempt: 1,
        head_sha: headRefOid,
        pull_requests: [{ number: 10646, head: { sha: headRefOid } }],
      }],
    };

    buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      deps,
    );
    const secondPoll = buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      deps,
    );

    expect(secondPoll.stillRunning).toEqual([
      expect.objectContaining({ name: "Moon CI has not appeared for the current revision yet" }),
    ]);
    expect(secondPoll.allTerminal).toBe(false);
    expect(classify(secondPoll)).toBeNull();
  });

  it("does not require a Moon workflow outside Siro", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-"));
    tempDirs.push(stateRoot);
    const headRefOid = "current-head";
    const deps = {
      stateRoot,
      ghJson: (args: string[]) => {
        if (args.at(-1) === "statusCheckRollup") throw new Error("HTTP 403: Forbidden");
        return {
          title: "Example", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN", reviewDecision: null, headRefName: "feature",
          headRefOid, baseRefName: "main", labels: [], reviewRequests: [],
          additions: 1, deletions: 0, changedFiles: 1,
        };
      },
      ghApiList: () => [],
      ghActionsRuns: () => [{
        id: 100, name: "Tests", path: ".github/workflows/tests.yml@main",
        status: "completed", conclusion: "success", run_attempt: 1,
        head_sha: headRefOid,
        pull_requests: [{ number: 7, head: { sha: headRefOid } }],
      }],
    };

    const baseline = buildResult(
      { owner: "example", name: "project", pr: 7, reset: false },
      deps,
    );
    expect(baseline.ciVisibility).toMatchObject({ moonCiRequired: false });
    expect(classify(baseline)).toBeNull();

    const secondPoll = buildResult(
      { owner: "example", name: "project", pr: 7, reset: false },
      deps,
    );
    expect(secondPoll.allTerminal).toBe(true);
    expect(classify(secondPoll)).toBe("settled");
  });

  it("treats a requested Moon CI workflow as still running", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-"));
    tempDirs.push(stateRoot);
    const headRefOid = "current-head";

    const result = buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      {
        stateRoot,
        ghJson: (args: string[]) => {
          if (args.at(-1) === "statusCheckRollup") throw new Error("HTTP 403: Forbidden");
          return {
            title: "Example", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN", reviewDecision: null, headRefName: "feature",
            headRefOid, baseRefName: "main", labels: [], reviewRequests: [],
            additions: 1, deletions: 0, changedFiles: 1,
          };
        },
        ghApiList: () => [],
        ghActionsRuns: () => [{
          id: 101, name: "Moon CI", path: ".github/workflows/moon-ci.yaml@main",
          status: "requested", conclusion: null, run_attempt: 1,
          head_sha: headRefOid,
          pull_requests: [{ number: 10646, head: { sha: headRefOid } }],
        }],
      },
    );

    expect(result.runningChecks).toEqual(["Moon CI"]);
    expect(result.allTerminal).toBe(false);
    expect(classify(result)).toBeNull();
  });

  it("diffs an Actions workflow run from queued to failed", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-"));
    tempDirs.push(stateRoot);
    const headRefOid = "current-head";
    let completed = false;
    const deps = {
      stateRoot,
      ghJson: (args: string[]) => {
        if (args.at(-1) === "statusCheckRollup") throw new Error("HTTP 403: Forbidden");
        return {
          title: "Example", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN", reviewDecision: null, headRefName: "feature",
          headRefOid, baseRefName: "main", labels: [], reviewRequests: [],
          additions: 1, deletions: 0, changedFiles: 1,
        };
      },
      ghApiList: () => [],
      ghActionsRuns: () => [{
        id: 101, name: "Proto CI", path: ".github/workflows/proto-ci.yml@main",
        status: completed ? "completed" : "queued",
        conclusion: completed ? "failure" : null,
        run_attempt: 1,
        head_sha: headRefOid,
        updated_at: completed ? "2026-10-10T12:05:00Z" : "2026-10-10T12:00:00Z",
        html_url: "https://github.com/airelabsresearch/siro/actions/runs/101",
        pull_requests: [{ number: 10646, head: { sha: headRefOid } }],
      }],
    };

    const baseline = buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      deps,
    );
    expect(baseline.runningChecks).toEqual([
      "Proto CI",
      "Moon CI has not appeared for the current revision yet",
    ]);

    completed = true;
    const diff = buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      deps,
    );
    expect(diff.newFailures).toEqual([
      expect.objectContaining({ name: "Proto CI", conclusion: "FAILURE", was: "QUEUED" }),
    ]);
    expect(classify(diff)).toBe("actionable");
  });

  it("prioritizes a newly failed Moon CI run over other actionable activity", () => {
    expect(classify({
      firstWatch: false,
      ciVisibility: { available: true, reason: null, message: null },
      mergeConflict: false,
      moonCiFailing: true,
      summary: { actionable: 2 },
      allTerminal: false,
    })).toBe("moon-ci-failing");
  });

  it("surfaces transient Actions fallback failures instead of masking them as auth gaps", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "pi-web-pr-watch-"));
    tempDirs.push(stateRoot);

    expect(() => buildResult(
      { owner: "airelabsresearch", name: "siro", pr: 10646, reset: false },
      {
        stateRoot,
        ghJson: (args: string[]) => {
          if (args.at(-1) === "statusCheckRollup") throw new Error("HTTP 403: Forbidden");
          return {
            title: "Example", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN", reviewDecision: null, headRefName: "feature",
            headRefOid: "current-head", baseRefName: "main", labels: [], reviewRequests: [],
            additions: 1, deletions: 0, changedFiles: 1,
          };
        },
        ghApiList: () => [],
        ghActionsRuns: () => {
          throw new Error("connection reset by peer");
        },
      },
    )).toThrow("failed to fetch PR 10646 Actions fallback");
  });

  it("distinguishes deterministic authorization failures from transient fetch failures", () => {
    expect(isAuthorizationError(new Error("HTTP 403: Forbidden"))).toBe(true);
    expect(isAuthorizationError(new Error("Resource not accessible by integration"))).toBe(true);
    expect(isAuthorizationError(new Error("connection reset by peer"))).toBe(false);
  });
});
