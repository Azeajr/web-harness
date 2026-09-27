import { directoryDigest } from "./core.mjs";

// web-harness digest DIR [--expect SHA]
// Prints the content digest of a build; with --expect, fails unless it matches. CI records the
// digest of the artifact the checks produced and the deploy verifies it before shipping.
export async function main(argv) {
  const [dir, flag, expected] = argv;
  if (!dir) throw new Error("digest requires a directory.");
  const actual = await directoryDigest(dir);
  if (flag === "--expect") {
    if (!/^[0-9a-f]{64}$/.test(expected ?? "")) throw new Error("--expect needs a sha256 digest.");
    if (actual !== expected)
      throw new Error(`Build digest mismatch: expected ${expected}, found ${actual}.`);
  } else if (flag) throw new Error(`Unknown option: ${flag}`);
  console.log(actual);
}
