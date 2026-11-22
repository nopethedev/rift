#!/usr/bin/env python3
# Test double for ONLY the search step (no internet here). Everything else (inspect, download) goes to the real yt-dlp.
import sys, json, os
args = sys.argv[1:]
for a in args:
    if a.startswith(("scsearch", "ytsearch")):
        q = a.split(":", 1)[1].lower()
        base = os.environ["E2E_FILE_BASE"]
        entries = []
        if "ondemand song" in q:
            entries = [
                {"id": "od2", "title": "Demo Artist - Ondemand Song (Live)", "url": base + "/od2.mp3", "duration": 10, "channel": "SomeChannel"},
                {"id": "od3", "title": "Ondemand Song (Remix) by Demo Artist", "url": base + "/od3.mp3", "duration": 10, "channel": "RemixKing"},
                {"id": "od1", "title": "Ondemand Song", "url": base + "/od1.mp3", "duration": 10, "channel": "Demo Artist - Topic"},
            ]
        for name in ("alpha", "beta", "gamma", "delta"):
            if name + " track" in q:
                entries = [{"id": name, "title": name.title() + " Track", "url": base + "/" + name + ".mp3", "duration": 10, "channel": "Demo Artist - Topic"}]
        print(json.dumps({"entries": entries})); sys.exit(0)
os.execvp("yt-dlp", ["yt-dlp"] + args)
