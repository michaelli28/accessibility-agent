#!/usr/bin/env bash
# SPIKE: in-sandbox curl reachability for every W3C BAD URL (index, before/after pages, reports).
# Run inside the Bash sandbox with allowed_domains=["www.w3.org"].
set -u
BASE=https://www.w3.org/WAI/demos/bad
urls=("$BASE/")
for side in before after; do
  for p in home news tickets survey; do
    urls+=("$BASE/$side/$p.html")
  done
done
for side in before after; do
  for p in home news tickets survey; do
    urls+=("$BASE/$side/reports/$p.html")
  done
done
for u in "${urls[@]}"; do
  out=$(curl -sS -m 60 -o /dev/null -w '%{http_code} %{url_effective}' -L "$u" 2>&1)
  echo "CURL $u -> $out"
done
