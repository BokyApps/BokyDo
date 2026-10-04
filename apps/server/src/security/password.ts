import { hash, verify } from '@node-rs/argon2';

// `Algorithm` is an ambient const enum, which verbatimModuleSyntax can't import.
const ARGON2ID = 2; // Algorithm.Argon2id

// OWASP Password Storage Cheat Sheet: Argon2id, m=19 MiB, t=2, p=1.
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Malformed hash: treat as a failed verification, never as an error path that skips checks.
    return false;
  }
}
