#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN to a scoped Cloudflare API token}"

# Keep the credential in this shell only. Exported variables are inherited by
# every child (`curl`, `jq`, and anything they launch), so clear the exported
# name immediately after copying it into an ordinary, non-exported variable.
CLOUDFLARE_TOKEN=${CLOUDFLARE_API_TOKEN}
unset CLOUDFLARE_API_TOKEN
readonly CLOUDFLARE_TOKEN

ZONE_NAME="${1:-laxair.shop}"
API="https://api.cloudflare.com/client/v4"

# The token must not appear in curl's argv (visible in process listings) or
# inherited environment. Header input travels over stdin instead.
cloudflare_get() {
  local url=$1
  local response
  response=$(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' \
    "${CLOUDFLARE_TOKEN}" |
    curl --fail --silent --show-error --header @- "${url}")

  jq -ce \
    'if .success == true and .result != null then . else error("Cloudflare API returned success=false or a null result") end' \
    <<<"${response}"
}

zone_json=$(cloudflare_get "${API}/zones?name=${ZONE_NAME}")
zone_id=$(jq -er '.result | if length == 1 then .[0].id else error("expected exactly one zone") end' <<<"${zone_json}")

printf 'zone_id=%s\n' "${zone_id}"

for hostname in "${ZONE_NAME}" "www.${ZONE_NAME}" "api.${ZONE_NAME}"; do
  # Exact server-side filtering avoids silently missing a record on a later
  # page in a large zone.
  records_json=$(cloudflare_get \
    "${API}/zones/${zone_id}/dns_records?type=CNAME&name=${hostname}")
  record_id=$(jq -er --arg name "${hostname}" \
    '.result | map(select(.name == $name and .type == "CNAME")) | if length == 1 then .[0].id else error("expected exactly one CNAME for " + $name) end' \
    <<<"${records_json}")
  printf 'dns_%s=%s\n' "${hostname//./_}" "${record_id}"
done

rulesets_json='[]'
page=1
while :; do
  page_json=$(cloudflare_get \
    "${API}/zones/${zone_id}/rulesets?page=${page}&per_page=50")
  rulesets_json=$(jq -cn \
    --argjson accumulated "${rulesets_json}" \
    --argjson current "$(jq '.result' <<<"${page_json}")" \
    '$accumulated + $current')
  total_pages=$(jq -r '.result_info.total_pages // 1' <<<"${page_json}")
  ((page >= total_pages)) && break
  ((page += 1))
done
cache_ruleset_id=$(jq -er \
  'map(select(.kind == "zone" and .phase == "http_request_cache_settings")) | if length == 1 then .[0].id elif length == 0 then "not-created" else error("multiple cache-settings rulesets") end' \
  <<<"${rulesets_json}")
printf 'cache_ruleset_id=%s\n' "${cache_ruleset_id}"

if [[ "${cache_ruleset_id}" != "not-created" ]]; then
  cache_ruleset_json=$(cloudflare_get \
    "${API}/zones/${zone_id}/rulesets/${cache_ruleset_id}")
  cache_rule_count=$(jq -er '.result.rules | length' <<<"${cache_ruleset_json}")
  cache_rules_json=$(jq -cer \
    '.result.rules | if type == "array" then . else error("ruleset rules is not an array") end' \
    <<<"${cache_ruleset_json}")
  printf 'cache_ruleset_rule_count=%s\n' "${cache_rule_count}"
  # Full compact JSON makes the README's inventory step executable rather
  # than asking an operator to reconstruct rules from a count.
  printf 'cache_ruleset_rules_json=%s\n' \
    "${cache_rules_json}"
fi
