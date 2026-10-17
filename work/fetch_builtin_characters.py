"""Build the bundled CC0 character GLBs from their creator-published sources.

Run from the repository root after downloading Quaternius's free Standard ZIP
to work/character-sources/universal-base-characters-standard.zip. The official
download is https://quaternius.itch.io/universal-base-characters (free Standard,
not the paid Source tier). RobotExpressive.glb is downloaded from three.js if
the pristine copy is absent. Requires Pillow and NumPy.
"""
from __future__ import annotations

import hashlib
import io
import json
import pathlib
import struct
import urllib.request
import zipfile

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "teaching_suite/public/characters"
SOURCES = ROOT / "work/character-sources"
ROBOT_SOURCE = "https://raw.githubusercontent.com/mrdoob/three.js/b924f0cad4058dc4dde71445c796980c3cd5b5ed/examples/models/gltf/RobotExpressive/RobotExpressive.glb"
CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pad(data: bytes, fill: bytes = b"\0") -> bytes:
    return data + fill * (-len(data) % 4)


def read_glb(data: bytes) -> tuple[dict, bytes]:
    size = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20 : 20 + size])
    binary_size, binary_type = struct.unpack_from("<II", data, 20 + size)
    assert binary_type == 0x004E4942
    return document, data[28 + size : 28 + size + binary_size]


def write_glb(document: dict, binary: bytes) -> bytes:
    text = pad(json.dumps(document, separators=(",", ":")).encode(), b" ")
    binary = pad(binary)
    size = 12 + 8 + len(text) + 8 + len(binary)
    return (struct.pack("<III", 0x46546C67, 2, size)
            + struct.pack("<II", len(text), 0x4E4F534A) + text
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.array(node["matrix"]).reshape(4, 4).T
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    rotation = np.array([
        [1-2*y*y-2*z*z, 2*x*y-2*z*w, 2*x*z+2*y*w],
        [2*x*y+2*z*w, 1-2*x*x-2*z*z, 2*y*z-2*x*w],
        [2*x*z-2*y*w, 2*y*z+2*x*w, 1-2*x*x-2*y*y],
    ])
    result = np.eye(4)
    result[:3, :3] = rotation @ np.diag(node.get("scale", [1, 1, 1]))
    result[:3, 3] = node.get("translation", [0, 0, 0])
    return result


def adapt_robot(data: bytes) -> bytes:
    document, binary = read_glb(data)
    nodes = document["nodes"]
    # The source repeats several names on both a Bone and a Mesh node. Resolve
    # only the weighted skin joints; reparenting a namesake mesh would leave the
    # actual ankle control at the root and break captured knee-to-ankle motion.
    joint_indices = {index for skin in document["skins"] for index in skin["joints"]}
    named = {nodes[index].get("name"): index for index in joint_indices}
    parents = {child: index for index, node in enumerate(nodes) for child in node.get("children", [])}

    def world(index: int) -> np.ndarray:
        return (world(parents[index]) @ matrix(nodes[index])
                if index in parents else matrix(nodes[index]))

    # The original robot is authored for IK: its feet are independent controls.
    # Captured poses use a forward-kinematic leg chain. Preserve every rest-world
    # matrix and inverse bind while making each foot a child of its lower leg.
    old_world = [world(index).copy() for index in range(len(nodes))]
    for side in ("L", "R"):
        foot = named[f"Foot.{side}"]
        leg = named[f"LowerLeg.{side}"]
        nodes[parents[foot]]["children"].remove(foot)
        nodes[leg].setdefault("children", []).append(foot)
        local = np.linalg.inv(old_world[leg]) @ old_world[foot]
        for key in ("translation", "rotation", "scale"):
            nodes[foot].pop(key, None)
        nodes[foot]["matrix"] = local.T.reshape(-1).tolist()
        parents[foot] = leg
    for index in range(len(nodes)):
        assert np.allclose(world(index), old_world[index], atol=1e-7), nodes[index].get("name")
    # Built-in animation clips describe the old IK hierarchy; this viewer drives
    # the model exclusively from captured joints. Keep their source data only in
    # the cached original and omit clips from the adapted delivered GLB.
    document.pop("animations", None)
    document.setdefault("asset", {})["copyright"] = "Tomás Laulhé; modifications Don McCurdy; CC0 1.0. Foot hierarchy adapted for Systema Pose."
    return write_glb(document, binary)


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
    source = SOURCES / "RobotExpressive.glb"
    if not source.exists():
        urllib.request.urlretrieve(ROBOT_SOURCE, source)
    source_data = source.read_bytes()
    robot = adapt_robot(source_data)
    robot_map = {"pelvis": "Body", "spine1": "Hips", "spine2": "Abdomen", "spine3": "Torso", "neck": "Neck", "head": "Head"}
    for side, suffix in (("left", "L"), ("right", "R")):
        for part, bone in (("hip", "UpperLeg"), ("knee", "LowerLeg"), ("ankle", "Foot"), ("collar", "Shoulder"), ("shoulder", "UpperArm"), ("elbow", "LowerArm"), ("wrist", "Palm2")):
            robot_map[f"{side}_{part}"] = f"{bone}.{suffix}"
    # GLTFLoader removes reserved dots and disambiguates names shared by meshes
    # and bones. These exact names are verified against the actual viewer loader.
    robot_map = {joint: bone.replace(".", "") for joint, bone in robot_map.items()}
    robot_map["spine3"] = "Torso_1"
    robot_map["right_ankle"] = "FootR"
    records = [{
        "id": "builtin-robot", "name": "Expressive robot",
        "description": "A playful, broad-handed robot with easy-to-follow limbs.",
        "file": "characters/robot-expressive.glb",
        "source": "https://github.com/mrdoob/three.js/tree/b924f0cad4058dc4dde71445c796980c3cd5b5ed/examples/models/gltf/RobotExpressive",
        "creator": "Tomás Laulhé · modifications by Don McCurdy",
        "license": "CC0 1.0", "licenseUrl": CC0_URL,
        "mapping": robot_map, "settings": {"scaleMultiplier": 1, "yawDegrees": 0},
        "sourceSha256": sha(source_data), "modifications": "Reparented IK feet into each lower-leg chain without changing bind-world transforms; removed original animation clips.",
    }]
    (OUT / "robot-expressive.glb").write_bytes(robot)
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
