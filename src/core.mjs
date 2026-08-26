import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value) {
  return sha256(stableStringify(value));
}

export async function readJson(path) {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`);
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

export function assertString(value, label, { max = 500, pattern } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  if (value.length > max) throw new Error(`${label} must be at most ${max} characters.`);
  if (pattern && !pattern.test(value)) throw new Error(`${label} has an invalid format.`);
  return value.trim();
}

export function assertNumber(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  if (integer && !Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return value;
}

export function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
