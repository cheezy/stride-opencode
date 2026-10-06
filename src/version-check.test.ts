/**
 * (W2302) Tests for the stale-install notice.
 *
 * Every lookup here goes through a stub passed in as `fetch`; none of these
 * tests can reach the network. The plugin-level tests at the bottom switch the
 * check on explicitly (src/index.test.ts switches it off for its own file) and
 * inject both the fetch and the package.json reader.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

import {
  LATEST_RELEASE_URL,
  VERSION_CHECK_ENV,
  VERSION_NOTICE_PREFIX,
  buildStaleWarning,
  checkPluginCurrent,
  compareVersions,
  fetchLatestPublishedVersion,
  parseStrictVersion,
  readInstalledVersion,
  versionCheckEnabled,
} from "./version-check";
import { StridePlugin, hasTextOutput, isStrideApiCall } from "./index";

type Call = { url: string; init?: RequestInit };

function stubFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function release(tag: unknown, status = 200): Response {
  return new Response(JSON.stringify({ tag_name: tag }), { status });
}

function pkg(version: unknown, name: unknown = "opencode-stride"): () => string {
  return () => JSON.stringify({ name, version });
}

// A fetch that only settles when its signal aborts (or never, if it has none).
function hangingFetch(): typeof globalThis.fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(new Error("aborted"));
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof globalThis.fetch;
}

describe("parseStrictVersion", () => {
  it("accepts plain MAJOR.MINOR.PATCH", () => {
    expect(parseStrictVersion("1.39.0")).toEqual([1, 39, 0]);
    expect(parseStrictVersion("0.0.0")).toEqual([0, 0, 0]);
  });

  it("refuses everything outside the strict shape", () => {
    for (const bad of [
      "v1.39.0",
      "1.39",
      "1.39.0.1",
      "1.40.0-rc.1",
      "1.40.0+build.5",
      " 1.39.0",
      "1.39.0\n",
      "01.39.0",
      "1234567890.0.0",
      "",
      "latest",
    ]) {
      expect(parseStrictVersion(bad)).toBeNull();
    }
    expect(parseStrictVersion(1.39)).toBeNull();
    expect(parseStrictVersion(null)).toBeNull();
    expect(parseStrictVersion(undefined)).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares numerically, part by part", () => {
    expect(compareVersions([1, 40, 0], [1, 9, 0])).toBe(1);
    expect(compareVersions([1, 39, 0], [1, 40, 0])).toBe(-1);
    expect(compareVersions([1, 39, 0], [1, 39, 0])).toBe(0);
    expect(compareVersions([2, 0, 0], [1, 99, 99])).toBe(1);
    expect(compareVersions([1, 39, 1], [1, 39, 10])).toBe(-1);
  });
});

describe("readInstalledVersion", () => {
  it("reads a strict version from this plugin's package.json", () => {
    expect(readInstalledVersion(pkg("1.39.0"))).toEqual([1, 39, 0]);
  });

  it("with no reader, resolves the real package.json beside src/", () => {
    const real = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(readInstalledVersion()).toEqual(parseStrictVersion(real.version));
    expect(readInstalledVersion()).not.toBeNull();
  });

  it("returns null rather than guessing", () => {
    expect(
      readInstalledVersion(() => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    expect(readInstalledVersion(() => "{not json")).toBeNull();
    expect(readInstalledVersion(() => "null")).toBeNull();
    expect(readInstalledVersion(() => "5")).toBeNull();
    expect(readInstalledVersion(pkg(undefined))).toBeNull();
    expect(readInstalledVersion(pkg("1.40.0-beta.1"))).toBeNull();
    expect(readInstalledVersion(pkg("1.39.0", "some-other-package"))).toBeNull();
  });
});

describe("fetchLatestPublishedVersion", () => {
  it("reads the release tag from the one fixed URL, without credentials", async () => {
    const { fetch, calls } = stubFetch(() => release("v1.40.0"));
    expect(await fetchLatestPublishedVersion({ fetch })).toEqual([1, 40, 0]);
    expect(calls.map((c) => c.url)).toEqual([LATEST_RELEASE_URL]);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("accepts a tag without the leading v", async () => {
    const { fetch } = stubFetch(() => release("1.40.0"));
    expect(await fetchLatestPublishedVersion({ fetch })).toEqual([1, 40, 0]);
  });

  it("is null on a non-2xx status, including a 403 rate limit", async () => {
    for (const status of [403, 404, 500]) {
      const { fetch } = stubFetch(() => release("v1.40.0", status));
      expect(await fetchLatestPublishedVersion({ fetch })).toBeNull();
    }
  });

  it("is null when fetch rejects or the body is not JSON", async () => {
    const rejecting = stubFetch(() => {
      throw new Error("offline");
    });
    expect(await fetchLatestPublishedVersion({ fetch: rejecting.fetch })).toBeNull();
    const garbage = stubFetch(() => new Response("<html>", { status: 200 }));
    expect(await fetchLatestPublishedVersion({ fetch: garbage.fetch })).toBeNull();
  });

  it("is null when the body is JSON null or a bare value, or fetch resolves nothing", async () => {
    for (const body of ["null", "5", "\"v1.40.0\""]) {
      const { fetch } = stubFetch(() => new Response(body, { status: 200 }));
      expect(await fetchLatestPublishedVersion({ fetch })).toBeNull();
    }
    const empty = stubFetch(() => undefined as unknown as Response);
    expect(await fetchLatestPublishedVersion({ fetch: empty.fetch })).toBeNull();
  });

  it("is null when the tag is missing or not strictly numeric", async () => {
    for (const tag of [undefined, 1.4, "v1.40.0-beta", "latest", "v1.40.0\nINJECT", "vv1.40.0"]) {
      const { fetch } = stubFetch(() => release(tag));
      expect(await fetchLatestPublishedVersion({ fetch })).toBeNull();
    }
  });

  it("is null on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await fetchLatestPublishedVersion({ fetch: hangingFetch(), signal: controller.signal }),
    ).toBeNull();
  });
});

describe("buildStaleWarning", () => {
  it("is one line naming both versions, the pin and the re-copy", () => {
    const line = buildStaleWarning([1, 0, 0], [1, 40, 0]);
    expect(line.startsWith(VERSION_NOTICE_PREFIX)).toBe(true);
    expect(line).toContain("1.0.0");
    expect(line).toContain("v1.40.0");
    expect(line).toContain("github:cheezy/stride-opencode#v1.40.0");
    expect(line).toContain("skills/");
    expect(line).toContain("agents/");
    expect(line).toContain("pin");
    expect(line).not.toContain("\n");
  });
});

describe("checkPluginCurrent", () => {
  it("warns when the install is older than the latest release", async () => {
    const { fetch } = stubFetch(() => release("v1.40.0"));
    const line = await checkPluginCurrent({ fetch, readPackageJson: pkg("1.39.0") });
    expect(line).toBe(buildStaleWarning([1, 39, 0], [1, 40, 0]));
  });

  it("compares numerically, not as strings (1.9.0 is older than 1.10.0)", async () => {
    const { fetch } = stubFetch(() => release("v1.10.0"));
    expect(await checkPluginCurrent({ fetch, readPackageJson: pkg("1.9.0") })).not.toBeNull();
  });

  it("is silent when current or newer (a local dev checkout)", async () => {
    const { fetch } = stubFetch(() => release("v1.39.0"));
    expect(await checkPluginCurrent({ fetch, readPackageJson: pkg("1.39.0") })).toBeNull();
    expect(await checkPluginCurrent({ fetch, readPackageJson: pkg("1.40.0") })).toBeNull();
  });

  it("never fetches when the installed version is unknown", async () => {
    const { fetch, calls } = stubFetch(() => release("v9.9.9"));
    expect(
      await checkPluginCurrent({ fetch, readPackageJson: () => "{}" }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("is silent when the latest release is unknown", async () => {
    const { fetch } = stubFetch(() => release("v1.40.0", 403));
    expect(await checkPluginCurrent({ fetch, readPackageJson: pkg("1.0.0") })).toBeNull();
  });

  it("never throws, even when fetch throws synchronously", async () => {
    const fetch = (() => {
      throw new Error("boom");
    }) as unknown as typeof globalThis.fetch;
    expect(await checkPluginCurrent({ fetch, readPackageJson: pkg("1.0.0") })).toBeNull();
  });

  it("honours a caller-supplied signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    expect(
      await checkPluginCurrent({
        fetch: hangingFetch(),
        readPackageJson: pkg("1.0.0"),
        signal: controller.signal,
        timeoutMs: 2_000,
      }),
    ).toBeNull();
    // Ignoring the caller's signal would wait out the 2 s deadline instead.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("gives up at the timeout when the endpoint never answers", async () => {
    const started = Date.now();
    const line = await checkPluginCurrent({
      fetch: hangingFetch(),
      readPackageJson: pkg("1.0.0"),
      timeoutMs: 20,
    });
    expect(line).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("gives up at the timeout even when fetch ignores its abort signal", async () => {
    const deaf = (() => new Promise(() => {})) as unknown as typeof globalThis.fetch;
    const started = Date.now();
    expect(
      await checkPluginCurrent({ fetch: deaf, readPackageJson: pkg("1.0.0"), timeoutMs: 20 }),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("carrier helpers", () => {
  it("treats every Stride API call as a reply the notice must not ride on", () => {
    for (const command of [
      "curl -sS $STRIDE_API_URL/api/tasks/next?response_view=slim",
      "curl -X POST https://example.test/api/tasks/claim -d '{}'",
      "curl -X PATCH https://example.test/api/tasks/7268 -d @p.json",
      "curl -X POST https://example.test/api/tasks/batch -d @b.json",
      "curl https://example.test/api/agent/onboarding",
    ]) {
      expect(isStrideApiCall({ tool: "bash", args: { command } })).toBe(true);
      expect(isStrideApiCall({ input: { command } })).toBe(true);
    }
    for (const command of ["ls -la", "bun test", "curl https://example.test/api/tasksforce"]) {
      expect(isStrideApiCall({ tool: "bash", args: { command } })).toBe(false);
    }
    expect(isStrideApiCall(undefined)).toBe(false);
    expect(isStrideApiCall({ tool: "read", args: {} })).toBe(false);
  });

  it("accepts only a string output as a carrier", () => {
    expect(hasTextOutput({ title: "t", output: "x", metadata: {} })).toBe(true);
    expect(hasTextOutput({ content: [] })).toBe(false);
    expect(hasTextOutput({ output: 5 })).toBe(false);
    expect(hasTextOutput(null)).toBe(false);
    expect(hasTextOutput("x")).toBe(false);
  });
});

describe("versionCheckEnabled", () => {
  it("is on unless explicitly switched off", () => {
    expect(versionCheckEnabled({})).toBe(true);
    expect(versionCheckEnabled({ [VERSION_CHECK_ENV]: "" })).toBe(true);
    expect(versionCheckEnabled({ [VERSION_CHECK_ENV]: "1" })).toBe(true);
    for (const off of ["0", "false", "OFF", " no "]) {
      expect(versionCheckEnabled({ [VERSION_CHECK_ENV]: off })).toBe(false);
    }
  });
});

// --- Plugin wiring ---

describe("plugin: stale-install notice", () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stride-oc-version-"));
    savedEnv = process.env[VERSION_CHECK_ENV];
    process.env[VERSION_CHECK_ENV] = "1";
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[VERSION_CHECK_ENV];
    else process.env[VERSION_CHECK_ENV] = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  type After = (i: unknown, o: unknown) => Promise<void>;

  async function instantiate(versionCheck: Record<string, unknown>): Promise<After> {
    const hooks = (await StridePlugin({
      directory: dir,
      worktree: dir,
      $,
      versionCheck,
    } as never)) as unknown as { "tool.execute.after": After };
    return hooks["tool.execute.after"];
  }

  const bash = (command: string) => ({ tool: "bash", sessionID: "s", callID: "c", args: { command } });
  const result = (text: string) => ({ title: "t", output: text, metadata: {} });
  const count = (texts: string[]) =>
    texts.join("\n").split(VERSION_NOTICE_PREFIX).length - 1;

  it("an older install surfaces exactly one line across the session", async () => {
    const { fetch } = stubFetch(() => release("v9.9.9"));
    const after = await instantiate({ fetch, readPackageJson: pkg("1.0.0") });
    await Bun.sleep(20);
    const first = result("ls output");
    const second = result("more output");
    await after(bash("ls"), first);
    await after(bash("ls -la"), second);
    expect(first.output.startsWith("ls output\n\n")).toBe(true);
    expect(count([first.output, second.output])).toBe(1);
    expect(second.output).toBe("more output");
  });

  it("never rides on a Stride API reply; it waits for the next ordinary result", async () => {
    const { fetch } = stubFetch(() => release("v9.9.9"));
    const after = await instantiate({ fetch, readPackageJson: pkg("1.0.0") });
    await Bun.sleep(20);
    const claimReply = result("{\"error\":\"nope\"}");
    await after(
      bash("curl -X POST http://localhost/api/tasks/claim -d '{}'"),
      claimReply,
    );
    expect(claimReply.output).toBe("{\"error\":\"nope\"}");
    const next = result("ok");
    await after(bash("pwd"), next);
    expect(count([next.output])).toBe(1);
  });

  it("skips a GET /api/tasks/next reply too, not only the hook-firing calls", async () => {
    const { fetch } = stubFetch(() => release("v9.9.9"));
    const after = await instantiate({ fetch, readPackageJson: pkg("1.0.0") });
    await Bun.sleep(20);
    const nextReply = result("{\"data\":{\"identifier\":\"W1\"}}");
    await after(bash("curl -sS http://localhost/api/tasks/next?response_view=slim"), nextReply);
    expect(nextReply.output).toBe("{\"data\":{\"identifier\":\"W1\"}}");
    const next = result("ok");
    await after(bash("pwd"), next);
    expect(count([next.output])).toBe(1);
  });

  it("leaves a non-string output alone and defers the line", async () => {
    const { fetch } = stubFetch(() => release("v9.9.9"));
    const after = await instantiate({ fetch, readPackageJson: pkg("1.0.0") });
    await Bun.sleep(20);
    const mcp = { content: [{ type: "text", text: "x" }] };
    await after({ tool: "mcp_x", args: {} }, mcp);
    expect(mcp).toEqual({ content: [{ type: "text", text: "x" }] });
    const next = result("ok");
    await after(bash("pwd"), next);
    expect(count([next.output])).toBe(1);
  });

  it("current, newer and unknown installs add nothing", async () => {
    for (const [installed, tag] of [
      ["1.39.0", "v1.39.0"],
      ["2.0.0", "v1.39.0"],
      ["1.0.0", "v1.40.0-rc.1"],
    ]) {
      const { fetch } = stubFetch(() => release(tag));
      const after = await instantiate({ fetch, readPackageJson: pkg(installed) });
      await Bun.sleep(20);
      const out = result("plain");
      await after(bash("ls"), out);
      expect(out.output).toBe("plain");
    }
  });

  it("does not delay a tool call while the lookup is still pending", async () => {
    const after = await instantiate({
      fetch: hangingFetch(),
      readPackageJson: pkg("1.0.0"),
      timeoutMs: 5_000,
    });
    const out = result("plain");
    const started = Date.now();
    await after(bash("ls"), out);
    expect(Date.now() - started).toBeLessThan(500);
    expect(out.output).toBe("plain");
  });

  it("switched off, the lookup never runs", async () => {
    process.env[VERSION_CHECK_ENV] = "0";
    const { fetch, calls } = stubFetch(() => release("v9.9.9"));
    const after = await instantiate({ fetch, readPackageJson: pkg("1.0.0") });
    await Bun.sleep(20);
    const out = result("plain");
    await after(bash("ls"), out);
    expect(calls).toEqual([]);
    expect(out.output).toBe("plain");
  });
});
