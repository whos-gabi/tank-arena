import * as THREE from "three";
import { GRID_SIZE, CELL_SIZE } from "./config";
import { Assets } from "./assets";
import {
  GridCell,
  createGridValue,
  gridDistance,
  keyOf,
  neighbors4,
  worldFromCell,
} from "./grid";

export type Obstacle = {
  bounds: THREE.Box3;
  center: THREE.Vector3;
  destructible?: boolean;
  health?: number;
  visual?: THREE.Group;
  type?: 'cardboard' | 'container' | 'wall' | 'car' | 'ibc';
};

export type ArenaLayout = {
  blocked: boolean[][];
  wallRotations: Array<Array<number | null>>;
  walkable: GridCell[];
  playerSpawn: GridCell;
  enemySpawns: GridCell[];
};

function floodReachable(start: GridCell, blocked: boolean[][]) {
  const queue: GridCell[] = [start];
  const visited = new Set<string>([keyOf(start)]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of neighbors4(current)) {
      if (blocked[neighbor.row][neighbor.col]) {
        continue;
      }
      const nextKey = keyOf(neighbor);
      if (!visited.has(nextKey)) {
        visited.add(nextKey);
        queue.push(neighbor);
      }
    }
  }

  return visited;
}

function createInteriorWallRuns(blocked: boolean[][], wallRotations: Array<Array<number | null>>) {
  const wallRunCount = THREE.MathUtils.randInt(5, 8);
  let placedRuns = 0;

  for (let attempt = 0; attempt < 80 && placedRuns < wallRunCount; attempt += 1) {
    const horizontal = Math.random() < 0.5;
    const length = THREE.MathUtils.randInt(2, 5);
    const startCol = THREE.MathUtils.randInt(3, GRID_SIZE - 4 - (horizontal ? length : 0));
    const startRow = THREE.MathUtils.randInt(3, GRID_SIZE - 4 - (horizontal ? 0 : length));
    const gapIndex = length >= 4 && Math.random() < 0.35
      ? THREE.MathUtils.randInt(1, length - 2)
      : -1;

    const cells: GridCell[] = [];
    for (let step = 0; step < length; step += 1) {
      if (step === gapIndex) {
        continue;
      }

      cells.push({
        col: startCol + (horizontal ? step : 0),
        row: startRow + (horizontal ? 0 : step),
      });
    }

    if (
      cells.length < 2 ||
      cells.some((cell) => blocked[cell.row][cell.col]) ||
      cells.some((cell) => {
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            const row = cell.row + dr;
            const col = cell.col + dc;
            if (row >= 1 && row < GRID_SIZE - 1 && col >= 1 && col < GRID_SIZE - 1 && blocked[row][col]) {
              return true;
            }
          }
        }
        return false;
      })
    ) {
      continue;
    }

    const rotation = horizontal ? 0 : Math.PI / 2;
    for (const cell of cells) {
      blocked[cell.row][cell.col] = true;
      wallRotations[cell.row][cell.col] = rotation;
    }
    placedRuns += 1;
  }
}

