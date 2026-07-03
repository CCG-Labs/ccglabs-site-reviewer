# Security Policy

## Reporting a Vulnerability

Email brian@brianreich.dev with a description and reproduction steps.
You will receive an acknowledgment within 72 hours. Please do not open
public issues for security reports.

## Runtime posture

This tool fetches and parses untrusted remote content. It never
evaluates fetched content, never spawns subprocesses, caps response
sizes and page counts, restricts crawling to the target origin, and
redacts configured auth headers from all output.
