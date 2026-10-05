import time
import trimesh


def generate(run, image_path, out_dir):
    for i in range(1, 11):
        if run.cancel.is_set():
            raise RuntimeError("cancelled")
        time.sleep(0.3)
        run.progress = i * 10
    out_file = f"{out_dir}/{run.id}.glb"
    trimesh.creation.icosphere(subdivisions=3).export(out_file)
    return out_file