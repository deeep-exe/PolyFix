---
license: mit
tags:
- image-to-image
- text-to-3d 
- diffusers
- shap-e
---

# Shap-E

Shap-E introduces a diffusion process that can generate a 3D image from a text prompt. It was introduced in [Shap-E: Generating Conditional 3D Implicit Functions](https://arxiv.org/abs/2305.02463) by Heewoo Jun and Alex Nichol from OpenAI. 

Original repository of Shap-E can be found here: https://github.com/openai/shap-e. 

_The authors of Shap-E didn't author this model card. They provide a separate model card [here](https://github.com/openai/shap-e/blob/main/model-card.md)._

## Introduction 

The abstract of the Shap-E paper:

*We present Shap-E, a conditional generative model for 3D assets. Unlike recent work on 3D generative models which produce a single output representation, Shap-E directly generates the parameters of implicit functions that can be rendered as both textured meshes and neural radiance fields. We train Shap-E in two stages: first, we train an encoder that deterministically maps 3D assets into the parameters of an implicit function; second, we train a conditional diffusion model on outputs of the encoder. When trained on a large dataset of paired 3D and text data, our resulting models are capable of generating complex and diverse 3D assets in a matter of seconds. When compared to Point-E, an explicit generative model over point clouds, Shap-E converges faster and reaches comparable or better sample quality despite modeling a higher-dimensional, multi-representation output space. We release model weights, inference code, and samples at [this https URL](https://github.com/openai/shap-e).*

## Released checkpoints

The authors released the following checkpoints:

* [openai/shap-e](https://hf.co/openai/shap-e): produces a 3D image from a text input prompt
* [openai/shap-e-img2img](https://hf.co/openai/shap-e-img2img): samples a 3D image from synthetic 2D image

## Usage examples in 🧨 diffusers

First make sure you have installed all the dependencies:

```bash 
pip install transformers accelerate -q
pip install git+https://github.com/huggingface/diffusers@@shap-ee
```

Once the dependencies are installed, use the code below:

```python 
import torch
from diffusers import ShapEImg2ImgPipeline
from diffusers.utils import export_to_gif, load_image


ckpt_id = "openai/shap-e-img2img"
pipe = ShapEImg2ImgPipeline.from_pretrained(repo).to("cuda")

img_url = "https://hf.co/datasets/diffusers/docs-images/resolve/main/shap-e/corgi.png"
image = load_image(img_url)


generator = torch.Generator(device="cuda").manual_seed(0)
batch_size = 4
guidance_scale = 3.0

images = pipe(
    image, 
    num_images_per_prompt=batch_size, 
    generator=generator, 
    guidance_scale=guidance_scale,
    num_inference_steps=64, 
    size=256, 
    output_type="pil"
).images

gif_path = export_to_gif(images, "corgi_sampled_3d.gif")
```

## Results 

<table>
    <tbody>
        <tr>
            <td align="center">
                <img src="https://huggingface.co/datasets/diffusers/docs-images/resolve/main/shap-e/corgi.png" alt="Reference corgi image in 2D">
            </td>
            <td align="center">
                <img src="https://huggingface.co/datasets/diffusers/docs-images/resolve/main/shap-e/corgi_sampled_3d.gif" alt="Sampled image in 3D (one)">
            </td align="center">
            <td align="center">
                <img src="https://huggingface.co/datasets/diffusers/docs-images/resolve/main/shap-e/corgi_sampled_3d_two.gif" alt="Sampled image in 3D (two)">
            </td>
        </tr>
        <tr>
            <td align="center">Reference corgi image in 2D</td>
            <td align="center">Sampled image in 3D (one)</td>
            <td align="center">Sampled image in 3D (two)</td>
        </tr>
     </tr> 
    </tbody>
<table>

## Training details

Refer to the [original paper](https://arxiv.org/abs/2305.02463).

## Known limitations and potential biases
    
Refer to the [original model card](https://github.com/openai/shap-e/blob/main/model-card.md).
    
## Citation

```bibtex 
@misc{jun2023shape,
      title={Shap-E: Generating Conditional 3D Implicit Functions}, 
      author={Heewoo Jun and Alex Nichol},
      year={2023},
      eprint={2305.02463},
      archivePrefix={arXiv},
      primaryClass={cs.CV}
}
```