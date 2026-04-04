# AGENTS.md
This repository allows AI-assisted work only under strict human responsibility.

If you are an AI coding agent, follow these rules exactly.

## Mission
You are assisting a human contributor.  
You are not the decision maker.

Do not invent architecture.
Do not change business rules unless explicitly asked.
Do not introduce new patterns, frameworks, or dependencies unless explicitly requested.
Do not add dependencies without explicit consent of the prompt writer. Make sure to bring all the needed informations if you can find it (stars on github, last commit, security threats, etc). The less we add dependencies, the better it is.

## Allowed work

You may help with:
- small isolated implementations,
- unit tests,
- refactoring with narrow scope,
- documentation edits,
- code cleanup,
- simple adapters, mappers, DTOs, and glue code.

## Explicit authorisation needed work

Ask preciselt before:
- redesign architecture,
- modify security-critical code unless explicitly requested,
- change authentication or authorization logic unless explicitly requested,
- introduce persistence strategy changes unless explicitly requested,
- add dependencies,
- modify public APIs without explicit instruction,
- make broad multi-module changes without a clear request.

## Never
- open automatic pull requests,
- Rewrite tests without explicit consent, especially if the test fails after a change you made

## Change boundaries

Keep changes minimal.

Prefer:
- one concern per change,
- small diffs,
- explicit naming,
- existing patterns,
- local fixes.

Avoid:
- touching unrelated files,
- speculative cleanup,
- hidden side effects,
- “improving” code beyond the requested scope.

## Output expectations
When proposing code, clearly state:
- what changed,
- which files were modified,
- why the change is safe,
- what remains for human review.

If the request is ambiguous, ask for clarification instead of guessing.

## Licensing and provenance

Do not reproduce third-party code verbatim.
Do not copy code from external sources.
Prefer original code consistent with the repository style.

## Final rule

A human must review, understand, and approve every change before merge.
Your role is assistance, not authorship.