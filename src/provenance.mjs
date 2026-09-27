import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Which code produced a piece of evidence: the commit, and — when the tree has uncommitted work — a
// digest of exactly that work, so two runs from "the same commit" with different edits are told
// apart. `git status` text says which files changed; the digest says what they contain.

function git(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ${args[0]} failed (${code})`)),
    );
  });
}

export async function sourceIdentity(root) {
  try {
    const commit = (await git(root, ["rev-parse", "HEAD"])).toString().trim();
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toString().trim();
    const diff = await git(root, ["diff", "HEAD", "--binary"]);
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .toString()
      .split("\0")
      .filter(Boolean)
      .sort();
    const dirty = diff.length > 0 || untracked.length > 0;
    let dirtyDigest = null;
    if (dirty) {
      const hash = createHash("sha256").update(diff);
      for (const file of untracked) {
        const bytes = await readFile(path.join(root, file)).catch(() => Buffer.alloc(0));
        hash.update(`\0${file}\0${createHash("sha256").update(bytes).digest("hex")}`);
      }
      dirtyDigest = hash.digest("hex");
    }
    return { commit, branch, dirty, dirtyDigest, untracked: untracked.length };
  } catch {
    return { commit: null, branch: null, dirty: null, dirtyDigest: null, untracked: null };
  }
}
