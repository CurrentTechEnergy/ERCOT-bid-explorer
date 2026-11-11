#!/usr/bin/env bash
# Publish an uploaded Pages artifact and wait for GitHub Pages to finish syncing it.
#
#   .github/scripts/deploy-pages.sh ARTIFACT_ID
#
# Does what actions/deploy-pages does, with two differences that kept failing our runs:
#   - The deployment is named after the run and its attempt, not only the commit.  GitHub keys a
#     Pages deployment by that name, so two runs that started from the same commit (or a re-run of
#     a deploy that timed out) got the earlier, cancelled deployment back and failed at once
#     (Nov 10).  Here every run and every re-run gets a fresh one, so "Re-run failed jobs" works.
#   - It waits up to DEPLOY_TIMEOUT_MIN minutes (default 30).  deploy-pages caps its wait at 10
#     minutes whatever its timeout input says, and Pages sometimes takes longer than that to sync
#     the site's ~10,000 files (Nov 6 and Nov 10).
#
# Needs the job permissions pages: write and id-token: write, and GH_TOKEN set to github.token.
# Writes page_url to GITHUB_OUTPUT for the environment's url.
set -euo pipefail

artifact_id="${1:?usage: deploy-pages.sh ARTIFACT_ID}"
timeout_min="${DEPLOY_TIMEOUT_MIN:-30}"
version="${GITHUB_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"

# The OIDC token Pages checks the deployment against (no audience, as deploy-pages asks for).
oidc=$(curl -sSf -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}" | jq -r .value)
echo "::add-mask::${oidc}"

echo "Creating Pages deployment ${version} for artifact ${artifact_id}"
created=$(jq -n --argjson id "$artifact_id" --arg v "$version" --arg t "$oidc" \
    '{artifact_id: $id, pages_build_version: $v, oidc_token: $t}' |
  gh api -X POST "repos/${GITHUB_REPOSITORY}/pages/deployments" --input -)
deployment_id=$(jq -r '.id // (.status_url | split("/") | last)' <<<"$created")
page_url=$(jq -r '.page_url // empty' <<<"$created")
echo "Deployment ID ${deployment_id}"
[ -n "$page_url" ] && echo "page_url=${page_url}" >> "${GITHUB_OUTPUT:-/dev/null}"

cancel() {
  gh api -X POST "repos/${GITHUB_REPOSITORY}/pages/deployments/${deployment_id}/cancel" >/dev/null ||
    echo "::warning::Could not cancel deployment ${deployment_id}"
}

deadline=$(( $(date +%s) + timeout_min * 60 ))
errors=0
while :; do
  sleep 15
  if ! status=$(gh api "repos/${GITHUB_REPOSITORY}/pages/deployments/${deployment_id}" --jq .status); then
    errors=$((errors + 1))
    if [ "$errors" -ge 10 ]; then
      echo "::error::Could not read the deployment status 10 times; cancelling"
      cancel
      exit 1
    fi
    continue
  fi
  errors=0
  case "$status" in
    succeed)
      echo "Deployed after $(( timeout_min * 60 - deadline + $(date +%s) )) s"
      exit 0 ;;
    deployment_failed|deployment_content_failed|deployment_cancelled|deployment_lost)
      echo "::error::Pages deployment ended with status ${status}. Re-run the failed deploy job to try again."
      exit 1 ;;
    *)
      echo "$(date -u +%H:%M:%S) status: ${status}" ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::Pages did not finish within ${timeout_min} minutes; cancelling. Re-run the failed deploy job to try again."
    cancel
    exit 1
  fi
done
