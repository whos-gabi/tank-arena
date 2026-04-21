# Tank Arena

Boilerplate project for the New Media Technologies course project:

- `TypeScript`
- `Three.js`
- reactive audio hook points intended for `Pure Data`

## Current prototype

- top-down 3D arena
- player tank with body/turret separation
- simple projectiles
- basic enemy pressure loop
- obstacle layout suitable for later pathfinding and cover logic

## Commands

```powershell
npm install
npm run dev
npm run build
npm run materials:update
```

## Project direction

The materials point clearly toward:

1. real-time 3D rendering and interaction with Three.js
2. reactive or generative sound with Pure Data
3. optional stretch component with WebXR if you want a stronger third technical axis

The current scaffold is intentionally small so it can absorb:

- imported tank models
- procedural or authored arena layouts
- A* enemy navigation
- Pure Data driven shooting / explosion / ambience patches
- post-processing, shaders, or WebXR later
