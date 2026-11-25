"""Локальное распознавание речи (Vosk), без интернета.

Протокол: стандартный ввод — куски PCM16 mono 16 kHz с 4-байтовым заголовком
длины (little-endian), стандартный вывод — построчный JSON:
  {"ready": true}
  {"partial": "привет"}
  {"final": "привет андрей"}
  {"bye": true}
"""

import json
import struct
import sys

from vosk import KaldiRecognizer, Model, SetLogLevel

# Вывод всегда в UTF-8, иначе кириллица ломается на Windows-консоли.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"error": "нет пути к модели"})
        return 2
    SetLogLevel(-1)
    try:
        model = Model(sys.argv[1])
    except Exception as error:  # noqa: BLE001
        emit({"error": str(error)})
        return 1
    recognizer = KaldiRecognizer(model, 16000)
    emit({"ready": True})

    stream = sys.stdin.buffer
    while True:
        header = stream.read(4)
        if len(header) < 4:
            break
        (size,) = struct.unpack("<I", header)
        block = stream.read(size) if size > 0 else b""
        if len(block) < size:
            break
        if not block:
            continue
        if recognizer.AcceptWaveform(block):
            text = json.loads(recognizer.Result()).get("text", "").strip()
            if text:
                emit({"final": text})
        else:
            partial = json.loads(recognizer.PartialResult()).get("partial", "").strip()
            emit({"partial": partial})
    emit({"bye": True})
    return 0


if __name__ == "__main__":
    sys.exit(main())