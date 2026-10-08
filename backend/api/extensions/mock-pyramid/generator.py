import time
import trimesh
 
 
def generate(run, image_path, out_dir):
    for i in range(1, 6):
        if run.cancel.is_set():
            raise RuntimeError("cancelled")
        time.sleep(0.4)
        run.progress = i * 20
    out = f"{out_dir}/{run.id}.glb"
    trimesh.creation.cone(radius=0.7, height=1.2, sections=4).export(out)
    return out
