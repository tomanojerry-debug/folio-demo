"""Convert local audio to the transcript JSON consumed by the Folio worker."""

import argparse
import json
from pathlib import Path


def transcribe(audio, model_name):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    parts, info = model.transcribe(str(audio), vad_filter=True)
    segments = []
    for part in parts:
        text = part.text.strip()
        if not text:
            continue
        start = max(0, round(part.start * 1000))
        end = max(start, round(part.end * 1000))
        segments.append({"start_ms": start, "end_ms": end, "text": text})
    return {"language": info.language, "segments": segments}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--model", default="small", help="faster-whisper model name or local model directory")
    args = parser.parse_args()

    result = transcribe(args.audio, args.model)
    args.output.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
