# Tank Arena Notes

## What the downloaded materials suggest

- `c2`, `c3`, and `l1`-`l3` are the strongest fit for the rendering side.
  They focus on WebGL2 fundamentals, lighting, textures, scene interaction, and explicitly point students toward Three.js for building projects faster.
- `c4`-`c6` and `l4`-`l7` cover Pure Data and sound design.
  That aligns well with reactive tank shots, hit sounds, danger states, and dynamic music.
- `c7` and `l8` cover WebXR.
  From the material set alone, this is the most obvious candidate for a third major component if the project needs one beyond graphics + audio.

## Practical interpretation for this project

- Core:
  Three.js + TypeScript single-page game, no backend requirement.
- Strong second pillar:
  Pure Data patching for reactive sound events and adaptive ambience.
- Third pillar if needed:
  WebXR spectator mode, replay room, or target practice mode.

## Sensible scope

- Keep the first delivery strictly single-player.
- Use simple collision and simple enemy behavior first.
- Delay imported assets until the control loop feels good.
- Treat A* as an upgrade after the map representation is stable.

## Boilerplate choices in this repo

- Perspective camera with high top-down angle so the project stays visibly 3D.
- Separate tank body and turret transforms because gameplay depends on it.
- Arena obstacles already laid out as boxes so navigation and shooting tests are easy.
- Audio bridge is currently lightweight and browser-native, but the event points are the same ones a Pure Data bridge would use.
