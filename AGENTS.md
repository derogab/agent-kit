# Agent Guidelines

## Project

This repository contains reusable plugins and skills for code agents.

## Structure

- `plugins/`: agent plugins
- `skills/`: reusable skills

## Supported Install Paths

- When editing install or release docs, keep the two main install paths aligned: universal skills install and Claude Code marketplace/plugins install.
- Universal docs should mention `skills.sh` and `npx skills add -g derogab/agent-kit`.
- Claude Code docs should mention adding the `derogab/agent-kit` marketplace, then installing the needed plugins.
- If asked to change a Claude Code plugin version, update the matching version in `.claude-plugin/marketplace.json`.

## Working Rules

- Keep changes small and focused.
- Follow the existing structure and wording style.
- Prefer simple Markdown.
- Update nearby docs when behavior or usage changes.
- Do not add unrelated changes.

## Checks

- Read `README.md` and the nearest local `README.md` before editing.
- If you change a plugin or skill, verify links, names, and examples still match.
- Be sure related docs stay synced and updated.
