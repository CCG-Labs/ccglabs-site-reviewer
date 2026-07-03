import type { CheckOverride, Environment, ResolvedConfig, SiteReviewConfig } from "../types.js";

export const DEFAULTS = {
  environment: "local" as Environment,
  maxPages: 200,
  failThreshold: 80,
};

function mergeLayer(base: ResolvedConfig, layer: SiteReviewConfig | undefined): ResolvedConfig {
  if (!layer) return base;
  const checks: Record<string, CheckOverride> = { ...base.checks };
  for (const [id, value] of Object.entries(layer.checks ?? {})) {
    const override: CheckOverride = typeof value === "boolean" ? { enabled: value } : value;
    checks[id] = { ...checks[id], ...override };
  }
  return {
    ...base,
    ...(layer.maxPages !== undefined && { maxPages: layer.maxPages }),
    ...(layer.failThreshold !== undefined && { failThreshold: layer.failThreshold }),
    ...(layer.requestHeaders !== undefined && { requestHeaders: layer.requestHeaders }),
    checks,
    customChecks: [...base.customChecks, ...(layer.customChecks ?? [])],
  };
}

export function resolveConfig(layers: {
  file?: SiteReviewConfig;
  api?: SiteReviewConfig;
  cli?: SiteReviewConfig;
}): ResolvedConfig {
  const environment =
    layers.cli?.environment ??
    layers.api?.environment ??
    layers.file?.environment ??
    DEFAULTS.environment;

  let resolved: ResolvedConfig = {
    environment,
    maxPages: DEFAULTS.maxPages,
    failThreshold: DEFAULTS.failThreshold,
    requestHeaders: {},
    checks: {},
    customChecks: [],
  };

  const orderedLayers = [
    layers.file,
    layers.file?.environments?.[environment],
    layers.api,
    layers.api?.environments?.[environment],
    layers.cli,
  ];
  for (const layer of orderedLayers) {
    resolved = mergeLayer(resolved, layer);
  }
  return { ...resolved, environment };
}
