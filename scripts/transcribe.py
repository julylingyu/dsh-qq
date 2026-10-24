#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper (used by qq-bridge ASR).

Why a separate process: faster-whisper + torch live in the VoiceStudio venv
(see ~/.dsh/voice-studio-venv); the bridge runs on the stock Node runtime and
must not depend on those packages. Spawning the venv's python keeps the two
worry-free, and the model is loaded per call (a few seconds for `small`).

Usage: transcribe.py <audio-path> [--model small] [--language zh]
Prints the transcript to stdout; errors go to stderr with a non-zero exit.
"""
import argparse
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="zh")
    args = ap.parse_args()
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - environment problem
        print(f"faster-whisper unavailable: {exc}", file=sys.stderr)
        return 3
    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(args.audio, language=args.language, vad_filter=True)
        text = "".join(seg.text for seg in segments).strip()
        # whisper 经常输出繁体（教程坑 11），有 opencc 就转简体，没有就原样返回。
        try:
            from opencc import OpenCC
            text = OpenCC("t2s").convert(text)
        except Exception:
            pass
        print(text)
        return 0
    except Exception as exc:  # pragma: no cover
        print(f"transcribe failed: {exc}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