export function generateLayout() {
  const center = Math.floor(GRID_SIZE / 2);
  const blocked = createGridValue(() => false);
  const wallRotations = createGridValue<number | null>(() => null);

  // Mark all border cells as blocked for walls
  for (let col = 0; col < GRID_SIZE; col += 1) {
    blocked[0][col] = true;
    blocked[GRID_SIZE - 1][col] = true;
  }
  for (let row = 0; row < GRID_SIZE; row += 1) {
    blocked[row][0] = true;
    blocked[row][GRID_SIZE - 1] = true;
  }

  // Add 0-7 wall extensions into the map (corners)
  const numWallExtensions = THREE.MathUtils.randInt(0, 7);
  const corners = [
    { col: 1, row: 1, dir: [[1, 0], [0, 1]] }, // top-left
    { col: GRID_SIZE - 2, row: 1, dir: [[-1, 0], [0, 1]] }, // top-right
    { col: 1, row: GRID_SIZE - 2, dir: [[1, 0], [0, -1]] }, // bottom-left
    { col: GRID_SIZE - 2, row: GRID_SIZE - 2, dir: [[-1, 0], [0, -1]] }, // bottom-right
  ];

  for (let i = 0; i < numWallExtensions; i++) {
    const corner = corners[Math.floor(Math.random() * corners.length)];
    const length = THREE.MathUtils.randInt(1, 3);
    const direction = corner.dir[Math.floor(Math.random() * corner.dir.length)];

    for (let j = 0; j < length; j++) {
      const col = corner.col + direction[0] * j;
      const row = corner.row + direction[1] * j;
      if (col > 0 && col < GRID_SIZE - 1 && row > 0 && row < GRID_SIZE - 1) {
        blocked[row][col] = true;
      }
    }
  }

  createInteriorWallRuns(blocked, wallRotations);

  // Place sparse random obstacles (10-18 clusters)
  const numClusters = THREE.MathUtils.randInt(12, 20);

  for (let i = 0; i < numClusters; i++) {
    const centerCol = THREE.MathUtils.randInt(4, GRID_SIZE - 5);
    const centerRow = THREE.MathUtils.randInt(4, GRID_SIZE - 5);

    // Random cluster size (1-3 cells)
    const clusterSize = THREE.MathUtils.randInt(1, 3);

    for (let j = 0; j < clusterSize; j++) {
      const offsetCol = THREE.MathUtils.randInt(-1, 1);
      const offsetRow = THREE.MathUtils.randInt(-1, 1);
      const col = centerCol + offsetCol;
      const row = centerRow + offsetRow;

      if (col > 2 && col < GRID_SIZE - 3 && row > 2 && row < GRID_SIZE - 3) {
        blocked[row][col] = true;
      }
    }
  }

  // Calculate initial walkable cells
  const walkableTemp: GridCell[] = [];
  for (let row = 1; row < GRID_SIZE - 1; row++) {
    for (let col = 1; col < GRID_SIZE - 1; col++) {
      const cell = { col, row };
      if (!blocked[row][col]) {
        walkableTemp.push(cell);
      }
    }
  }

  // Random player spawn in open area
  const possibleSpawns = walkableTemp.filter(
    (cell) =>
      cell.col >= 4 &&
      cell.col <= GRID_SIZE - 5 &&
      cell.row >= 4 &&
      cell.row <= GRID_SIZE - 5
  );

  const playerSpawn =
    possibleSpawns.length > 0
      ? possibleSpawns[Math.floor(Math.random() * possibleSpawns.length)]
      : { col: center, row: center };

  // Clear space around player spawn
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = playerSpawn.row + dr;
      const c = playerSpawn.col + dc;
      if (r > 0 && r < GRID_SIZE - 1 && c > 0 && c < GRID_SIZE - 1) {
        blocked[r][c] = false;
        wallRotations[r][c] = null;
      }
    }
  }

  // Recalculate walkable cells after clearing player spawn
  const reachable = floodReachable(playerSpawn, blocked);
  const walkable2: GridCell[] = [];
  for (let row = 1; row < GRID_SIZE - 1; row++) {
    for (let col = 1; col < GRID_SIZE - 1; col++) {
      const cell = { col, row };
      if (!blocked[row][col] && reachable.has(keyOf(cell))) {
        walkable2.push(cell);
      }
    }
  }

  // Find enemy spawns far from player in different quadrants
  const enemySpawns: GridCell[] = [];
  const quadrants = [
    { minCol: center, maxCol: GRID_SIZE - 4, minRow: 3, maxRow: center },
    { minCol: center, maxCol: GRID_SIZE - 4, minRow: center, maxRow: GRID_SIZE - 4 },
    { minCol: 3, maxCol: center, minRow: center, maxRow: GRID_SIZE - 4 },
    { minCol: 3, maxCol: center, minRow: 3, maxRow: center },
  ];

  for (const quad of quadrants) {
    const candidates = walkable2.filter(
      (cell) =>
        cell.col >= quad.minCol &&
        cell.col <= quad.maxCol &&
        cell.row >= quad.minRow &&
        cell.row <= quad.maxRow &&
        gridDistance(cell, playerSpawn) >= 6
    );

    if (candidates.length > 0) {
      const idx = Math.floor(Math.random() * candidates.length);
      enemySpawns.push(candidates[idx]);
    }

    if (enemySpawns.length >= 4) break;
  }

  return {
    blocked,
    wallRotations,
    walkable: walkable2,
    playerSpawn,
    enemySpawns,
  } satisfies ArenaLayout;
}

