# Security policy

## Supported versions

Drover is pre-1.0. Only the latest published release of each `@droveragent/*` package (and `droveragent`) receives security fixes.

## Reporting a vulnerability

Do not open a public issue. Report privately through GitHub security advisories:
https://github.com/nc9/drover/security/advisories/new

Include the affected package and version, a description, and a minimal reproduction if you have one.

## Response expectations

This is a small, maintainer-run project. Expect an acknowledgement within 5 working days and a status update within 14 days. Fixes ship as a patch release with an advisory once a fix is available; we credit reporters unless asked not to.

## Threat model in short

- **Tool output is untrusted.** Anything a tool returns (file contents, web pages, MCP responses, subprocess output) can carry prompt injection. Drover does not sanitise it for you: gate dangerous tools with plugins such as `confirm-gate`, `write-policy` and `bash-blocklist`, and keep quotas on.
- **A sandbox is a boundary only if its adapter says so.** The default `just-bash` adapter is a virtual shell with mounts and no host network. Adapters for external services inherit that service's isolation guarantees, documented per adapter. Do not assume more than an adapter documents.
- **The `none` sandbox runs in-process.** Commands execute directly on the host with the host's privileges. Use it only for trusted agents and trusted input.
- **Specs, skills and commands are code-adjacent.** Treat agent specs, `SKILL.md` files, command macros and MCP server configs from untrusted sources as untrusted.
- **Secrets stay with the host.** Drover does not store API keys; do not put secrets in specs or prompts.

Reports about behaviour that is explicitly documented above (for example `none` executing in-process) are not vulnerabilities, but hardening suggestions are welcome as normal issues.
