#!/usr/bin/env python3
"""Record N seconds of system audio via WASAPI loopback (no virtual cable needed).

Why: DSH/QQ-agent can only "hear" what it can turn into text. Windows offers
WASAPI loopback on the default output device (PyAudioWPatch exposes it as a
"[Loopback]" input), so recording whatever the machine is playing is enough.
The result is a wav the existing faster-whisper script can transcribe.

Usage: record-loopback.py --out PATH [--seconds 8] [--device-index N] [--rate 48000]
Prints a JSON line with {ok, path, seconds, rate, device, frames} on success.
"""
import argparse
import json
import sys
import wave

import pyaudiowpatch as pyaudio


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--seconds", type=float, default=8.0)
    ap.add_argument("--device-index", type=int, default=None)
    ap.add_argument("--chunk", type=int, default=1024)
    args = ap.parse_args()

    p = pyaudio.PyAudio()
    try:
        if args.device_index is not None:
            info = p.get_device_info_by_index(args.device_index)
        else:
            info = p.get_default_wasapi_loopback()
        rate = int(info.get("defaultSampleRate") or 48000)
        channels = int(info.get("maxInputChannels") or 2)
        if channels < 1:
            channels = 1
        frames_needed = int(rate * max(0.5, args.seconds))
        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            frames_per_buffer=args.chunk,
            input=True,
            input_device_index=int(info["index"]),
        )
        chunks = []
        captured = 0
        while captured < frames_needed:
            data = stream.read(args.chunk, exception_on_overflow=False)
            chunks.append(data)
            captured += args.chunk
        stream.stop_stream()
        stream.close()
    finally:
        p.terminate()

    with wave.open(args.out, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"".join(chunks))

    print(json.dumps({
        "ok": True,
        "path": args.out,
        "seconds": round(captured / rate, 2),
        "rate": rate,
        "channels": channels,
        "device": str(info.get("name")),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
