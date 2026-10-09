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

  it("restores persistent Rust commands and disposable Cargo build storage on boot", async () => {
    const [dockerfile, entrypoint, instructions] = await Promise.all([
      readFile(resolve(repoRoot, "Dockerfile"), "utf8"),
      readFile(resolve(repoRoot, "docker", "railway-entrypoint"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "AGENTS.md"), "utf8"),
    ]);

    expect(dockerfile).toContain("PATH=/data/pi-agent/bin:/data/home/.cargo/bin:");
    expect(entrypoint).toContain("/var/tmp/cargo-target");
    expect(entrypoint).toContain("for rust_command in cargo rustc rustup cargo-clippy cargo-fmt wasm-bindgen cargo-binstall");
    expect(entrypoint).toContain('ln -sfnT "$rust_command_source" "$agent_dir/bin/$rust_command"');
    expect(instructions).toContain("# Rust toolchain (this environment)");
    expect(instructions).toContain("ln -sfnT /var/tmp/cargo-target target");
    expect(instructions).toContain("target exists and is not a symlink");
    expect(instructions).toContain("Do not put Cargo build output on `/data`");
    expect(instructions).toContain("`MOON_REMOTE_TOKEN` is not currently supplied");
    expect(instructions).toContain("Use `rg` for filesystem text searches");
    expect(instructions).toContain("`rg --hidden` when the search must include dot-directories");
    expect(instructions).toContain("REQUIRE_NEWT=1 NEWT_CLI_BIN=");
    expect(instructions).toContain("src/__tests__/newt-surface-parity.test.ts");
    expect(instructions).toContain("src/__tests__/newt-sidecar-golden.test.ts");
    expect(instructions).toContain("src/newt-differential.test.ts");
    expect(instructions).toContain("ECONNREFUSED 10.0.0.1:443");
  });

  it("installs the managed PR watcher without copying runtime secrets", async () => {
    const [dockerfile, supervisor, entrypoint, instructions, packagesText, agent, forkWorker, helper, prompt] = await Promise.all([
      readFile(resolve(repoRoot, "Dockerfile"), "utf8"),
      readFile(resolve(repoRoot, "docker", "railway-supervisor"), "utf8"),
      readFile(resolve(repoRoot, "docker", "railway-entrypoint"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "AGENTS.md"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "packages.json"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "agents", "pr-watch.md"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "agents", "worker-fork.md"), "utf8"),
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
    expect(forkWorker).toContain("name: worker-fork");
    expect(forkWorker).toContain("model: together/zai-org/GLM-5.3-Flash");
    expect(forkWorker).toContain("defaultContext: fork");
    expect(entrypoint).toContain('const workerModel = "together/zai-org/GLM-5.3-Flash"');
    expect(entrypoint).toContain("DEFAULT fresh-context writer");
    expect(entrypoint).toContain("subagents.defaultModel = selectedModel");
    expect(entrypoint).toContain('rm -f -- "$agent_dir/agents/worker-strong.md"');
    expect(agent).toContain("pr-watch-fetch.mjs");
    expect(helper).toContain("export { parseArgs, buildResult, classify, pollLoop }");
    expect(prompt).toContain('agent: \\"pr-watch\\"');
    expect(dockerfile).toContain(
      "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/opt/pi-web/node_modules/@earendil-works/pi-coding-agent",
    );
    expect(dockerfile).toContain(
      "test -f /opt/pi-web/node_modules/@earendil-works/pi-coding-agent/package.json",
    );
    expect(supervisor).not.toContain("-u PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT");
    expect(instructions).toContain("A watcher is running only when the background launch returns a successful run");
    expect(instructions).toContain("check `gh pr view`");
    expect(prompt).toContain("returns a successful background run identifier");
    expect(prompt).toContain("Never say or imply that monitoring is active after a failed launch");
    for (const managedFile of [agent, forkWorker, helper, prompt]) {
      expect(managedFile).not.toMatch(/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/);
      expect(managedFile).not.toMatch(/(?:GH|GITHUB|TOGETHER)_TOKEN\s*=/);
    }
  });

  it("installs nested managed skills without replacing user-owned skill state", async () => {
    const [entrypoint, skill] = await Promise.all([
      readFile(resolve(repoRoot, "docker", "railway-entrypoint"), "utf8"),
      readFile(resolve(repoRoot, "deploy", "pi-profile", "skills", "linearis", "SKILL.md"), "utf8"),
    ]);

    expect(entrypoint).toContain('if [[ -d "$managed_profile_dir/skills" ]]');
    expect(entrypoint).toContain('managed_relative_file="${managed_source_file#"$managed_profile_dir/"}"');
    expect(entrypoint).toContain('find "$managed_profile_dir/skills" -type f -print0');
    expect(entrypoint).not.toContain('rm -rf -- "$agent_dir/skills"');
    expect(skill).toContain("name: linearis");
    expect(skill).toContain("linearis usage");
    expect(skill).not.toMatch(/LINEAR_API_TOKEN\s*=/);
  });
});
