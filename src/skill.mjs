import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ownVersion } from "./versions.mjs";

export const usage = `Usage: web-harness skill install [--dir DIR]...
       web-harness skill [show]
  install    Copy the shipped agent skill, stamped with this version, into .claude/skills and
             every other agent skills directory the project has (.agents/skills)
  --dir DIR  Install into DIR (inside the project) instead (repeatable)
  show       Print the skill (the default)`;

// The package ships one generic agent skill (skills/web-harness/SKILL.md): when to use the
// harness, the loop, what each command proves, the evidence rules and the proof boundaries. A
// project installs a copy — not a symlink, node_modules paths move — stamped with the version it
// came from, so doctor can say when the installed copy is older than the package.
//
// Claude Code loads project skills from .claude/skills alone; Codex and the other agents that
// follow the Agent Skills layout read .agents/skills. A bare install writes every directory an
// agent in this project will read, so one command after an upgrade refreshes every copy.

export const SKILL_SOURCE = new URL("../skills/web-harness/SKILL.md", import.meta.url);
export const SKILL_DIRECTORIES = [".claude/skills", ".agents/skills"];
const CLAUDE_SKILLS = SKILL_DIRECTORIES[0];
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
        ? `${skill.file} is from web-harness ${skill.version}; the package is ${version}. Run \`web-harness skill install\`.`
        : `${skill.file} has no web-harness version stamp; reinstall it with \`web-harness skill install\`.`,
    );
}

const exists = (file) => stat(file).then(() => true, () => false);

// .claude/skills always, since Claude Code reads nowhere else, and every other agent directory
// whose parent the project already has (.agents/ means some agent reads .agents/skills).
export async function installTargets(root) {
  const targets = [];
  for (const directory of SKILL_DIRECTORIES)
    if (directory === CLAUDE_SKILLS || (await exists(path.join(root, path.dirname(directory)))))
      targets.push(directory);
  return targets;
}

// A project with .claude/ uses Claude Code, which cannot see a copy that is only elsewhere.
export async function describeSkillReach(root, skills) {
  if (!skills.length || skills.some((skill) => skill.file.startsWith(`${CLAUDE_SKILLS}/`))) return [];
  if (!(await exists(path.join(root, path.dirname(CLAUDE_SKILLS))))) return [];
  return [
    `the web-harness skill is installed only at ${skills.map((skill) => skill.file).join(", ")}; Claude Code loads project skills from ${CLAUDE_SKILLS} alone. Run \`web-harness skill install\`.`,
  ];
}

// Every `web-harness <command>` the skill names, for the test that keeps it in step with the CLI.
export function mentionedCommands(text) {
  return [...new Set([...text.matchAll(/web-harness (?:--\S+ \S+ )?([a-z][a-z0-9-]*)/g)].map((match) => match[1]))];
}

export async function main(argv, { root = process.cwd() } = {}) {
  const [action = "show", ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { dir: { type: "string", multiple: true } }, strict: true });
  if (action === "show") return void process.stdout.write(await readSkill());
  if (action !== "install") throw new Error(usage);
  const directories = (values.dir ?? (await installTargets(root))).map((directory) => {
    const relative = path.relative(root, path.resolve(root, directory));
    if (relative.startsWith("..")) throw new Error(`--dir must be inside the project (${root}).`);
    return relative;
  });
  const text = stampSkill(await readSkill(), ownVersion);
  const targets = [];
  for (const directory of new Set(directories)) {
    const target = path.join(directory, "web-harness/SKILL.md");
    await mkdir(path.join(root, path.dirname(target)), { recursive: true });
    await writeFile(path.join(root, target), text);
    targets.push(target);
  }
  console.log(`Installed the web-harness ${ownVersion} skill at ${targets.join(", ")}.`);
  if (!directories.includes(CLAUDE_SKILLS))
    console.error(`note: Claude Code loads project skills from ${CLAUDE_SKILLS} alone; add --dir ${CLAUDE_SKILLS} if it works in this project.`);
}
