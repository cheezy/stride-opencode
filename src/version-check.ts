/**
 * (W2302) Stale-install notice.
 *
 * OpenCode installs this plugin with Bun from `github:cheezy/stride-opencode`
 * (optionally pinned with `#vX.Y.Z`) and keeps that copy in its own cache, so a
 * user can run an old build for weeks without noticing: every fix published
 * since is simply absent. This module compares the version in the installed
 * plugin's own package.json with the newest GitHub release of
 * cheezy/stride-opencode and, only when the install is strictly older, yields
 * one advisory line. Everything else -- equal, newer, unreadable, offline,
 * rate-limited, timed out, oddly shaped -- yields null, and nothing here ever
 * throws.
 *
 * The scope is the plugin package alone. The skills/ and agents/ directories
 * are copied by hand and carry no version marker, so nothing here can tell
 * whether those copies are current, and the line never claims to.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The one source consulted. Fixed: no part of it comes from config or the task. */
export const LATEST_RELEASE_URL =
  "https://api.github.com/repos/cheezy/stride-opencode/releases/latest";

/** The package name this plugin publishes under; a different name is not us. */
export const PLUGIN_PACKAGE_NAME = "opencode-stride";

/** Upper bound on the whole lookup. Session start is never held longer. */
export const VERSION_CHECK_TIMEOUT_MS = 3_000;

/** Opt-out switch (offline machines, privacy, the test suite). Default on. */
export const VERSION_CHECK_ENV = "STRIDE_OPENCODE_VERSION_CHECK";

/** Prefix every notice starts with, so the agent can recognise it. */
export const VERSION_NOTICE_PREFIX = "[stride-opencode] Plugin update available";

export type Version = [number, number, number];

/**
 * The check runs unless the operator explicitly turns it off. Only these
 * spellings disable it; anything else, including an empty value, leaves it on.
 */
export function versionCheckEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[VERSION_CHECK_ENV];
  if (typeof raw !== "string") return true;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

// Three dot-separated integers and nothing else. No leading zeros, no
// pre-release or build suffix, no whitespace, at most nine digits per part so
// every part stays a safe integer. A fetched body is untrusted, so anything
// outside this shape is refused rather than interpreted.
const STRICT_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** Parse a strict `MAJOR.MINOR.PATCH` string, or return null. Never guesses. */
export function parseStrictVersion(value: unknown): Version | null {
  if (typeof value !== "string") return null;
  const match = STRICT_VERSION.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric, part-by-part comparison: -1 when a < b, 0 when equal, 1 when a > b. */
export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

export function versionText(v: Version): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

/** Reads the installed plugin's package.json as text. Injectable for tests. */
export type PackageJsonReader = () => string;

function defaultPackageJsonReader(): string {
  // src/version-check.ts -> ../package.json, which ships beside src/ in every
  // install (package.json is always part of the packed tree).
  return readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
}

/**
 * The version of the plugin that is actually running, from its own
 * package.json. Null when the file cannot be read or parsed, belongs to some
 * other package, or carries a version outside the strict shape.
 */
export function readInstalledVersion(
  readPackageJson: PackageJsonReader = defaultPackageJsonReader,
): Version | null {
  try {
    const parsed: unknown = JSON.parse(readPackageJson());
    if (!parsed || typeof parsed !== "object") return null;
    const { name, version } = parsed as { name?: unknown; version?: unknown };
    if (name !== PLUGIN_PACKAGE_NAME) return null;
    return parseStrictVersion(version);
  } catch {
    return null;
  }
}

/**
 * The newest published release, from `LATEST_RELEASE_URL`. The request
 * carries no credentials and no project data. Any rejection, abort, non-2xx
 * status (a 403 rate limit included), unparsable body or oddly shaped tag
 * yields null.
 */
export async function fetchLatestPublishedVersion(opts: {
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<Version | null> {
  try {
    const response = await opts.fetch(LATEST_RELEASE_URL, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": PLUGIN_PACKAGE_NAME,
      },
      signal: opts.signal,
    });
    if (!response || !response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return null;
    const tag = (body as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string") return null;
    return parseStrictVersion(tag.startsWith("v") ? tag.slice(1) : tag);
  } catch {
    return null;
  }
}

/** The single advisory line. Built only from two already-validated versions. */
export function buildStaleWarning(installed: Version, latest: Version): string {
  const have = versionText(installed);
  const want = versionText(latest);
  return (
    `${VERSION_NOTICE_PREFIX}: this session runs ${PLUGIN_PACKAGE_NAME} ${have}, ` +
    `but release v${want} is out. To update, set the plugin entry in opencode.json ` +
    `to "github:cheezy/stride-opencode#v${want}" (or drop the stale copy from ` +
    `OpenCode's cache) and restart OpenCode, then copy skills/ and agents/ again ` +
    `from v${want}. An install held at an older #v pin on purpose sees this once per run.`
  );
}

/**
 * Compose the pieces. Returns the advisory line only when the installed
 * version is known and strictly older than a known latest release; otherwise
 * null. When the installed version is unknown the network is never touched.
 * Never throws, and never waits longer than `timeoutMs`.
 */
export async function checkPluginCurrent(opts: {
  fetch: typeof globalThis.fetch;
  readPackageJson?: PackageJsonReader;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string | null> {
  try {
    const installed = readInstalledVersion(opts.readPackageJson);
    if (!installed) return null;
    const timeoutMs = opts.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS;
    const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);
    // The abort signal bounds a well-behaved fetch; the timer bounds one that
    // ignores its signal, so the lookup can never outlive the timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    let latest: Version | null;
    try {
      latest = await Promise.race([
        fetchLatestPublishedVersion({ fetch: opts.fetch, signal }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!latest) return null;
    return compareVersions(installed, latest) < 0
      ? buildStaleWarning(installed, latest)
      : null;
  } catch {
    return null;
  }
}
