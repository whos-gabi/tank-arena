import * as THREE from "three";
import { GRID_SIZE, MAP_HALF, CELL_SIZE } from "./config";
import { Assets } from "./assets";
import {
  GridCell,
  createGridValue,
  gridDistance,
  inBounds,
  keyOf,
  neighbors4,
  worldFromCell,
} from "./grid";

export type Obstacle = {
  bounds: THREE.Box3;
  center: THREE.Vector3;
};

export type ArenaLayout = {
  blocked: boolean[][];
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

function reserveCells(center: GridCell, radius: number, set: Set<string>) {
  for (let dc = -radius; dc <= radius; dc += 1) {
    for (let dr = -radius; dr <= radius; dr += 1) {
      const cell = {
        col: center.col + dc,
        row: center.row + dr,
      };
      if (inBounds(cell)) {
        set.add(keyOf(cell));
      }
    }
  }
}

function rotatePattern(pattern: GridCell[], turns: number) {
  let rotated = pattern.map((cell) => ({ ...cell }));
  for (let step = 0; step < turns; step += 1) {
    rotated = rotated.map((cell) => ({
      col: -cell.row,
      row: cell.col,
    }));
  }
  return rotated;
}

export function generateLayout() {
  const center = Math.floor(GRID_SIZE / 2);
  const playerSpawn = { col: center, row: GRID_SIZE - 3 };
  const enemyRegions = [
    { minCol: 2, maxCol: 7, minRow: 2, maxRow: 6 },
    { minCol: 8, maxCol: 14, minRow: 1, maxRow: 4 },
    { minCol: 15, maxCol: 20, minRow: 2, maxRow: 6 },
    { minCol: 4, maxCol: 8, minRow: 7, maxRow: 10 },
    { minCol: 14, maxCol: 18, minRow: 7, maxRow: 10 },
  ];

  const patterns: GridCell[][] = [
    [{ col: 0, row: 0 }],
    [{ col: 0, row: 0 }, { col: 1, row: 0 }],
    [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }],
    [{ col: 0, row: 0 }, { col: 0, row: 1 }],
    [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 }],
    [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 }, { col: 1, row: 1 }],
    [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 1, row: 1 }],
    [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 1, row: 1 }, { col: 2, row: 1 }],
  ];

  const reserved = new Set<string>();
  reserveCells(playerSpawn, 2, reserved);
  for (const region of enemyRegions) {
    reserveCells(
      {
        col: Math.round((region.minCol + region.maxCol) / 2),
        row: Math.round((region.minRow + region.maxRow) / 2),
      },
      1,
      reserved,
    );
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const blocked = createGridValue(() => false);

    for (let col = 0; col < GRID_SIZE; col += 1) {
      blocked[0][col] = true;
      blocked[GRID_SIZE - 1][col] = true;
    }

    for (let row = 0; row < GRID_SIZE; row += 1) {
      blocked[row][0] = true;
      blocked[row][GRID_SIZE - 1] = true;
    }

    let placed = 0;
    const targetPlacements = 58;

    for (let patternAttempt = 0; patternAttempt < 260 && placed < targetPlacements; patternAttempt += 1) {
      const pattern = patterns[Math.floor(Math.random() * patterns.length)];
      const rotated = rotatePattern(pattern, Math.floor(Math.random() * 4));
      const anchor = {
        col: THREE.MathUtils.randInt(1, GRID_SIZE - 2),
        row: THREE.MathUtils.randInt(1, GRID_SIZE - 2),
      };

      const cells = rotated.map((cell) => ({
        col: cell.col + anchor.col,
        row: cell.row + anchor.row,
      }));

      const valid = cells.every((cell) => {
        if (!inBounds(cell)) {
          return false;
        }
        if (cell.col <= 0 || cell.row <= 0 || cell.col >= GRID_SIZE - 1 || cell.row >= GRID_SIZE - 1) {
          return false;
        }
        if (blocked[cell.row][cell.col]) {
          return false;
        }
        if (reserved.has(keyOf(cell))) {
          return false;
        }
        return true;
      });

      if (!valid) {
        continue;
      }

      cells.forEach((cell) => {
        blocked[cell.row][cell.col] = true;
      });
      placed += cells.length;
    }

    const reachable = floodReachable(playerSpawn, blocked);
    const walkable: GridCell[] = [];
    for (let row = 1; row < GRID_SIZE - 1; row += 1) {
      for (let col = 1; col < GRID_SIZE - 1; col += 1) {
        const cell = { col, row };
        if (!blocked[row][col] && reachable.has(keyOf(cell))) {
          walkable.push(cell);
        }
      }
    }

    if (walkable.length < 190) {
      continue;
    }

    const enemySpawns: GridCell[] = [];
    for (const region of enemyRegions) {
      const options = walkable.filter(
        (cell) =>
          cell.col >= region.minCol &&
          cell.col <= region.maxCol &&
          cell.row >= region.minRow &&
          cell.row <= region.maxRow &&
          gridDistance(cell, playerSpawn) >= 12,
      );

      if (options.length === 0) {
        break;
      }

      enemySpawns.push(options[Math.floor(Math.random() * options.length)]);
      if (enemySpawns.length === 4) {
        break;
      }
    }

    if (enemySpawns.length >= 4) {
      return {
        blocked,
        walkable,
        playerSpawn,
        enemySpawns,
      } satisfies ArenaLayout;
    }
  }

  throw new Error("Failed to generate a connected arena.");
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

  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_SIZE * CELL_SIZE, GRID_SIZE * CELL_SIZE),
    new THREE.MeshStandardMaterial({
      color: "#122531",
      roughness: 0.98,
      metalness: 0.02,
    }),
  );
  base.rotation.x = -Math.PI / 2;
  base.receiveShadow = true;
  floorRoot.add(base);

  const arenaPlate = new THREE.Mesh(
    new THREE.PlaneGeometry((GRID_SIZE - 2) * CELL_SIZE, (GRID_SIZE - 2) * CELL_SIZE),
    new THREE.MeshStandardMaterial({
      color: "#183645",
      roughness: 0.9,
      metalness: 0.06,
    }),
  );
  arenaPlate.rotation.x = -Math.PI / 2;
  arenaPlate.position.y = 0.01;
  arenaPlate.receiveShadow = true;
  floorRoot.add(arenaPlate);

  const grid = new THREE.GridHelper(GRID_SIZE * CELL_SIZE, GRID_SIZE, "#58b7ff", "#174055");
  grid.position.y = 0.03;
  floorRoot.add(grid);

  const border = new THREE.Mesh(
    new THREE.TorusGeometry(GRID_SIZE * CELL_SIZE * 0.49, 0.35, 12, 64),
    new THREE.MeshStandardMaterial({
      color: "#6ae4ff",
      emissive: "#124556",
      roughness: 0.28,
      metalness: 0.22,
    }),
  );
  border.rotation.x = Math.PI / 2;
  border.position.y = 0.05;
  floorRoot.add(border);

  const obstacleHeight = 2.8;
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let col = 0; col < GRID_SIZE; col += 1) {
      if (!layout.blocked[row][col]) {
        continue;
      }

      const cell = { col, row };
      const center = worldFromCell(cell);
      const horizontalNeighbors =
        Number(col > 0 && layout.blocked[row][col - 1]) +
        Number(col < GRID_SIZE - 1 && layout.blocked[row][col + 1]);
      const verticalNeighbors =
        Number(row > 0 && layout.blocked[row - 1][col]) +
        Number(row < GRID_SIZE - 1 && layout.blocked[row + 1][col]);

      const visual =
        horizontalNeighbors + verticalNeighbors >= 2 || Math.random() > 0.5
          ? assets.container.clone(true)
          : assets.boxes.clone(true);

      visual.position.copy(center);
      visual.rotation.y =
        horizontalNeighbors > verticalNeighbors ? Math.PI / 2 : (Math.floor(Math.random() * 4) * Math.PI) / 2;
      worldRoot.add(visual);

      obstacles.push({
        bounds: new THREE.Box3(
          new THREE.Vector3(center.x - CELL_SIZE * 0.48, 0, center.z - CELL_SIZE * 0.48),
          new THREE.Vector3(center.x + CELL_SIZE * 0.48, obstacleHeight, center.z + CELL_SIZE * 0.48),
        ),
        center,
      });
    }
  }

  const environmentRing = new THREE.Mesh(
    new THREE.TorusGeometry(MAP_HALF + 10, 6, 16, 100),
    new THREE.MeshStandardMaterial({
      color: "#09141c",
      roughness: 1,
      metalness: 0.01,
    }),
  );
  environmentRing.rotation.x = Math.PI / 2;
  environmentRing.position.y = -6;
  worldRoot.add(environmentRing);

  const skylineMaterial = new THREE.MeshStandardMaterial({
    color: "#203643",
    roughness: 0.95,
    metalness: 0.04,
  });

  for (let index = 0; index < 18; index += 1) {
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(
        THREE.MathUtils.randFloat(4, 9),
        THREE.MathUtils.randFloat(10, 22),
        THREE.MathUtils.randFloat(4, 9),
      ),
      skylineMaterial,
    );

    const angle = (index / 18) * Math.PI * 2;
    const radius = MAP_HALF + THREE.MathUtils.randFloat(11, 18);
    block.position.set(Math.cos(angle) * radius, block.geometry.parameters.height / 2 - 1, Math.sin(angle) * radius);
    block.castShadow = true;
    block.receiveShadow = true;
    worldRoot.add(block);
  }

  scene.environment = null;

  return obstacles;
}
