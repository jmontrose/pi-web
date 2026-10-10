export interface WatchResult {
  firstWatch?: boolean;
  ciVisibility: {
    available: boolean;
    reason: string | null;
    message: string | null;
    source?: "actions" | null;
    coverage?: "pull-request-actions-only" | "none";
    complete?: boolean;
    currentRunsFound?: boolean;
    moonCiRequired?: boolean;
    moonCiObserved?: boolean;
  };
  reviews?: unknown[];
  mergeConflict?: boolean;
  moonCiFailing?: boolean;
  summary?: { actionable: number };
  counts?: { checks: number; reviews: number; failing?: number; running?: number };
  allTerminal: boolean;
  currentFailures?: Array<{ name: string; conclusion: string | null }>;
  runningChecks?: string[];
  stillRunning?: Array<{ name: string; status: string }>;
  newFailures?: Array<{ name: string; conclusion: string | null; was: string | null }>;
}

export interface BuildResultDependencies {
  stateRoot?: string;
  now?: () => Date;
  ghJson?: (args: string[]) => Record<string, unknown>;
  ghApiList?: (path: string) => unknown[];
  ghActionsRuns?: (path: string) => unknown[];
}

export function buildResult(
  args: { owner: string; name: string; pr: number; reset: boolean },
  deps: BuildResultDependencies,
): WatchResult;

export function classify(result: WatchResult): string | null;
export function isAuthorizationError(error: unknown): boolean;
