import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gateSkillActivation,
  gateToolCall,
  MARKER_FRESHNESS_MS,
  MARKER_RELATIVE_PATH,
  PROTECTED_SUB_SKILLS,
  SKILL_ACTIVATION_TOOLS,
} from "./skill-gate";

// Each test uses a fresh temp project directory and an empty env so
// STRIDE_ALLOW_DIRECT doesn't leak between cases.
let projectDir: string;

const NOW = Date.parse("2026-04-29T18:00:00Z");
const FIVE_HOURS_AGO = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
const FRESH = new Date(NOW - 30 * 60 * 1000).toISOString();

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "stride-gate-test-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeMarker(startedAt: string, opts?: { sessionId?: string; pid?: number }): void {
  const dir = join(projectDir, ".stride");
  mkdirSync(dir, { recursive: true });
  const payload = {
    session_id: opts?.sessionId ?? "test-session",
    started_at: startedAt,
    pid: opts?.pid ?? 12345,
  };
  writeFileSync(join(dir, ".orchestrator_active"), JSON.stringify(payload));
}

// --- Scenario 1: marker missing → blocks protected sub-skill ---

describe("scenario 1: marker missing", () => {
  it("blocks a protected sub-skill activation", () => {
    const result = gateSkillActivation({
      skillName: "stride-claiming-tasks",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).not.toBe("allow");
    expect(result).toMatchObject({ decision: "block" });
    if (typeof result === "object") {
      expect(result.reason).toContain("stride:stride-workflow");
      expect(result.reason).toContain("STRIDE_ALLOW_DIRECT");
    }
  });
});

// --- Scenario 2: marker fresh → allows protected sub-skill ---

describe("scenario 2: marker fresh", () => {
  it("allows a protected sub-skill activation when the marker is fresh", () => {
    writeMarker(FRESH);
    const result = gateSkillActivation({
      skillName: "stride-claiming-tasks",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).toBe("allow");
  });

  it("allows up to but not exceeding the 4h freshness boundary", () => {
    const exactlyFourHoursAgo = new Date(NOW - MARKER_FRESHNESS_MS).toISOString();
    writeMarker(exactlyFourHoursAgo);
    const result = gateSkillActivation({
      skillName: "stride-claiming-tasks",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).toBe("allow");
  });
});

// --- Scenario 3: marker stale (>4h) → blocks ---

describe("scenario 3: marker stale", () => {
  it("blocks when the marker is older than 4 hours", () => {
    writeMarker(FIVE_HOURS_AGO);
    const result = gateSkillActivation({
      skillName: "stride-claiming-tasks",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).not.toBe("allow");
    expect(result).toMatchObject({ decision: "block" });
    if (typeof result === "object") {
      expect(result.reason).toContain("stale");
    }
  });

  it("blocks when started_at is in the future (negative age)", () => {
    const futureIso = new Date(NOW + 60_000).toISOString();
    writeMarker(futureIso);
    const result = gateSkillActivation({
      skillName: "stride-claiming-tasks",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).not.toBe("allow");
    expect(result).toMatchObject({ decision: "block" });
  });

  it("blocks when the marker is unparseable JSON", () => {
    mkdirSync(join(projectDir, ".stride"), { recursive: true });
    writeFileSync(join(projectDir, ".stride/.orchestrator_active"), "not json");
    const result = gateSkillActivation({
      skillName: "stride-claiming-tasks",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).not.toBe("allow");
  });
});

// --- Scenario 4: stride-workflow always allowed ---

describe("scenario 4: stride-workflow always allowed", () => {
  it("allows the orchestrator when no marker exists", () => {
    const result = gateSkillActivation({
      skillName: "stride-workflow",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).toBe("allow");
  });

  it("allows the orchestrator with a stale marker", () => {
    writeMarker(FIVE_HOURS_AGO);
    const result = gateSkillActivation({
      skillName: "stride-workflow",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).toBe("allow");
  });

  it("allows the namespaced orchestrator form", () => {
    const result = gateSkillActivation({
      skillName: "stride:stride-workflow",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).toBe("allow");
  });
});

// --- Scenario 5: non-Stride skill always allowed ---

describe("scenario 5: non-Stride skill", () => {
  it("allows a non-Stride namespaced skill without a marker", () => {
    const result = gateSkillActivation({
      skillName: "superpowers:brainstorming",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).toBe("allow");
  });

  it("allows a bare non-Stride skill name", () => {
    const result = gateSkillActivation({
      skillName: "frontend-design",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).toBe("allow");
  });

  it("allows when skill name is empty (non-skill tool calls fall through)", () => {
    const result = gateSkillActivation({
      skillName: "",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).toBe("allow");
  });
});

// --- Scenario 6: STRIDE_ALLOW_DIRECT=1 bypasses ---

describe("scenario 6: STRIDE_ALLOW_DIRECT bypass", () => {
  it("bypasses the marker check when STRIDE_ALLOW_DIRECT=1", () => {
    const result = gateSkillActivation({
      skillName: "stride-claiming-tasks",
      projectDir,
      env: { STRIDE_ALLOW_DIRECT: "1" },
      now: NOW,
    });
    expect(result).toBe("allow");
  });

  it("does NOT bypass when STRIDE_ALLOW_DIRECT is anything else", () => {
    const result = gateSkillActivation({
      skillName: "stride-claiming-tasks",
      projectDir,
      env: { STRIDE_ALLOW_DIRECT: "true" },
      now: NOW,
    });
    expect(result).not.toBe("allow");
  });
});

// --- Scenario 7: plugin-namespaced names recognized ---

describe("scenario 7: namespaced sub-skill names", () => {
  it("blocks a plugin-namespaced protected sub-skill without a marker", () => {
    const result = gateSkillActivation({
      skillName: "stride:stride-claiming-tasks",
      projectDir,
      env: {},
      now: NOW,
    });
    expect(result).not.toBe("allow");
    expect(result).toMatchObject({ decision: "block" });
  });

  it("blocks every protected sub-skill in both bare and namespaced forms", () => {
    for (const sub of PROTECTED_SUB_SKILLS) {
      const bareResult = gateSkillActivation({
        skillName: sub,
        projectDir,
        env: {},
        now: NOW,
      });
      expect(bareResult).not.toBe("allow");

      const namespacedResult = gateSkillActivation({
        skillName: `stride:${sub}`,
        projectDir,
        env: {},
        now: NOW,
      });
      expect(namespacedResult).not.toBe("allow");
    }
  });
});

// --- gateToolCall wiring smoke-tests ---

describe("gateToolCall (wiring)", () => {
  it("returns allow for tool names not in SKILL_ACTIVATION_TOOLS", () => {
    const result = gateToolCall(
      "bash",
      { command: "ls" },
      projectDir,
      {},
      NOW,
    );
    expect(result).toBe("allow");
  });

  it("invokes the gate when tool name matches a skill-activation tool", () => {
    const result = gateToolCall(
      "activate_skill",
      { name: "stride-claiming-tasks" },
      projectDir,
      {},
      NOW,
    );
    expect(result).not.toBe("allow");
  });

  it("tries every skill-activation tool name", () => {
    for (const tool of SKILL_ACTIVATION_TOOLS) {
      const result = gateToolCall(
        tool,
        { name: "stride-claiming-tasks" },
        projectDir,
        {},
        NOW,
      );
      expect(result).not.toBe("allow");
    }
  });

  it("falls back through arg field names (name → skill → skillName → skill_name)", () => {
    for (const field of ["name", "skill", "skillName", "skill_name"]) {
      const args = { [field]: "stride-claiming-tasks" };
      const result = gateToolCall("skill", args, projectDir, {}, NOW);
      expect(result).not.toBe("allow");
    }
  });

  it("allows when args don't include any recognized skill-name field", () => {
    const result = gateToolCall(
      "skill",
      { unrelated: "value" },
      projectDir,
      {},
      NOW,
    );
    expect(result).toBe("allow");
  });
});

// --- Marker contract sanity checks ---

describe("marker contract", () => {
  it("uses the documented relative path", () => {
    expect(MARKER_RELATIVE_PATH).toBe(".stride/.orchestrator_active");
  });

  it("uses the documented 4h freshness window", () => {
    expect(MARKER_FRESHNESS_MS).toBe(14_400_000);
  });

  it("recognizes all six protected sub-skills (cross-plugin invariant)", () => {
    expect(PROTECTED_SUB_SKILLS).toEqual([
      "stride-claiming-tasks",
      "stride-completing-tasks",
      "stride-creating-tasks",
      "stride-creating-goals",
      "stride-enriching-tasks",
      "stride-subagent-workflow",
    ]);
  });
});
