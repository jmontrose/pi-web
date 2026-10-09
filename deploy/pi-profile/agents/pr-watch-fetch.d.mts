export interface WatchResult {
  ciVisibility: { available: boolean; reason: string | null; message: string | null };
  reviews: unknown[];
  counts: { checks: number; reviews: number };
  allTerminal: boolean;
}

export interface BuildResultDependencies {
  stateRoot: string;
  now: () => Date;
  ghJson: (args: string[]) => Record<string, unknown>;
  ghApiList: (path: string) => unknown[];
}

export function buildResult(
  args: { owner: string; name: string; pr: number; reset: boolean },
  deps: BuildResultDependencies,
): WatchResult;

export function classify(result: WatchResult): string | null;
export function isAuthorizationError(error: unknown): boolean;
