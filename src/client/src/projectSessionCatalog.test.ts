import { describe, expect, it, vi } from "vitest";
import type { SessionInfo, Workspace } from "./api";
import { loadProjectSessionCatalog, projectSessionCatalogScope, projectSessionNavigationTarget, renameProjectSession, replaceWorkspaceSessions, upsertProjectSession } from "./projectSessionCatalog";

describe("project session catalog", () => {
  it("combines worktree sessions in recent-first order while retaining partial failures", async () => {
    const main = workspace("main", "/repo", "main");
    const feature = workspace("feature", "/repo-feature", "feature");
    const broken = workspace("broken", "/repo-broken", "broken");
    const loader = vi.fn((cwd: string) => {
      if (cwd === broken.path) return Promise.reject(new Error("unavailable"));
      return Promise.resolve(cwd === main.path
        ? [session("main-session", main.path, "2026-10-01T10:00:00.000Z")]
        : [session("feature-session", feature.path, "2026-10-02T10:00:00.000Z")]);
    });

    const snapshot = await loadProjectSessionCatalog([main, feature, broken], loader);

    expect(loader.mock.calls.map(([cwd]) => cwd)).toEqual([main.path, feature.path, broken.path]);
    expect(snapshot.sessions.map(({ id }) => id)).toEqual(["feature-session", "main-session"]);
    expect(snapshot.failures).toEqual([{ workspace: broken, message: "unavailable" }]);
  });

  it("replaces one worktree projection without disturbing another", () => {
    const main = workspace("main", "/repo", "main");
    const existing = [
      session("main-old", main.path, "2026-10-01T10:00:00.000Z"),
      session("feature", "/repo-feature", "2026-10-02T10:00:00.000Z"),
    ];

    expect(replaceWorkspaceSessions(existing, main, [session("main-new", main.path, "2026-10-03T10:00:00.000Z")]).map(({ id }) => id))
      .toEqual(["main-new", "feature"]);
  });

  it("upserts and renames live session events by their stable identity", () => {
    const original = session("session", "/repo", "2026-10-01T10:00:00.000Z");
    const updated = { ...original, modified: "2026-10-03T10:00:00.000Z" };
    const other = session("session", "/other", "2026-10-02T10:00:00.000Z");

    const upserted = upsertProjectSession([original, other], updated);
    expect(upserted).toEqual([updated, other]);
    expect(renameProjectSession(upserted, "session", "Renamed").map(({ name }) => name)).toEqual(["Renamed", "Renamed"]);
  });

  it("changes scope when a worktree path changes", () => {
    const first = workspace("feature", "/repo-feature", "feature");
    const moved = { ...first, path: "/repo-feature-moved" };
    expect(projectSessionCatalogScope("local", "project", [first]))
      .not.toBe(projectSessionCatalogScope("local", "project", [moved]));
    expect(projectSessionCatalogScope("local", "project", [first], "main"))
      .not.toBe(projectSessionCatalogScope("local", "project", [first], "feature"));
  });

  it("maps a global session back to its owning worktree for normal navigation", () => {
    const main = workspace("main", "/repo", "main");
    const feature = workspace("feature", "/repo-feature", "feature");

    expect(projectSessionNavigationTarget([main, feature], session("target", feature.path, "2026-10-02T10:00:00.000Z")))
      .toEqual({ projectId: "project", workspaceId: "feature", sessionId: "target" });
    expect(projectSessionNavigationTarget([main, feature], session("missing", "/removed", "2026-10-02T10:00:00.000Z")))
      .toBeUndefined();
  });
});

function workspace(id: string, path: string, label: string): Workspace {
  return { id, projectId: "project", path, label, isMain: id === "main", effectiveConfig: {} };
}

function session(id: string, cwd: string, modified: string): SessionInfo {
  return { id, cwd, path: `${cwd}/${id}.jsonl`, created: modified, modified, messageCount: 1, firstMessage: id };
}
