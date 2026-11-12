"""Generate narration WAVs with an OpenRouter audio model (openai/gpt-audio*).

usage: python3 video/tts.py <key_file> [segment_index ...]
Reads video/narration.json, writes video/voice/seg<i>.wav. The key is read from
<key_file> (OPENROUTER_API_KEY=...) into memory only; it is never printed.
Standard library only.
"""
import base64, json, os, sys, urllib.request, wave

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get("TTS_MODEL", "openai/gpt-audio")


PROVIDER = os.environ.get("TTS_PROVIDER", "openrouter")  # openrouter | gemini
GEMINI_MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts")
STYLE = os.environ.get("TTS_STYLE", "")


def load_key(path):
    var = "GEMINI_API_KEY=" if PROVIDER == "gemini" else "OPENROUTER_API_KEY="
    for line in open(os.path.expanduser(path)):
        if line.startswith(var):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit(f"{var[:-1]} not found in key file")


def synth_gemini(key, text, voice):
    body = {
        "contents": [{"parts": [{"text": STYLE + text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
        data=json.dumps(body).encode(),
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
    )
    r = json.load(urllib.request.urlopen(req, timeout=180))
    part = r["candidates"][0]["content"]["parts"][0]["inlineData"]
    return base64.b64decode(part["data"]), text, r.get("usageMetadata")


def synth(key, text, voice):
    body = {
        "model": MODEL,
        "modalities": ["text", "audio"],
        "audio": {"voice": voice, "format": "pcm16"},
        "stream": True,
        "max_tokens": int(os.environ.get("TTS_MAX_TOKENS", "2000")),
        "messages": [
            {"role": "system", "content": "You are a voice-over artist for a short product demo video. Read the user's text aloud exactly as written, word for word, in a clear, warm, confident, energetic tone at a brisk pace. Do not add, drop or change any words."},
            {"role": "user", "content": text},
        ],
    }
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    pcm, transcript, usage = bytearray(), [], None
    with urllib.request.urlopen(req, timeout=180) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            chunk = json.loads(line[5:])
            usage = chunk.get("usage") or usage
            for ch in chunk.get("choices", []):
                audio = (ch.get("delta") or {}).get("audio") or {}
                if audio.get("data"):
                    pcm += base64.b64decode(audio["data"])
                if audio.get("transcript"):
                    transcript.append(audio["transcript"])
    return bytes(pcm), "".join(transcript), usage


def main():
    key = load_key(sys.argv[1])
    spec = json.load(open(os.path.join(HERE, "narration.json")))
    idx = [int(i) for i in sys.argv[2:]] or range(len(spec["segments"]))
    os.makedirs(os.path.join(HERE, "voice"), exist_ok=True)
    for i in idx:
        seg = spec["segments"][i]
        if PROVIDER == "gemini":
            pcm, transcript, usage = synth_gemini(key, seg["text"], os.environ.get("GEMINI_VOICE", "Kore"))
        else:
            pcm, transcript, usage = synth(key, seg["text"], spec.get("voice", "marin"))
        out = os.path.join(HERE, "voice", f"seg{i}.wav")
        with wave.open(out, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm)
        dur = len(pcm) / 2 / 24000
        cost = (usage or {}).get("cost")
        flag = "OK" if dur <= seg["max"] else f"TOO LONG (max {seg['max']}s)"
        print(f"seg{i}: {dur:.1f}s {flag} cost={cost} transcript_matches={transcript.strip() == seg['text'].strip()}")
        if transcript.strip() != seg["text"].strip():
            print(f"  transcript: {transcript.strip()}")


if __name__ == "__main__":
    main()
