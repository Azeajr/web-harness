import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// A consumer pins one web-harness tag twice: the package dependency and every `uses:` of the
// composite actions. They are released together and must move together; a workflow still on an
// older tag runs actions that disagree with the installed CLI.

export const ownVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

const USES = /Azeajr\/web-harness\/\.github\/(?:actions\/[\w-]+|workflows\/[\w.-]+)@v(\d+\.\d+\.\d+)/g;

// Pure: every pinned reference in the given workflow texts, and the ones not on `version`.
export function workflowReferences(files, version) {
  const references = [];
  for (const [file, text] of Object.entries(files))
    for (const [index, line] of text.split("\n").entries())
      for (const match of line.matchAll(USES))
        references.push({ file, line: index + 1, version: match[1], ok: match[1] === version });
  return { version, references, mismatches: references.filter((reference) => !reference.ok) };
}

export async function versionDrift(root, version = ownVersion) {
  const directory = path.join(root, ".github/workflows");
  const files = {};
  let names = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const name of names.filter((file) => /\.ya?ml$/.test(file)))
    files[path.join(".github/workflows", name)] = await readFile(path.join(directory, name), "utf8");
  return workflowReferences(files, version);
}

export function describeDrift(drift) {
  return drift.mismatches.map(
    (reference) =>
      `${reference.file}:${reference.line} uses web-harness v${reference.version}; the installed package is v${drift.version}. Bump the dependency and every uses: together.`,
  );
}
