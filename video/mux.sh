#!/bin/sh
# Mix the narration (video/voice/seg*.wav, from tts.py) onto the silent render. Runs in Docker, no network.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
docker run --rm --network none --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,source=$root/video,target=/v" --entrypoint ffmpeg spendtree-video:local \
  -hide_banner -loglevel error -y -i /v/spendtree-demo-silent.mp4 \
  -i /v/voice/seg0.wav -i /v/voice/seg1.wav -i /v/voice/seg2.wav -i /v/voice/seg3.wav -i /v/voice/seg4.wav \
  -filter_complex "[1]volume=-6dB,afade=t=in:d=0.02,areverse,afade=t=in:d=0.02,areverse,atempo=1.12,adelay=200:all=1[a0];[2]volume=-6dB,afade=t=in:d=0.02,areverse,afade=t=in:d=0.02,areverse,adelay=5500:all=1[a1];[3]volume=-6dB,afade=t=in:d=0.02,areverse,afade=t=in:d=0.02,areverse,adelay=31000:all=1[a2];[4]volume=-6dB,afade=t=in:d=0.02,areverse,afade=t=in:d=0.02,areverse,adelay=46000:all=1[a3];[5]volume=-6dB,afade=t=in:d=0.02,areverse,afade=t=in:d=0.02,areverse,adelay=70500:all=1[a4];[a0][a1][a2][a3][a4]amix=inputs=5:normalize=0,aresample=48000,pan=stereo|c0=c0|c1=c0,loudnorm=I=-16:TP=-2:LRA=11,aresample=48000,alimiter=limit=0.89,apad[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 160k -t 78 -movflags +faststart /v/spendtree-demo.mp4
docker run --rm --network none --mount "type=bind,source=$root/video,target=/v,readonly" --entrypoint ffprobe spendtree-video:local \
  -v error -show_entries stream=codec_name,channels,sample_rate:format=duration -of compact /v/spendtree-demo.mp4
