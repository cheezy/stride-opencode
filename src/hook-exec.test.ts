import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_TIMEOUTS_MS,
  TIMEOUT_EXIT_CODE,
  resolveHookTimeoutMs,
  executeHookCommands,
} from "./hook-exec";

// --- W1495: per-hook timeout enforcement ---

describe("HOOK_TIMEOUTS_MS", () => {
  it("gives after_doing 120s and the other four hooks 60s", () => {
    expect(HOOK_TIMEOUTS_MS.after_doing).toBe(120_000);
    expect(HOOK_TIMEOUTS_MS.before_doing).toBe(60_000);
    expect(HOOK_TIMEOUTS_MS.before_review).toBe(60_000);
    expect(HOOK_TIMEOUTS_MS.after_review).toBe(60_000);
    expect(HOOK_TIMEOUTS_MS.after_goal).toBe(60_000);
  });
});

describe("resolveHookTimeoutMs", () => {
  it("resolves the canonical budgets with no overrides", () => {
    expect(resolveHookTimeoutMs("after_doing")).toBe(120_000);
    expect(resolveHookTimeoutMs("before_review")).toBe(60_000);
  });

  it("prefers an override for the named hook", () => {
    expect(resolveHookTimeoutMs("after_doing", { after_doing: 50 })).toBe(50);
  });

  it("does not leak an override onto other hooks", () => {
    expect(resolveHookTimeoutMs("before_review", { after_doing: 50 })).toBe(
      60_000,
    );
  });
});

describe("executeHookCommands — timeout enforcement", () => {
  let dir: string;
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stride-oc-hookexec-"));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("a fast command under budget succeeds unchanged (no timeout fields on success)", async () => {
    const result = await executeHookCommands("before_doing", ["echo hi"], {
      cwd: dir,
      env,
      budgetMs: 5000,
      killGraceMs: 100,
    });
    expect(result.status).toBe("success");
    expect(result.commands_output).toEqual([
      { command: "echo hi", stdout: "hi\n", stderr: "" },
    ]);
    expect("timed_out" in result).toBe(false);
    expect("budget_ms" in result).toBe(false);
  });

  it("a command sleeping past a tiny budget returns a failed timed-out result", async () => {
    const before = Date.now();
    const result = await executeHookCommands("after_doing", ["sleep 5"], {
      cwd: dir,
      env,
      budgetMs: 150,
      killGraceMs: 100,
    });
    // Terminated by the budget, not by the sleep finishing.
    expect(Date.now() - before).toBeLessThan(2000);
    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(TIMEOUT_EXIT_CODE);
    expect(result.timed_out).toBe(true);
    expect(result.budget_ms).toBe(150);
    expect(result.failed_command).toBe("sleep 5");
    expect(result.command_index).toBe(0);
    expect(result.commands_remaining).toEqual([]);
  });

  it("partial output produced before the timeout is captured", async () => {
    const result = await executeHookCommands(
      "after_doing",
      ["echo partial; sleep 5"],
      { cwd: dir, env, budgetMs: 200, killGraceMs: 100 },
    );
    expect(result.status).toBe("failed");
    expect(result.timed_out).toBe(true);
    expect(result.stdout).toContain("partial");
  });

  it("when the second command times out, the first stays in commands_completed", async () => {
    const result = await executeHookCommands(
      "after_doing",
      ["echo one", "sleep 5"],
      { cwd: dir, env, budgetMs: 300, killGraceMs: 100 },
    );
    expect(result.status).toBe("failed");
    expect(result.command_index).toBe(1);
    expect(result.commands_completed).toEqual(["echo one"]);
    expect(result.timed_out).toBe(true);
  });

  it("a zero remaining budget fails with 124 without spawning the command", async () => {
    const result = await executeHookCommands(
      "before_review",
      ["touch should-not-exist.txt"],
      { cwd: dir, env, budgetMs: 0, killGraceMs: 100 },
    );
    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(TIMEOUT_EXIT_CODE);
    expect(result.timed_out).toBe(true);
    expect(result.stderr).toMatch(
      /budget exhausted before this command started/,
    );
    expect(existsSync(join(dir, "should-not-exist.txt"))).toBe(false);
  });

  it("the killed command's process tree does not linger (grandchild is reaped)", async () => {
    // The background sleep is a grandchild of executeHookCommands' sh; the
    // group kill must reap it too, not just the sh group leader.
    const result = await executeHookCommands(
      "after_doing",
      ["sleep 30 & echo $! > child.pid; sleep 30"],
      { cwd: dir, env, budgetMs: 150, killGraceMs: 100 },
    );
    expect(result.status).toBe("failed");
    expect(result.timed_out).toBe(true);
    const pid = Number(readFileSync(join(dir, "child.pid"), "utf8").trim());
    expect(Number.isInteger(pid)).toBe(true);
    // SIGTERM delivery isn't instantaneous — poll up to ~500ms.
    let alive = true;
    for (let attempt = 0; attempt < 10 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("a SIGTERM-immune command is SIGKILLed after the grace period", async () => {
    const before = Date.now();
    const result = await executeHookCommands(
      "after_doing",
      ["trap '' TERM; while :; do :; done"],
      { cwd: dir, env, budgetMs: 100, killGraceMs: 100 },
    );
    expect(result.status).toBe("failed");
    expect(result.timed_out).toBe(true);
    expect(Date.now() - before).toBeLessThan(2000);
  });

  it("an ordinary failure is not marked timed out", async () => {
    const result = await executeHookCommands("before_doing", ["false"], {
      cwd: dir,
      env,
      budgetMs: 5000,
      killGraceMs: 100,
    });
    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(1);
    expect(result.timed_out).toBe(false);
    expect(result.budget_ms).toBe(5000);
  });
});
