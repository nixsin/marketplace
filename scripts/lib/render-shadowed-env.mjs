/**
 * Which contract variables are set DIRECTLY on a Render service?
 *
 * Render's rule: "If a service defines an environment variable in its
 * individual settings, that value always takes precedence over any linked
 * environment groups that also define the variable." Linking a group removes
 * nothing.
 *
 * So a direct variable shadows Terraform's, silently and with no error
 * anywhere — Terraform reports a clean apply while production keeps the old
 * value, and a later rotation of JWT_SECRET or DATABASE_URL does nothing at
 * all. This is the decision half, kept pure so it can be tested without a
 * Render account.
 */

/**
 * @param {{service: string, names: string[]}[]} services  Direct env var
 *   names, per service, as returned by Render's API.
 * @param {Record<string, {name: string}[]>} contracts  CONTRACTS.
 * @returns {{service: string, shadowed: string[]}[]}  Only services with a
 *   problem; empty when the migration is complete.
 */
export function shadowedVariables(services, contracts) {
  const declared = new Set(
    Object.values(contracts)
      .flat()
      .map((rule) => rule.name),
  );

  return services
    .map(({ service, names }) => ({
      service,
      shadowed: names.filter((name) => declared.has(name)).sort(),
    }))
    .filter(({ shadowed }) => shadowed.length > 0);
}

/** A report a person can act on: which service, which keys, what to do. */
export function formatShadowReport(findings) {
  if (findings.length === 0) {
    return "No contract variable is set directly on a service — the env groups are authoritative.";
  }

  const lines = [
    "These are set directly on a service, so they SHADOW the Terraform env group:",
    "",
  ];
  for (const { service, shadowed } of findings) {
    lines.push(`  ${service}`);
    for (const name of shadowed) lines.push(`    ${name}`);
  }
  lines.push(
    "",
    "Delete them from the service's own Environment tab in the Render dashboard.",
    "Until then Terraform reports a clean apply while production keeps the old",
    "value, and changing one here does nothing at all.",
  );
  return lines.join("\n");
}
