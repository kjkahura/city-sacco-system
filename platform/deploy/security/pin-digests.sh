#!/usr/bin/env bash
# Pin the deploy workflow's actions to commit SHAs and the base image to a digest
# (security review, CFG-9). A tag can be moved to other code; a SHA or digest cannot.
# Run from the repository root on a machine with git and docker (or skopeo); then review
# the diff and commit. Dependabot (.github/dependabot.yml) keeps them current afterwards.
#
#   bash platform/deploy/security/pin-digests.sh
set -euo pipefail
WF=.github/workflows/deploy.yml
DF=platform/Dockerfile
sha_of() { git ls-remote "https://github.com/$1" "refs/tags/$2^{}" "refs/tags/$2" | awk 'NR==1{print $1}'; }
for spec in actions/checkout@v4 actions/setup-node@v4 google-github-actions/auth@v2 google-github-actions/setup-gcloud@v2; do
  repo=${spec%@*}; tag=${spec#*@}
  sha=$(sha_of "$repo" "$tag")
  [ -n "$sha" ] || { echo "no SHA for $spec" >&2; exit 1; }
  for wf in "$WF" .github/workflows/layer.yml; do
    [ -f "$wf" ] && sed -i.bak "s#uses: $repo@$tag\$#uses: $repo@$sha  \# $tag#" "$wf"
  done
  echo "$spec -> $sha"
done
IMAGE=$(awk '/^FROM /{print $2; exit}' "$DF")
case "$IMAGE" in *@sha256:*) echo "base image already pinned";; *)
  if command -v skopeo >/dev/null; then DIGEST=$(skopeo inspect "docker://docker.io/library/$IMAGE" --format '{{.Digest}}')
  else docker pull -q "$IMAGE" >/dev/null; DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE" | sed 's/.*@//'); fi
  sed -i.bak "s#^FROM $IMAGE#FROM $IMAGE@$DIGEST#" "$DF"; echo "$IMAGE -> $DIGEST";;
esac
rm -f "$WF.bak" .github/workflows/layer.yml.bak "$DF.bak"
git diff --stat
