"""Build the bundled CC0 character GLBs from their creator-published sources.

Run from the repository root after downloading Quaternius's free Standard ZIP
to work/character-sources/universal-base-characters-standard.zip. The official
download is https://quaternius.itch.io/universal-base-characters (free Standard,
not the paid Source tier). Requires Pillow.
"""
from __future__ import annotations

import hashlib
import io
import json
import pathlib
import struct
import zipfile

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "teaching_suite/public/characters"
SOURCES = ROOT / "work/character-sources"
CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pad(data: bytes, fill: bytes = b"\0") -> bytes:
    return data + fill * (-len(data) % 4)


def write_glb(document: dict, binary: bytes) -> bytes:
    text = pad(json.dumps(document, separators=(",", ":")).encode(), b" ")
    binary = pad(binary)
    size = 12 + 8 + len(text) + 8 + len(binary)
    return (struct.pack("<III", 0x46546C67, 2, size)
            + struct.pack("<II", len(text), 0x4E4F534A) + text
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def pack_hero(archive: zipfile.ZipFile, gender: str) -> tuple[bytes, str, str]:
    basename = f"Superhero_{gender}_FullBody.gltf"
    filename = next(name for name in archive.namelist() if name.endswith("/" + basename))
    original = archive.read(filename)
    document = json.loads(original)
    directory = pathlib.PurePosixPath(filename).parent
    assert len(document["buffers"]) == 1
    binary_name = str(directory / document["buffers"][0]["uri"])
    binary = bytearray(pad(archive.read(binary_name)))
    images = document.get("images", [])
    for image in images:
        texture_name = str(directory / image["uri"])
        if texture_name not in archive.namelist():
            texture_name = texture_name.replace("_png.png", ".png")
        with Image.open(io.BytesIO(archive.read(texture_name))) as source:
            source = source.convert("RGBA") if source.mode == "P" or "A" in source.mode else source.convert("RGB")
            source.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            source.save(output, format="PNG", optimize=True)
        texture = output.getvalue()
        image.pop("uri")
        image["mimeType"] = "image/png"
        image["bufferView"] = len(document["bufferViews"])
        document["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(texture)})
        binary.extend(pad(texture))
    document["buffers"] = [{"byteLength": len(binary)}]
    document.setdefault("asset", {})["copyright"] = "Quaternius, Universal Base Characters, CC0 1.0. Repacked as GLB; textures resized to 1024px."
    return write_glb(document, bytes(binary)), filename, sha(original)


def hero_mapping() -> dict[str, str]:
    result = {"pelvis": "pelvis", "spine1": "spine_01", "spine2": "spine_02", "spine3": "spine_03", "neck": "neck_01", "head": "Head"}
    for side, suffix in (("left", "l"), ("right", "r")):
        for part, bone in (("hip", "thigh"), ("knee", "calf"), ("ankle", "foot"), ("foot", "ball"), ("collar", "clavicle"), ("shoulder", "upperarm"), ("elbow", "lowerarm"), ("wrist", "hand")):
            result[f"{side}_{part}"] = f"{bone}_{suffix}"
    return result


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    SOURCES.mkdir(parents=True, exist_ok=True)
    records = []
    archive_path = SOURCES / "universal-base-characters-standard.zip"
    with zipfile.ZipFile(archive_path) as archive:
        for gender in ("Male", "Female"):
            data, original_name, source_hash = pack_hero(archive, gender)
            target = f"hero-{gender.lower()}.glb"
            (OUT / target).write_bytes(data)
            records.append({
                "id": f"builtin-hero-{gender.lower()}", "name": f"Athlete · {gender.lower()}",
                "description": "An anatomical base character in simple training underwear, with athletic proportions.",
                "file": f"characters/{target}",
                "source": "https://quaternius.com/packs/universalbasecharacters.html",
                "creator": "Quaternius (Tomás Laulhé)",
                "license": "CC0 1.0", "licenseUrl": CC0_URL,
                "mapping": hero_mapping(), "settings": {"scaleMultiplier": 1, "yawDegrees": 0},
                "sourceFile": original_name, "sourceSha256": source_hash,
                "modifications": "Embedded buffers and PNG textures in one uncompressed GLB; resized textures to a maximum of 1024px; preserved original mesh, rig, skin weights, and materials.",
            })
        license_name = next(name for name in archive.namelist() if name.endswith("/License_Standard.txt"))
        (OUT / "QUATERNIUS-LICENSE.txt").write_bytes(archive.read(license_name))
    for record in records:
        delivered = (ROOT / "teaching_suite/public" / record["file"]).read_bytes()
        record["bytes"] = len(delivered)
        record["sha256"] = sha(delivered)
        preview = OUT / (record["id"] + ".png")
        if preview.is_file():
            record["preview"] = "characters/" + preview.name
    (OUT / "catalog.json").write_text(json.dumps({"schemaVersion": 1, "models": records}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for record in records:
        print(record["id"], record["bytes"], record["sha256"])
    print("Total:", sum(record["bytes"] for record in records))


if __name__ == "__main__":
    main()
