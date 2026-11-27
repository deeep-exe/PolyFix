import json
import struct
from pathlib import Path


def export_glb(output_path: str, shape: str = "box") -> str:
    if shape == "pyramid":
        vertices = [
            0.0, 1.0, 0.0,
            -0.8, -0.8, -0.8,
            0.8, -0.8, -0.8,
            0.8, -0.8, 0.8,
            -0.8, -0.8, 0.8,
        ]
        indices = [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4, 1, 2, 3, 1, 3, 4]
    elif shape == "sphere":
        vertices = [
            0.0, 1.0, 0.0,
            0.0, -1.0, 0.0,
            -1.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
            0.0, 0.0, -1.0,
            0.0, 0.0, 1.0,
        ]
        indices = [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 4, 2, 1, 3, 4, 1, 5, 3, 1, 2, 5]
    else:
        vertices = [
            -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
            -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
        ]
        indices = [
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
            0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
            1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
        ]

    position_data = struct.pack(f"<{len(vertices)}f", *vertices)
    index_data = struct.pack(f"<{len(indices)}H", *indices)
    while len(position_data) % 4:
        position_data += b"\x00"

    bin_data = position_data + index_data
    bin_padding = (-len(bin_data)) % 4
    bin_data += b"\x00" * bin_padding

    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "buffers": [{"byteLength": len(bin_data)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(position_data), "target": 34962},
            {"buffer": 0, "byteOffset": len(position_data), "byteLength": len(index_data), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(vertices) // 3, "type": "VEC3", "min": [-1.0, -1.0, -1.0], "max": [1.0, 1.0, 1.0]},
            {"bufferView": 1, "componentType": 5123, "count": len(indices), "type": "SCALAR", "min": [0], "max": [max(indices)]},
        ],
    }
    json_data = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_data += b" " * ((-len(json_data)) % 4)

    glb = b"glTF" + struct.pack("<II", 2, 12 + 8 + len(json_data) + 8 + len(bin_data))
    glb += struct.pack("<I4s", len(json_data), b"JSON") + json_data
    glb += struct.pack("<I4s", len(bin_data), b"BIN\x00") + bin_data
    Path(output_path).write_bytes(glb)
    return output_path
