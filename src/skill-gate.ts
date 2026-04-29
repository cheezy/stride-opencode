/**
 * skill-gate.ts — TypeScript port of stride 1.10.0's stride-skill-gate.sh.
 *
 * Blocks direct activations of internal Stride sub-skills unless the
 * stride-workflow orchestrator wrote an activation marker at
 * <project>/.stride/.orchestrator_active
 *
 * Marker shape: {"session_id":"<id>","started_at":"<ISO8601-Z>","pid":<int>}
 * Marker is "fresh" if `started_at` is within the last 4 hours.
 *
 * Allow-pass conditions:
 *   - STRIDE_ALLOW_DIRECT=1 set in the environment
 *   - skill name is empty / missing
 *   - skill is stride-workflow itself (the orchestrator)
 *   - skill is not in the protected sub-skill list (non-Stride or unrelated)
 *   - marker exists, is parseable, and started_at is within 4h of now
 *
 * Block conditions return {decision:"block", reason:string}
 *   - skill is in the protected list AND marker is missing/stale/unparseable
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Tool names that opencode (or other compatible hosts) may use to activate
 * an agent skill. The wiring in index.ts checks `input.tool` against this
 * list before calling the gate. Add tool names here if opencode introduces
 * new skill-activation tools.
 */
export const SKILL_ACTIVATION_TOOLS: ReadonlyArray<string> = [
  "skill",
  "activate_skill",
  "loadSkill",
  "load_skill",
];

/**
 * Stride sub-skills that the orchestrator dispatches internally. Direct
 * activation from a user prompt is blocked unless the orchestrator marker
 * is present and fresh.
 */
export const PROTECTED_SUB_SKILLS: ReadonlyArray<string> = [
  "stride-claiming-tasks",
  "stride-completing-tasks",
  "stride-creating-tasks",
  "stride-creating-goals",
  "stride-enriching-tasks",
  "stride-subagent-workflow",
];

/** Maximum age of a marker before it is treated as stale (4 hours, in ms). */
export const MARKER_FRESHNESS_MS = 4 * 60 * 60 * 1000;

/** Marker file path relative to the project root. */
export const MARKER_RELATIVE_PATH = ".stride/.orchestrator_active";

export type GateDecision = "allow" | { decision: "block"; reason: string };

export interface GateInput {
  /** The skill name being activated, e.g. "stride-claiming-tasks". May be plugin-namespaced (e.g. "stride:stride-claiming-tasks"). */
  skillName: string;
  /** Absolute path to the project root (where the .stride/ directory lives). */
  projectDir: string;
  /** Environment, used to check STRIDE_ALLOW_DIRECT. Defaults to process.env. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Override the current time, in ms since epoch. Used in tests. */
  now?: number;
  /** Override file-existence/read functions for testing. */
  fs?: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: BufferEncoding) => string;
  };
}

interface MarkerContent {
  session_id?: string;
  started_at?: string;
  pid?: number;
}

/**
 * Decide whether a skill activation should be allowed.
 *
 * Pure function: deterministic for fixed inputs and a fixed `now`. The
 * caller is responsible for detecting that the tool call is a skill
 * activation (e.g. checking `input.tool` against {@link SKILL_ACTIVATION_TOOLS})
 * and extracting the skill name from the model-generated arguments.
 */
export function gateSkillActivation(input: GateInput): GateDecision {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  const fsImpl = input.fs ?? { existsSync, readFileSync };

  // Override: bypass entirely for plugin debugging or scripted CI.
  if (env.STRIDE_ALLOW_DIRECT === "1") {
    return "allow";
  }

  const skillName = (input.skillName ?? "").trim();
  if (!skillName) {
    return "allow";
  }

  // Strip optional plugin prefix for matching.
  const baseName = skillName.replace(/^stride:/, "");

  // Orchestrator itself: always allowed.
  if (baseName === "stride-workflow") {
    return "allow";
  }

  // Non-Stride skill: allowed silently.
  if (!PROTECTED_SUB_SKILLS.includes(baseName)) {
    return "allow";
  }

  // Marker check.
  const markerPath = join(input.projectDir, MARKER_RELATIVE_PATH);

  if (!fsImpl.existsSync(markerPath)) {
    return {
      decision: "block",
      reason:
        `Stride sub-skill '${skillName}' can only be activated from inside ` +
        `stride:stride-workflow. Activate stride:stride-workflow first; the ` +
        `orchestrator will dispatch this skill at the appropriate phase. ` +
        `(Set STRIDE_ALLOW_DIRECT=1 to bypass.)`,
    };
  }

  let markerContent: MarkerContent;
  try {
    const raw = fsImpl.readFileSync(markerPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {
        decision: "block",
        reason:
          "Stride orchestrator marker is unparseable (not an object). " +
          "Re-activate stride:stride-workflow to refresh.",
      };
    }
    markerContent = parsed as MarkerContent;
  } catch {
    return {
      decision: "block",
      reason:
        `Stride orchestrator marker at '${markerPath}' is unparseable. ` +
        `Re-activate stride:stride-workflow to refresh.`,
    };
  }

  const startedAt = markerContent.started_at;
  if (!startedAt || typeof startedAt !== "string") {
    return {
      decision: "block",
      reason:
        "Stride orchestrator marker is invalid (missing or empty " +
        "started_at). Re-activate stride:stride-workflow to refresh.",
    };
  }

  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return {
      decision: "block",
      reason:
        `Stride orchestrator marker has unparseable started_at ` +
        `('${startedAt}'). Re-activate stride:stride-workflow to refresh.`,
    };
  }

  const ageMs = now - startedMs;
  if (ageMs < 0 || ageMs > MARKER_FRESHNESS_MS) {
    const ageSec = Math.floor(ageMs / 1000);
    const maxSec = Math.floor(MARKER_FRESHNESS_MS / 1000);
    return {
      decision: "block",
      reason:
        `Stride orchestrator marker is stale or in the future ` +
        `(age ${ageSec}s; max ${maxSec}s). Re-activate ` +
        `stride:stride-workflow to refresh.`,
    };
  }

  return "allow";
}

/**
 * Given a `tool.execute.before` input/output pair, decide whether to allow
 * the tool call. Returns "allow" for non-skill-activation tools or skills
 * that aren't in the protected list.
 *
 * Skill-name extraction tries the most common argument field names in
 * order: `name`, `skill`, `skillName`, `skill_name`.
 */
export function gateToolCall(
  toolName: string,
  toolArgs: unknown,
  projectDir: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  now?: number,
): GateDecision {
  if (!SKILL_ACTIVATION_TOOLS.includes(toolName)) {
    return "allow";
  }

  let skillName = "";
  if (toolArgs && typeof toolArgs === "object") {
    const args = toolArgs as Record<string, unknown>;
    for (const field of ["name", "skill", "skillName", "skill_name"] as const) {
      const value = args[field];
      if (typeof value === "string" && value.length > 0) {
        skillName = value;
        break;
      }
    }
  }

  return gateSkillActivation({ skillName, projectDir, env, now });
}
