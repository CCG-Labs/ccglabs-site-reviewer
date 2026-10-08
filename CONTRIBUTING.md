# Contributing

Thanks for your interest in `@ccglabs/site-reviewer`.

## Ground rules

This project is **open source but not open to code contributions.** It is
a utility CCG Labs relies on in its own business, so the maintainer keeps
tight control over what goes into it.

- **Issues are welcome.** Bug reports, false positives/negatives from a
  check, and well-described feature ideas all help.
- **Pull requests are not accepted.** Any that are opened will
  be closed without review. This is a
  scope decision, not a judgement of your work.
- **Forks are welcome.** The [Apache-2.0 license](LICENSE) lets you copy,
  modify, and redistribute this project, including commercially. If you
  want a different direction, fork it and take it there. Please pick your
  own package name (see [Trademarks](#trademarks)).

## Filing a good issue

Use the issue templates. For a bug, include:

- the exact command or `runReview` call (redact secrets and auth headers),
- the installed package version and your Node version,
- the `--env` you ran with, and the relevant slice of the JSON report,
- what you expected instead.

Issues are triaged on a best-effort basis. There is no SLA, and requests
may be declined or left open if they don't fit the project's direction.

**Security vulnerabilities:** do not open a public issue. Follow
[SECURITY.md](SECURITY.md).

## Trademarks

The Apache-2.0 license does not grant rights to use the "CCG Labs" name or
logos. Forks should use their own name and package scope.
