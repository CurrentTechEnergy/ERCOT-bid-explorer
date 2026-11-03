#!/usr/bin/env bash
# Push this run's data commit to BRANCH, rebased onto whatever was merged while the run worked.
#
#   .github/scripts/push-data.sh BRANCH
#
# The commit holds only generated files.  When a merged PR changed one of them too (the Prices
# page's data file in PRs #297 and #298, say), the rebase stops on a conflict.  Then the merged
# PR's version of each clashing file is kept and the rest of this run's data goes in: the next
# run rebuilds that file with the PR's code.  Each conflict is named in a warning.  Before this,
# a conflict left the rebase half done and every retry failed on it, so a 3-hour run lost all
# its data.
set -uo pipefail
branch="$1"

git fetch --unshallow origin "$branch" 2>/dev/null || git fetch origin "$branch"

for attempt in 1 2 3 4 5; do
  git fetch origin "$branch"
  if ! git rebase "origin/$branch"; then
    conflicted=$(git diff --name-only --diff-filter=U)
    if [ -z "$conflicted" ]; then
      echo "::warning::Rebase failed without a file conflict; backing out"
      git rebase --abort
    else
      while IFS= read -r f; do
        echo "::warning::$f was changed by a merge during this run: kept the merged version, the next run rebuilds it"
        if git cat-file -e "origin/$branch:$f" 2>/dev/null; then
          git checkout "origin/$branch" -- "$f"
        else
          git rm -q --cached -- "$f"; rm -f -- "$f"
        fi
      done <<< "$conflicted"
      # an empty commit (every file taken from the merge) is dropped
      if git diff --cached --quiet; then
        git rebase --skip
      else
        GIT_EDITOR=true git rebase --continue
      fi || { echo "::warning::Could not finish the rebase; backing out"; git rebase --abort; }
    fi
  fi
  if [ ! -d "$(git rev-parse --git-path rebase-merge)" ] && git merge-base --is-ancestor "origin/$branch" HEAD; then
    git push origin "HEAD:$branch" && exit 0
  fi
  echo "Push attempt $attempt failed; retrying"
  sleep $((attempt * 10))
done
echo "::error::Could not push the data commit after 5 attempts"
exit 1
