# Three.js GLB support

GLTFLoader, SkeletonUtils, and BufferGeometryUtils are unmodified files from
Three.js 0.180.0, matching the viewer's existing Three.js build. The npm archive
and verified integrity are recorded in `../provenance.json`; the MIT license is
in `../LICENSE`.

Run `work/vendor_custom_models.py` from the repository root to reproduce these
files. Model files and their embedded textures are loaded locally in the browser.

RectAreaLightUniformsLib and RectAreaLightTexturesLib are also unmodified files
from the same verified archive. They supply the renderer's soft ceiling-light
shading tables.
