/**
 * Synchronized release script for the pi-atlas package family.
 *
 * All pi-atlas packages share ONE version number. This script:
 *   1. Verifies every package's version matches the root version.
 *   2. Bumps all package.json files to the next version.
 *   3. Publishes in dependency order:
 *        @pi-atlas/shared → (@pi-atlas/base, @pi-atlas/ask, @pi-atlas/extend) → pi-atlas (meta)
 *   4. Tags the release as v<version>.
 *
 * Usage:
 *   tsx scripts/release.ts            # version check + publish (no bump)
 *   tsx scripts/release.ts patch      # bump patch, then publish
 *   tsx scripts/release.ts minor
 *   tsx scripts/release.ts major
 *   tsx scripts/release.ts 0.3.0      # explicit version
 *   tsx scripts/release.ts --dry-run  # preview only: versions + publish plan, no publish
 *
 * Requires npm login / a valid .npmrc token for the target registry.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["shared", "base", "ask", "extend"];

/** Publish order: dependencies first, meta (root) last. */
const PUBLISH_ORDER = [
  { dir: join(ROOT, "packages", "shared") },
  { dir: join(ROOT, "packages", "base") },
  { dir: join(ROOT, "packages", "ask") },
  { dir: join(ROOT, "packages", "extend") },
  { dir: ROOT },
];

function readVersion(pkgDir: string): string {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
  return pkg.version;
}

function writeVersion(pkgDir: string, version: string): void {
  const pkgPath = join(pkgDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function bumpVersion(current: string, spec: string): string {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [major, minor, patch] = current.split(".").map(Number);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump spec: ${spec} (use patch|minor|major|X.Y.Z)`);
}

function run(cmd: string, cwd: string): void {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const spec = (args.find((a) => a !== "--dry-run") ?? "check") as string;

// 1. Verify all versions are in sync.
const versions = new Set<string>([readVersion(ROOT)]);
for (const p of PACKAGES) versions.add(readVersion(join(ROOT, "packages", p)));
if (versions.size !== 1) {
  console.error(
    "Version mismatch between packages:",
    [...versions].join(", "),
    "— bump all packages together (or fix manually).",
  );
  process.exit(1);
}
const current = readVersion(ROOT);

// 2. Bump if requested.
let next = current;
if (spec !== "check") {
  next = bumpVersion(current, spec);
  if (dryRun) {
    console.log(`[dry-run] would bump ${current} → ${next}`);
  } else {
    console.log(`Bumping ${current} → ${next}`);
    writeVersion(ROOT, next);
    for (const p of PACKAGES) writeVersion(join(ROOT, "packages", p), next);
    // Keep the lockfile in sync with the new version.
    run(`npm install --package-lock-only`, ROOT);
  }
} else {
  console.log(`Versions in sync at ${current}. Use \`tsx scripts/release.ts patch|minor|major\` to bump.`);
}

// 3. Publish in dependency order.
if (dryRun) {
  console.log("[dry-run] publish plan:");
  for (const { dir } of PUBLISH_ORDER) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    console.log(`  npm publish  →  ${pkg.name}@${next}`);
  }
  console.log(`[dry-run] tag: ${next !== current ? `v${next}` : "(no version change — no tag)"}`);
  process.exit(0);
}
for (const { dir } of PUBLISH_ORDER) {
  run(`npm publish`, dir);
}

// 4. Tag the release.
if (next !== current) {
  run(`git tag v${next}`, ROOT);
  console.log(`\nTagged v${next}. Don't forget: git push origin main --tags`);
}
