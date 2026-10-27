# Built-in characters and credits

These two freely redistributable, rigged characters are bundled locally, so
trying another character does not depend on an external model host. They are
animated by the viewer's captured motion; the source models' demo animations are
not used. Both models are offered by their creator under **CC0 1.0**.

| Character | Creator and original asset | Source and license |
| --- | --- | --- |
| Athlete · male | Quaternius (Tomás Laulhé). Original: `Superhero_Male_FullBody.gltf` from Universal Base Characters, free Standard edition. | [Creator's pack page](https://quaternius.com/packs/universalbasecharacters.html), [official download](https://quaternius.itch.io/universal-base-characters), [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Athlete · female | Quaternius (Tomás Laulhé). Original: `Superhero_Female_FullBody.gltf` from Universal Base Characters, free Standard edition. | [Creator's pack page](https://quaternius.com/packs/universalbasecharacters.html), [official download](https://quaternius.itch.io/universal-base-characters), [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

The models are anatomical base characters in simple underwear. They are
useful for comparing motion on different body proportions. They have no weapons
or long props. Credit is preserved as a courtesy; no endorsement is implied.

## Changes made for this viewer

The source glTF buffers and PNG textures were embedded into uncompressed GLB
files. Textures were resized to a maximum of 1024 pixels for faster downloads.
Original geometry, hierarchy, materials, and skin weights were retained.
Explicit maps connect all 22 captured joints to the source rig. Captured motion
provides body/limb directions, without recorded finger or facial motion.

## Source records and integrity

Retrieved from the official sources on October 17, 2026. The downloaded free
Standard ZIP's SHA-256 is
`fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40`.
Only the two selected characters and their embedded textures are shipped. The
pack's original license is retained in [QUATERNIUS-LICENSE.txt](QUATERNIUS-LICENSE.txt),
and the full CC0 legal code in [CC0-1.0.txt](CC0-1.0.txt).

| Shipped file | Bytes | SHA-256 |
| --- | ---: | --- |
| `hero-male.glb` | 4,833,960 | `f2d9cbf2c8ea005e39598084044f9d476e258a40fa3bce99b6f69ca1c5c8caa4` |
| `hero-female.glb` | 5,241,624 | `cdd618814d621fc92ff9bcac9badb1a6c833eb1b213ca5e0d7af5c3b90ef9426` |

[catalog.json](catalog.json) includes the machine-readable bone maps, defaults,
source records, file sizes, and hashes. `work/fetch_builtin_characters.py`
rebuilds the assets from the official sources; its downloaded source cache stays
local and is excluded from the repository.

Catalog bone targets use the names exposed by the viewer's actual GLTFLoader.
