import { load } from "cheerio";
import type { Check, Finding } from "../../types.js";
import { inspectCertificate } from "./tls-probe.js";

const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;
const ERROR_COST = 20;
const WARNING_COST = 5;
const MIXED_CONTENT_SAMPLE = 3;

interface TlsIssue {
  severity: "error" | "warning";
  message: string;
  recommendation: string;
}

export function certExpiryFindings(validTo: Date, now: Date): TlsIssue[] {
  const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / DAY_MS);
  if (daysLeft < 0) {
    return [
      {
        severity: "error",
        message: `TLS certificate expired ${String(-daysLeft)} days ago (${validTo.toISOString()}).`,
        recommendation: "Renew the certificate immediately — browsers are refusing connections.",
      },
    ];
  }
  if (daysLeft < EXPIRY_WARNING_DAYS) {
    return [
      {
        severity: "warning",
        message: `TLS certificate expires in ${String(daysLeft)} days (${validTo.toISOString()}).`,
        recommendation: "Renew now and confirm auto-renewal is configured.",
      },
    ];
  }
  return [];
}

/** Raw http:// resource references on a page — blocked/flagged by browsers on https pages. */
export function findMixedContent(html: string): string[] {
  const $ = load(html);
  const offenders = new Set<string>();
  const consider = (value: string | undefined): void => {
    if (value !== undefined && value.trim().toLowerCase().startsWith("http://")) {
      offenders.add(value.trim());
    }
  };
  $("img[src], script[src], iframe[src], source[src], video[src], audio[src]").each(
    (_index, element) => {
      consider($(element).attr("src"));
    },
  );
  $('link[rel~="stylesheet" i][href]').each((_index, element) => {
    consider($(element).attr("href"));
  });
  $("img[srcset], source[srcset]").each((_index, element) => {
    for (const candidate of ($(element).attr("srcset") ?? "").split(",")) {
      consider(candidate.trim().split(/\s+/)[0]);
    }
  });
  return [...offenders];
}

export const securityTlsCheck: Check = {
  id: "security.tls",
  category: "security",
  description: "HTTPS is enforced, the certificate is valid and not near expiry, no mixed content.",
  environments: ["production"],
  blocking: true,
  weight: 1,
  async run(ctx) {
    const findings: Finding[] = [];
    const basePage = ctx.pages.get(ctx.baseUrl);
    const baseIsHttp = new URL(ctx.baseUrl).protocol === "http:";
    const finalUrl = basePage === undefined ? ctx.baseUrl : basePage.finalUrl;
    const finalIsHttps = new URL(finalUrl).protocol === "https:";

    if (baseIsHttp && !finalIsHttps) {
      findings.push({
        severity: "error",
        url: ctx.baseUrl,
        message: "Site is served over plain http without redirecting to https.",
        recommendation: "Redirect all http requests to https with a 301 and enable HSTS.",
      });
    }

    if (finalIsHttps) {
      const host = new URL(finalUrl).hostname;
      const port = new URL(finalUrl).port === "" ? 443 : Number(new URL(finalUrl).port);
      const probeOptions = tlsProbeOptions(ctx);
      try {
        const certificate = await inspectCertificate(host, port, probeOptions);
        for (const issue of certExpiryFindings(certificate.validTo, new Date())) {
          findings.push({ ...issue, url: finalUrl });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        findings.push(
          message.includes("timed out")
            ? {
                severity: "warning",
                url: finalUrl,
                message: `Could not inspect the TLS certificate: ${message}`,
                recommendation:
                  "Re-run the review; if this persists, inspect the host's TLS setup manually.",
              }
            : {
                severity: "error",
                url: finalUrl,
                message: `TLS certificate validation failed: ${message}`,
                recommendation: "Fix the certificate chain (expired, self-signed, or wrong host).",
              },
        );
      }
    }

    for (const page of ctx.pages.htmlPages()) {
      if (page.status < 200 || page.status >= 300) continue;
      if (new URL(page.finalUrl).protocol !== "https:") continue;
      const offenders = findMixedContent(page.body);
      if (offenders.length > 0) {
        const sample = offenders.slice(0, MIXED_CONTENT_SAMPLE).join(", ");
        findings.push({
          severity: "error",
          url: page.url,
          message: `Page loads ${String(offenders.length)} resource(s) over plain http (mixed content): ${sample}${offenders.length > MIXED_CONTENT_SAMPLE ? ", …" : ""}`,
          recommendation:
            "Serve all embedded resources over https — browsers block or warn on mixed content.",
        });
      }
    }

    ctx.logger.debug("TLS check summary", { findings: findings.length });
    const errors = findings.filter((finding) => finding.severity === "error").length;
    const warnings = findings.filter((finding) => finding.severity === "warning").length;
    return { score: Math.max(0, 100 - ERROR_COST * errors - WARNING_COST * warnings), findings };
  },
};

/** Test seam: checks."security.tls".options.{ca,rejectUnauthorized,timeoutMs} feed the probe. */
function tlsProbeOptions(ctx: Parameters<Check["run"]>[0]): {
  ca?: string;
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
} {
  const raw = ctx.config.checks["security.tls"]?.options;
  const ca = typeof raw?.["ca"] === "string" ? raw["ca"] : undefined;
  const rejectUnauthorized =
    typeof raw?.["rejectUnauthorized"] === "boolean" ? raw["rejectUnauthorized"] : undefined;
  const timeoutMs = typeof raw?.["timeoutMs"] === "number" ? raw["timeoutMs"] : undefined;
  return {
    ...(ca !== undefined && { ca }),
    ...(rejectUnauthorized !== undefined && { rejectUnauthorized }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  };
}
