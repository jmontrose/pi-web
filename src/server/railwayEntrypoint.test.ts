import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Railway entrypoint", () => {
  it("scans persistent data recursively only until the ownership migration completes", async () => {
    const entrypoint = await readFile(resolve(repoRoot, "docker", "railway-entrypoint"), "utf8");

    expect(entrypoint).toContain('readonly ownership_marker=/data/.pi-web-runtime-owner');
    expect(entrypoint).toContain('Preparing persistent volume ownership (one-time scan)...');
    expect(entrypoint.match(/chown -R "\$runtime_uid:\$runtime_gid" \/data/g)).toHaveLength(1);
    expect(entrypoint).toContain('chown -R "$runtime_uid:$runtime_gid" "$workspace_path"');
    expect(entrypoint.indexOf('mv -f "$ownership_marker_tmp" "$ownership_marker"')).toBeGreaterThan(
      entrypoint.indexOf('git clone -- "$PI_WEB_GIT_REPOSITORY" "$workspace_path"'),
    );
  });
});
