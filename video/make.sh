#!/bin/sh
set -eu

spendtree_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
video_uid=$(id -u)
video_gid=$(id -g)
video_image=spendtree-video:local

if [ "$video_uid" -eq 0 ]; then
  echo "Run this script as a non-root host user." >&2
  exit 1
fi

# Build context contains only video tooling.
docker build --tag "$video_image" "$spendtree_root/video"

docker run --rm --init \
  --network none \
  --user "$video_uid:$video_gid" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env HOME=/tmp \
  --mount "type=bind,source=$spendtree_root,target=/work" \
  "$video_image"

printf 'Output: %s/video/spendtree-demo.mp4\n' "$spendtree_root"
printf 'Duration (seconds): '
docker run --rm \
  --network none \
  --user "$video_uid:$video_gid" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --mount "type=bind,source=$spendtree_root,target=/work,readonly" \
  --entrypoint ffprobe \
  "$video_image" \
  -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 \
  /work/video/spendtree-demo.mp4
