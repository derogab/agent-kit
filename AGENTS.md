# Agent Guidelines

## Project

This repository contains reusable plugins and skills for code agents.

## Structure

- `plugins/`: agent plugins
- `skills/`: reusable skills

## Skill Location

- Create the real skill in `skills/<skill-name>/`.
- If the skill is inside a plugin, add a relative symlink at `plugins/<plugin>/skills/<skill-name>` that points to the shared skill directory.
- Do not duplicate skill files inside a plugin. Plugins should reference skills through relative symlinks so the skill stays defined in one place.

## Supported Install Paths

- When editing install or release docs, keep the three main install paths aligned: universal skills, Pi npm packages, and Claude Code marketplace/plugins.
- Universal docs should mention `skills.sh` and `npx skills add -g derogab/agent-kit`.
- Pi plugin docs should mention `pi install npm:@derogab/pi-<plugin-name>`.
- Claude Code docs should mention adding the `derogab/agent-kit` marketplace, then installing the needed plugins.
- If asked to change a Claude Code plugin version, update the matching version in `.claude-plugin/marketplace.json`.
- If asked to change a Pi plugin version, update its version in `plugins/<plugin-name>/package.json`.
- For plugins available on both Claude Code and Pi, keep the package version aligned.

## Working Rules

- Keep changes small and focused.
- Follow the existing structure and wording style.
- Skills must follow the official Agent Skills specification: `https://agentskills.io/specification`.
- Prefer simple Markdown.
- Update nearby docs when behavior or usage changes.
- Do not add unrelated changes.

## Plugin Documentation

- Treat every `plugins/<plugin>/README.md` as end-user documentation.
- Document what the plugin does, along with user-facing installation, configuration, controls, requirements, and limitations.
- Describe implementation only at a stable, high level. Do not document internal control flow, labels, code structure, or incidental mechanics.
- Update a plugin README only when user-facing behavior or documentation changes; do not mirror every internal code change.

## Checks

- Read `README.md` and the nearest local `README.md` before editing.
- If you change a plugin or skill, verify links, names, and examples still match.
- Be sure related docs stay synced and updated.
- Avoid telling how stuff works internally (e.g. in plugins) in docs, maintain it abstract so that it doesn't become outdated with every change.
