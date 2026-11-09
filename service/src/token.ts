import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function loadOrCreateToken(tokenPath: string): Promise<string> {
  await mkdir(path.dirname(tokenPath), { recursive: true });
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (token.length < 32) throw new Error(`Token file is invalid: ${tokenPath}`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, { flag: "wx", mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return (await readFile(tokenPath, "utf8")).trim();
}

export function tokenMatches(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}
