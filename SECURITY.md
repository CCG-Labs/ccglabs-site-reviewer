# Security Policy

## Supported Versions

Only the latest release receives security fixes.

## Reporting a Vulnerability

**Do not report security vulnerabilities via public GitHub issues.**

**GitHub private disclosure (preferred)**
Use the [Report a vulnerability](https://github.com/CCG-Labs/ccglabs-site-reviewer/security/advisories/new) button on the Security tab.

**Email**
Send details to [brian@ccglabs.net](mailto:brian@ccglabs.net).

## Response

- **Acknowledgement:** within 48 hours
- **Status update:** within 7 days
- **Resolution target:** within 90 days for confirmed vulnerabilities

We follow coordinated disclosure — please give us 90 days to ship a fix before publishing details publicly.

## Runtime posture

This tool fetches and parses untrusted remote content. It never
evaluates fetched content, never spawns subprocesses, caps response
sizes and per-request timeouts, follows redirects only within the
same origin as the requested URL (plus same-host http→https
upgrades), and redacts configured auth headers from all output.