export function buildArenaScene(
  worldRoot: THREE.Group,
  scene: THREE.Scene,
  assets: Assets,
  layout: ArenaLayout,
) {
  const obstacles: Obstacle[] = [];

  const floorRoot = new THREE.Group();
  worldRoot.add(floorRoot);

  // Place stone floor tiles on all cells
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const cell = { col, row };
      const center = worldFromCell(cell);
      const floorTile = assets.stoneFloor.clone(true);
      floorTile.position.copy(center);
      floorTile.position.y = -0.05;
      floorTile.rotation.y = THREE.MathUtils.randInt(0, 3) * (Math.PI / 2);
      floorTile.scale.x *= Math.random() < 0.5 ? -1 : 1;
      floorTile.scale.z *= Math.random() < 0.5 ? -1 : 1;
      floorTile.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.receiveShadow = true;
        }
      });
      floorRoot.add(floorTile);
    }
  }

  // Container color variations
  const containerColors = [
    "#8B0000", // dark red
    "#A52A2A", // brown-red
    "#B22222", // firebrick
    "#DC143C", // crimson
    "#CD5C5C", // indian red
    "#800020", // burgundy
  ];

  const obstacleHeight = 2.8;

  // Track car placements to enforce spacing
  const carPositions: THREE.Vector3[] = [];

  // Place border walls and interior obstacles
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let col = 0; col < GRID_SIZE; col += 1) {
      const cell = { col, row };
      const center = worldFromCell(cell);

      // Border walls and corners
      if (
        row === 0 ||
        row === GRID_SIZE - 1 ||
        col === 0 ||
        col === GRID_SIZE - 1
      ) {
        // Place IBC tanks in corners instead of walls
        if (
          (row === 0 && col === 0) ||
          (row === 0 && col === GRID_SIZE - 1) ||
          (row === GRID_SIZE - 1 && col === 0) ||
          (row === GRID_SIZE - 1 && col === GRID_SIZE - 1)
        ) {
          const ibcCorner = assets.ibcTank.clone(true);
          ibcCorner.position.copy(center);
          ibcCorner.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2);
          worldRoot.add(ibcCorner);
        } else {
          // Regular walls on edges
          const wall = assets.damagedWall.clone(true);
          wall.position.copy(center);

          // Top and bottom walls: no rotation
          // Left and right walls: rotate 90 degrees
          if (col === 0 || col === GRID_SIZE - 1) {
            wall.rotation.y = Math.PI / 2;
          }

          worldRoot.add(wall);
        }

        obstacles.push({
          bounds: new THREE.Box3(
            new THREE.Vector3(
              center.x - CELL_SIZE * 0.48,
              0,
              center.z - CELL_SIZE * 0.48
            ),
            new THREE.Vector3(
              center.x + CELL_SIZE * 0.48,
              obstacleHeight,
              center.z + CELL_SIZE * 0.48
            )
          ),
          center,
        });
        continue;
      }

      // Interior obstacles
      if (!layout.blocked[row][col]) {
        continue;
      }

      const wallRotation = layout.wallRotations[row][col];
      if (wallRotation !== null) {
        const wall = assets.damagedWall.clone(true);
        wall.position.copy(center);
        wall.rotation.y = wallRotation;
        worldRoot.add(wall);

        obstacles.push({
          bounds: new THREE.Box3(
            new THREE.Vector3(
              center.x - CELL_SIZE * 0.48,
              0,
              center.z - CELL_SIZE * 0.48
            ),
            new THREE.Vector3(
              center.x + CELL_SIZE * 0.48,
              obstacleHeight,
              center.z + CELL_SIZE * 0.48
            )
          ),
          center,
          visual: wall,
          type: 'wall',
        });
        continue;
      }

      // Check if this should be a car (10% chance)
      const isCar = Math.random() < 0.1;

      if (isCar) {
        // Check if any car is too close (within 2 cells)
        const tooClose = carPositions.some(
          (pos) => pos.distanceTo(center) < CELL_SIZE * 2
        );

        if (!tooClose) {
          const car = assets.crashedCar.clone(true);
          car.position.copy(center);
          car.rotation.y = (Math.floor(Math.random() * 4) * Math.PI) / 2;
          worldRoot.add(car);
          carPositions.push(center.clone());

          obstacles.push({
            bounds: new THREE.Box3(
              new THREE.Vector3(
                center.x - CELL_SIZE * 0.48,
                0,
                center.z - CELL_SIZE * 0.48
              ),
              new THREE.Vector3(
                center.x + CELL_SIZE * 0.48,
                obstacleHeight,
                center.z + CELL_SIZE * 0.48
              )
            ),
            center,
          });
          continue;
        }
      }

      // Regular obstacles
      const rand = Math.random();
      let visual: THREE.Group;
      let isCardboard = false;

      if (rand < 0.33) {
        visual = assets.container.clone(true);
        // Randomize container color
        const color =
          containerColors[Math.floor(Math.random() * containerColors.length)];
        visual.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => {
                if (mat instanceof THREE.MeshStandardMaterial) {
                  mat.color.set(color);
                }
              });
            } else if (child.material instanceof THREE.MeshStandardMaterial) {
              child.material.color.set(color);
            }
          }
        });
      } else if (rand < 0.66) {
        visual = assets.cardboardBoxes.clone(true);
        isCardboard = true;
      } else {
        visual = assets.ibcTank.clone(true);
      }

      visual.position.copy(center);
      visual.rotation.y = (Math.floor(Math.random() * 4) * Math.PI) / 2;
      worldRoot.add(visual);

      obstacles.push({
        bounds: new THREE.Box3(
          new THREE.Vector3(
            center.x - CELL_SIZE * 0.48,
            0,
            center.z - CELL_SIZE * 0.48
          ),
          new THREE.Vector3(
            center.x + CELL_SIZE * 0.48,
            obstacleHeight,
            center.z + CELL_SIZE * 0.48
          )
        ),
        center,
        destructible: isCardboard,
        health: isCardboard ? 50 : undefined,
        visual: visual,
        type: isCardboard ? 'cardboard' : (rand < 0.33 ? 'container' : 'ibc'),
      });
    }
  }

  scene.environment = null;

  return obstacles;
}
