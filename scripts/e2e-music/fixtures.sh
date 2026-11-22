#!/usr/bin/env bash
# Generates the audio fixtures used by the E2E suites into $E (music library + files served over HTTP).
set -euo pipefail
: "${E:?set E to the work directory}"
M="$E/media/music"
mkdir -p "$M/Test Artist/Test Album" "$M/Other" "$E/files"

# gen <out> <freq> <seconds> <title> <artist> <album> <track> <genre> [extra ffmpeg args...]
gen() {
  local out="$1" f="$2" d="$3" title="$4" artist="$5" album="$6" track="$7" genre="$8"
  shift 8
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=$f:duration=$d" "$@" \
    -metadata "title=$title" -metadata "artist=$artist" -metadata "album=$album" -metadata "track=$track" -metadata "genre=$genre" -metadata date=2021 "$out"
}

ffmpeg -loglevel error -y -f lavfi -i "color=c=0x8b5cf6:s=400x400" -frames:v 1 "$E/cover.jpg"
gen "$M/Test Artist/Test Album/01 Tone One.mp3" 440 14 "Tone One" "Test Artist" "Test Album" 1 Electronic -i "$E/cover.jpg" -map 0:a -map 1:v -c:a libmp3lame -b:a 128k -c:v copy -id3v2_version 3 -disposition:v attached_pic
gen "$M/Test Artist/Test Album/02 Tone Two.flac"  523 14 "Tone Two"   "Test Artist" "Test Album" 2 Electronic -c:a flac
gen "$M/Test Artist/Test Album/03 Tone Three.ogg" 659 14 "Tone Three" "Test Artist" "Test Album" 3 Electronic -c:a libvorbis
gen "$M/Test Artist/Test Album/04 Tone Four.opus" 784 14 "Tone Four"  "Test Artist" "Test Album" 4 Electronic -c:a libopus
gen "$M/Other/Wave Song.wav"   330 14 "Wave Song"   "Other Artist" "Singles" 1 Rock -c:a pcm_s16le
gen "$M/Other/Aac Song.m4a"    392 14 "Aac Song"    "Other Artist" "Singles" 2 Rock -c:a aac -b:a 128k
gen "$M/Other/Legacy Song.wma" 294 14 "Legacy Song" "Other Artist" "Singles" 3 Rock -c:a wmav2 -f asf

# on-demand fixtures, served over HTTP and read by the real yt-dlp (generic extractor)
for p in "od1 440" "od2 880" "od3 1000" "alpha 300" "beta 400" "gamma 500" "delta 600"; do
  set -- $p
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=$2:duration=10" -c:a libmp3lame -b:a 128k "$E/files/$1.mp3"
done
