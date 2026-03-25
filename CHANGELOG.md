# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-03-25

### Added

**Plugin**
- TypeScript plugin with `tool.execute.before` and `tool.execute.after` hook handlers
- `.stride.md` parser supporting CRLF/LF, comments, empty blocks, adjacent sections
- Stride API call detection for claim, complete, and mark_reviewed endpoints
- Hook routing: claim→before_doing, pre-complete→after_doing, post-complete→before_review, mark_reviewed→after_review
- Environment variable caching from claim responses
- Sequential command execution with structured error reporting

**Skills (6)**
- `stride-claiming-tasks` — Task claiming with before_doing hook execution
- `stride-completing-tasks` — Task completion with after_doing and before_review hooks
- `stride-creating-tasks` — Task creation with field format validation
- `stride-creating-goals` — Goal and batch creation with dependency management
- `stride-enriching-tasks` — Automated codebase exploration to enrich minimal tasks
- `stride-subagent-workflow` — Decision matrix for agent dispatch

**Agents (4)**
- `task-explorer` — Codebase exploration for key_files and patterns
- `task-reviewer` — Code review against acceptance criteria and pitfalls
- `task-decomposer` — Goal decomposition into dependency-ordered tasks
- `hook-diagnostician` — Hook failure diagnosis with prioritized fix plans

**Configuration**
- `AGENTS.md` — OpenCode configuration bridge with skill activation rules
- `package.json` — npm package manifest (opencode-stride)
- `tsconfig.json` — TypeScript configuration for Bun runtime

**Tests**
- 49 tests covering parser, hook routing, command filtering, and environment extraction
- All tests use `bun:test` runner
