#!/usr/bin/env node
// Release helpers for this repository (not shipped to consumers).
//
//   node scripts/release.mjs bump <X.Y.Z>          set package.json and every pinned @v / #v
//   node scripts/release.mjs version-only <a> <b>  print "true" when a..b changes only versions
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;
// Every place a release version appears: the package version and tag pins in workflows and docs.
const PINS = /(Azeajr\/web-harness(?:\/[\w./-]+)?[@#]v)\d+\.\d+\.\d+/g;
const PACKAGE_VERSION = /^(\s*"version":\s*")\d+\.\d+\.\d+(")/m;

export function normalize(text) {
  return text.replace(PINS, "$1X").replace(PACKAGE_VERSION, "$1X$2");
}

export function bumpText(text, version) {
  return text.replace(PINS, `$1${version}`).replace(PACKAGE_VERSION, `$1${version}$2`);
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });

async function bump(version, root) {
  if (!SEMVER.test(version ?? "")) throw new Error("usage: bump <X.Y.Z>");
  const changed = [];
  for (const file of git(["ls-files", "-z"], root).split("\0").filter(Boolean)) {
    if (!/\.(md|ya?ml|json)$/.test(file) || /lock/.test(file)) continue;
    const full = `${root}/${file}`;
    const before = await readFile(full, "utf8");
    const after = file === "package.json" ? bumpText(before, version) : before.replace(PINS, `$1${version}`);
    if (after !== before) {
      await writeFile(full, after);
      changed.push(file);
    }
  }
  console.log(`v${version}: updated ${changed.join(", ") || "nothing"}`);
}

// True only when every changed file differs from its base solely in version strings.
function versionOnly(base, head, root) {
  const files = git(["diff", "--name-only", base, head], root).split("\n").filter(Boolean);
  if (files.length === 0) return false;
  return files.every((file) => {
    const show = (ref) => {
      try {
        return git(["show", `${ref}:${file}`], root);
      } catch {
        return null; // added or deleted
      }
    };
    const a = show(base);
    const b = show(head);
    return a !== null && b !== null && normalize(a) === normalize(b);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const [command, ...args] = process.argv.slice(2);
  if (command === "bump") await bump(args[0], root);
  else if (command === "version-only") console.log(String(versionOnly(args[0], args[1], root)));
  else {
    console.error("usage: release.mjs bump <X.Y.Z> | version-only <base> <head>");
    process.exit(2);
  }
}
