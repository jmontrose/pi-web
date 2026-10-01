import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function managedEntries(manifest) {
  if (!Array.isArray(manifest.packages)) throw new Error("Managed Pi profile packages must be an array");
  return manifest.packages.map((value, index) => {
    const entry = object(value, `Managed Pi profile package ${index}`);
    for (const key of ["name", "runtimeSource"]) {
      if (typeof entry[key] !== "string" || entry[key].trim() === "") {
        throw new Error(`Managed Pi profile package ${index}.${key} must be a non-empty string`);
      }
    }
    return entry;
  });
}

function configuredSource(value) {
  if (typeof value === "string") return value;
  if (value !== null && !Array.isArray(value) && typeof value === "object" && typeof value.source === "string") {
    return value.source;
  }
  return undefined;
}

function npmPackageName(source) {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice(4);
  if (!spec.startsWith("@")) return spec.split("@", 1)[0];
  const versionSeparator = spec.indexOf("@", spec.indexOf("/") + 1);
  return versionSeparator === -1 ? spec : spec.slice(0, versionSeparator);
}

export function mergeManagedPiPackages(settingsValue, manifestValue) {
  const settings = object(settingsValue, "Pi settings");
  const entries = managedEntries(object(manifestValue, "Managed Pi profile manifest"));
  const managedNames = new Set(entries.map((entry) => entry.name));
  const runtimeNames = new Map(entries.map((entry) => [entry.runtimeSource, entry.name]));
  const configuredPackages = Array.isArray(settings.packages) ? settings.packages : [];
  const packages = configuredPackages.filter((configured) => {
    const source = configuredSource(configured);
    if (source === undefined) return true;
    const name = npmPackageName(source) ?? runtimeNames.get(source);
    return name === undefined || !managedNames.has(name);
  });
  packages.push(...entries.map((entry) => entry.runtimeSource));
  return { ...settings, packages };
}

export function mergeManagedPiProfileFile(manifestFile, settingsFile) {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const settings = existsSync(settingsFile)
    ? JSON.parse(readFileSync(settingsFile, "utf8"))
    : {};
  const merged = mergeManagedPiPackages(settings, manifest);
  const temporary = `${settingsFile}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, settingsFile);
  chmodSync(settingsFile, 0o600);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestFile, settingsFile] = process.argv.slice(2);
  if (manifestFile === undefined || settingsFile === undefined) {
    throw new Error("Usage: merge-managed-pi-profile.mjs <packages.json> <settings.json>");
  }
  mergeManagedPiProfileFile(manifestFile, settingsFile);
}
