// Module resolution hook used only by scripts/check-scout.ts: the upstream Scout eval runner (copied
// unchanged into conformance/scout-intent/) imports the `yaml` npm package, which RecallWhy does not
// install. This resolves that one specifier, and only when it is imported from conformance/scout-intent/,
// to scripts/yaml-subset.ts. Registered with: node --import tsx --import ./scripts/yaml-register.mjs
const subset = new URL("./yaml-subset.ts", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "yaml" && context.parentURL && context.parentURL.includes("/conformance/scout-intent/")) {
    return { url: subset, shortCircuit: true };
  }
  return next(specifier, context);
}
