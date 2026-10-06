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

  it("installs the managed PR watcher without copying runtime secrets", async () => {
    const [entrypoint, packagesText, agent, strongWorker, helper, prompt] = await Promise.all([
      readFile(resolve(repoRoot, "docker", "railway-entrypoint"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "packages.json"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "agents", "pr-watch.md"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "agents", "worker-strong.md"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "agents", "pr-watch-fetch.mjs"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "prompts", "pr-watch.md"), "utf8"),
    ]);

    expect(JSON.parse(packagesText)).toMatchObject({
      packages: [{ name: "pi-subagents", version: "0.76.1" }],
    });
    expect(entrypoint).toContain("for managed_subdirectory in agents prompts");
    expect(entrypoint).toContain('install -o "$runtime_uid" -g "$runtime_gid" -m 0600');
    expect(agent).toContain("name: pr-watch");
    expect(agent).toContain("model: together/zai-org/GLM-5.3-Flash");
    expect(strongWorker).toContain("name: worker-strong");
    expect(strongWorker).toContain("description: ESCALATION implementation writer");
    expect(strongWorker).toContain("model: together/zai-org/GLM-5.3");
    expect(entrypoint).toContain('const workerModel = "together/zai-org/GLM-5.3-Flash"');
    expect(entrypoint).toContain("DEFAULT low-cost implementation writer");
    expect(agent).toContain("pr-watch-fetch.mjs");
    expect(helper).toContain("export { parseArgs, buildResult, classify, pollLoop }");
    expect(prompt).toContain('agent: \\"pr-watch\\"');
    for (const managedFile of [agent, strongWorker, helper, prompt]) {
      expect(managedFile).not.toMatch(/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
      expect(managedFile).not.toMatch(/(?:GH|GITHUB|TOGETHER)_TOKEN\s*=/);
    }
  });
});
