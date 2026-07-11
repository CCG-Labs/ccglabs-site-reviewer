# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- `seo.sitemap-robots` now discovers a site's sitemap(s) by reading `robots.txt` `Sitemap:`
  declarations instead of guessing `/sitemap.xml`, and checks every declared sitemap, not just
  the first. Sites whose sitemap lives at a non-default path (e.g. `@astrojs/sitemap`'s
  `sitemap-index.xml`) previously failed this check even when correctly configured.
- Crawl seeding (`crawlSite`) has the same robots.txt-driven sitemap discovery, so pages only
  reachable via a non-default sitemap path are no longer silently under-crawled.
- A sitemap index whose child sitemaps all fail to fetch now errors instead of passing silently
  (previously indistinguishable from "no more sitemaps to check"); a partial failure warns.
- Enforces the sitemaps.org 50,000-URL-per-file limit and surfaces an actionable message when a
  sitemap trips the shared fetcher's response-size cap.

### Changed

- Cross-origin child sitemaps referenced from a sitemap index (a legitimate multi-subdomain
  pattern) are now warned about, not conflated with same-origin children that genuinely fail to
  fetch.
- Declared sitemaps beyond 25 are no longer fetched, to bound fetch fan-out on robots.txt files
  with an unreasonable number of `Sitemap:` lines; a warning is added when this truncation
  occurs.
- Child sitemaps within a sitemap index are fetched concurrently instead of sequentially.
- The crawler and `seo.sitemap-robots` now share a single robots.txt fetch per review instead of
  each fetching it independently.
