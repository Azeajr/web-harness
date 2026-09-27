import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ownVersion } from "./versions.mjs";

// web-harness skill install [--dir .claude/skills | .agents/skills]
// web-harness skill show
//
// The package ships one generic agent skill (skills/web-harness/SKILL.md): when to use the
// harness, the loop, what each command proves, the evidence rules and the proof boundaries. A
// project installs a copy — not a symlink, node_modules paths move — stamped with the version it
// came from, so doctor can say when the installed copy is older than the package.

export const SKILL_SOURCE = new URL("../skills/web-harness/SKILL.md", import.meta.url);
export const SKILL_DIRECTORIES = [".claude/skills", ".agents/skills"];
const STAMP = /^<!-- web-harness (\d+\.\d+\.\d+): installed by `web-harness skill install`/m;

export const readSkill = () => readFile(SKILL_SOURCE, "utf8");

// The stamp goes after the frontmatter, which must stay first for the skill to load.
export function stampSkill(text, version) {
  const stamp = `<!-- web-harness ${version}: installed by \`web-harness skill install\`; reinstall after upgrading, do not edit. -->\n`;
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 4) : -1;
  if (end < 0) return stamp + text;
  const split = end + "\n---\n".length;
  return `${text.slice(0, split)}${stamp}${text.slice(split)}`;
}

export const stampedVersion = (text) => text.match(STAMP)?.[1] ?? null;

// Every installed copy under the project, and whether it is the package's version.
export async function installedSkills(root, version = ownVersion) {
  const found = [];
  for (const directory of SKILL_DIRECTORIES) {
    const file = path.join(directory, "web-harness/SKILL.md");
    const text = await readFile(path.join(root, file), "utf8").catch(() => null);
    if (text === null) continue;
    const installed = stampedVersion(text);
    found.push({ file, version: installed, ok: installed === version });
  }
  return found;
}

export function describeSkillDrift(skills, version = ownVersion) {
  return skills
    .filter((skill) => !skill.ok)
    .map((skill) =>
      skill.version
        ? `${skill.file} is from web-harness ${skill.version}; the package is ${version}. Run \`web-harness skill install --dir ${path.dirname(path.dirname(skill.file))}\`.`
        : `${skill.file} has no web-harness version stamp; reinstall it with \`web-harness skill install\`.`,
    );
}

// Every `web-harness <command>` the skill names, for the test that keeps it in step with the CLI.
export function mentionedCommands(text) {
  return [...new Set([...text.matchAll(/web-harness (?:--\S+ \S+ )?([a-z][a-z0-9-]*)/g)].map((match) => match[1]))];
}

export async function main(argv, { root = process.cwd() } = {}) {
  const [action = "show", ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { dir: { type: "string" } }, strict: true });
  if (action === "show") return void process.stdout.write(await readSkill());
  if (action !== "install") throw new Error("Usage: web-harness skill install [--dir .claude/skills] | skill show");
  const directory = values.dir ?? SKILL_DIRECTORIES[0];
  const resolved = path.resolve(root, directory);
  if (path.relative(root, resolved).startsWith(".."))
    throw new Error(`--dir must be inside the project (${root}).`);
  const target = path.join(resolved, "web-harness/SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, stampSkill(await readSkill(), ownVersion));
  console.log(`Installed the web-harness ${ownVersion} skill at ${path.relative(root, target)}.`);
}
