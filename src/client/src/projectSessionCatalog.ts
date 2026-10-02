import type { SessionInfo, Workspace } from "./api";

export interface ProjectSessionCatalogFailure {
  workspace: Workspace;
  message: string;
}

export interface ProjectSessionCatalogSnapshot {
  sessions: SessionInfo[];
  failures: ProjectSessionCatalogFailure[];
}

export interface ProjectSessionNavigationTarget {
  projectId: string;
  workspaceId: string;
  sessionId: string;
}

export type WorkspaceSessionLoader = (cwd: string) => Promise<SessionInfo[]>;

/**
 * Build a browser-only project projection without changing the daemon's
 * workspace-scoped session contract. A failed worktree stays visible as an
 * explicit partial-result warning instead of blanking healthy worktrees.
 */
export async function loadProjectSessionCatalog(
  workspaces: readonly Workspace[],
  loadSessions: WorkspaceSessionLoader,
): Promise<ProjectSessionCatalogSnapshot> {
  const results = await Promise.all(workspaces.map(async (workspace) => {
    try {
      return { workspace, sessions: await loadSessions(workspace.path) } as const;
    } catch (error) {
      return { workspace, message: errorMessage(error) } as const;
    }
  }));

  const sessions: SessionInfo[] = [];
  const failures: ProjectSessionCatalogFailure[] = [];
  for (const result of results) {
    if ("sessions" in result) sessions.push(...result.sessions);
    else failures.push(result);
  }
  sessions.sort(compareRecentSessions);
  return { sessions, failures };
}

export function replaceWorkspaceSessions(
  catalog: readonly SessionInfo[],
  workspace: Workspace,
  sessions: readonly SessionInfo[],
): SessionInfo[] {
  return [...catalog.filter((session) => session.cwd !== workspace.path), ...sessions].sort(compareRecentSessions);
}

export function upsertProjectSession(catalog: readonly SessionInfo[], session: SessionInfo): SessionInfo[] {
  return [session, ...catalog.filter((candidate) => candidate.id !== session.id || candidate.cwd !== session.cwd)].sort(compareRecentSessions);
}

export function renameProjectSession(catalog: readonly SessionInfo[], sessionId: string, name: string | undefined): SessionInfo[] {
  if (!catalog.some((session) => session.id === sessionId && session.name !== name)) return [...catalog];
  return catalog.map((session) => {
    if (session.id !== sessionId || session.name === name) return session;
    if (name !== undefined) return { ...session, name };
    const renamed = { ...session };
    delete renamed.name;
    return renamed;
  });
}

export function projectSessionCatalogScope(
  machineId: string,
  projectId: string | undefined,
  workspaces: readonly Workspace[],
  selectedWorkspaceId?: string,
): string {
  return JSON.stringify([machineId, projectId, selectedWorkspaceId, workspaces.map((workspace) => [workspace.id, workspace.path])]);
}

export function projectSessionNavigationTarget(
  workspaces: readonly Workspace[],
  session: SessionInfo,
): ProjectSessionNavigationTarget | undefined {
  const workspace = workspaces.find((candidate) => candidate.path === session.cwd);
  if (workspace === undefined) return undefined;
  return { projectId: workspace.projectId, workspaceId: workspace.id, sessionId: session.id };
}

function compareRecentSessions(left: SessionInfo, right: SessionInfo): number {
  return Date.parse(right.modified) - Date.parse(left.modified);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
