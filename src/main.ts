import "./style.css";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type LoadedGLTF = Awaited<ReturnType<GLTFLoader["loadAsync"]>>;
type Team = "player" | "enemy";

type GridCell = {
  col: number;
  row: number;
};

type Obstacle = {
  bounds: THREE.Box3;
  center: THREE.Vector3;
};

type Projectile = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  ttl: number;
  owner: Team;
  damage: number;
};

type ArenaLayout = {
  blocked: boolean[][];
  walkable: GridCell[];
  playerSpawn: GridCell;
  enemySpawns: GridCell[];
};

type TankActor = {
  team: Team;
  group: THREE.Group;
  hull: THREE.Object3D;
  turret: THREE.Object3D;
  turretBaseQuaternion: THREE.Quaternion;
  ring: THREE.Mesh;
  radius: number;
  bodyHeading: number;
  turretHeading: number;
  velocity: THREE.Vector3;
  maxSpeed: number;
  fireCooldown: number;
  health: number;
  alive: boolean;
  path: GridCell[];
  repathTimer: number;
  lastTargetCell: string;
  strafeDirection: number;
};

type Assets = {
  tank: THREE.Group;
  container: THREE.Group;
  boxes: THREE.Group;
  glyph: THREE.Group;
};

class AudioBridge {
  private readonly context = new AudioContext();

  resume() {
    if (this.context.state === "suspended") {
      void this.context.resume();
    }
  }

  onShot() {
    this.resume();
    this.ping(135, 0.08, "square", 0.025);
  }

  onHit() {
    this.resume();
    this.ping(70, 0.18, "sawtooth", 0.05);
  }

  onPickup() {
    this.resume();
    this.ping(280, 0.12, "triangle", 0.03);
  }

  private ping(
    frequency: number,
    duration: number,
    type: OscillatorType,
    gainValue: number,
  ) {
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const start = this.context.currentTime;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);

    gain.gain.setValueAtTime(gainValue, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(gain);
    gain.connect(this.context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration);
  }
}

const GRID_SIZE = 23;
const CELL_SIZE = 4.5;
const HALF_GRID = (GRID_SIZE - 1) / 2;
const MAP_HALF = HALF_GRID * CELL_SIZE;
const CAMERA_HEIGHT = 42;
const CAMERA_HALF_HEIGHT = 17;

const viewportEl = document.querySelector<HTMLDivElement>("#viewport");
const statusNode = document.querySelector<HTMLParagraphElement>("#status");
const healthNode = document.querySelector<HTMLParagraphElement>("#health");
const scoreNode = document.querySelector<HTMLParagraphElement>("#score");
const enemiesNode = document.querySelector<HTMLParagraphElement>("#enemies");
const objectiveNode = document.querySelector<HTMLParagraphElement>("#objective");
const healthFillNode = document.querySelector<HTMLDivElement>("#health-fill");

if (
  !viewportEl ||
  !statusNode ||
  !healthNode ||
  !scoreNode ||
  !enemiesNode ||
  !objectiveNode ||
  !healthFillNode
) {
  throw new Error("Missing HUD nodes.");
}

const viewportNode = viewportEl;
const statusText = statusNode;
const healthText = healthNode;
const scoreText = scoreNode;
const enemiesText = enemiesNode;
const objectiveText = objectiveNode;
const healthFill = healthFillNode;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewportNode.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#071118");
scene.fog = new THREE.Fog("#071118", 50, 110);

const camera = new THREE.OrthographicCamera(
  -CAMERA_HALF_HEIGHT,
  CAMERA_HALF_HEIGHT,
  CAMERA_HALF_HEIGHT,
  -CAMERA_HALF_HEIGHT,
  0.1,
  200,
);
camera.up.set(0, 0, -1);

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pointerNdc = new THREE.Vector2(0, 0);
const pointerWorld = new THREE.Vector3(0, 0, 0);
const cameraFocus = new THREE.Vector3(0, 0, 0);
const clock = new THREE.Clock();
const audio = new AudioBridge();
const pressed = new Set<string>();

const obstacles: Obstacle[] = [];
const enemyTanks: TankActor[] = [];
const projectiles: Projectile[] = [];
const pickupAnchor = new THREE.Group();
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.38, 0.54, 28),
  new THREE.MeshBasicMaterial({ color: "#6de8ff", transparent: true, opacity: 0.92 }),
);
reticle.rotation.x = -Math.PI / 2;
reticle.position.y = 0.08;
scene.add(reticle);
scene.add(pickupAnchor);

let blockedGrid: boolean[][] = [];
let walkableCells: GridCell[] = [];
let playerTank: TankActor;
let score = 0;
let pickupCooldown = 0;
let pickupActive = false;
let fireQueued = false;

const assetUrls = {
  tank: new URL("../3d/mother_3_-_pork_tank.glb", import.meta.url).href,
  container: new URL("../3d/Shipping Container.glb", import.meta.url).href,
  boxes: new URL("../3d/Cardboard Boxes.glb", import.meta.url).href,
  glyph: new URL("../3d/spell_glyph.glb", import.meta.url).href,
};

function setStatus(message: string) {
  statusText.textContent = message;
}

function keyOf(cell: GridCell) {
  return `${cell.col},${cell.row}`;
}

function createGridValue<T>(factory: () => T) {
  return Array.from({ length: GRID_SIZE }, () =>
    Array.from({ length: GRID_SIZE }, factory),
  );
}

function inBounds(cell: GridCell) {
  return cell.col >= 0 && cell.col < GRID_SIZE && cell.row >= 0 && cell.row < GRID_SIZE;
}

function worldFromCell(cell: GridCell) {
  return new THREE.Vector3(
    (cell.col - HALF_GRID) * CELL_SIZE,
    0,
    (cell.row - HALF_GRID) * CELL_SIZE,
  );
}

function cellFromWorld(position: THREE.Vector3) {
  return {
    col: THREE.MathUtils.clamp(Math.round(position.x / CELL_SIZE + HALF_GRID), 0, GRID_SIZE - 1),
    row: THREE.MathUtils.clamp(Math.round(position.z / CELL_SIZE + HALF_GRID), 0, GRID_SIZE - 1),
  };
}

function neighbors4(cell: GridCell) {
  return [
    { col: cell.col + 1, row: cell.row },
    { col: cell.col - 1, row: cell.row },
    { col: cell.col, row: cell.row + 1 },
    { col: cell.col, row: cell.row - 1 },
  ].filter(inBounds);
}

function neighbors8(cell: GridCell) {
  const results: GridCell[] = [];
  for (let dc = -1; dc <= 1; dc += 1) {
    for (let dr = -1; dr <= 1; dr += 1) {
      if (dc === 0 && dr === 0) {
        continue;
      }
      const next = { col: cell.col + dc, row: cell.row + dr };
      if (inBounds(next)) {
        results.push(next);
      }
    }
  }
  return results;
}

function distance(a: GridCell, b: GridCell) {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

function floodReachable(start: GridCell, blocked: boolean[][]) {
  const queue: GridCell[] = [start];
  const visited = new Set<string>([keyOf(start)]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of neighbors4(current)) {
      if (blocked[neighbor.row][neighbor.col]) {
        continue;
      }
      const key = keyOf(neighbor);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push(neighbor);
      }
    }
  }

  return visited;
}

function reserveCells(center: GridCell, radius: number, set: Set<string>) {
  for (let dc = -radius; dc <= radius; dc += 1) {
    for (let dr = -radius; dr <= radius; dr += 1) {
      const cell = { col: center.col + dc, row: center.row + dr };
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

function generateLayout() {
  const playerSpawn = { col: HALF_GRID, row: GRID_SIZE - 3 };
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
        if (!blocked[row][col] && reachable.has(keyOf({ col, row }))) {
          walkable.push({ col, row });
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
          distance(cell, playerSpawn) >= 12,
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

function updateHud() {
  const enemiesAlive = enemyTanks.filter((enemy) => enemy.alive).length;
  const healthPercent = Math.max(0, Math.min(1, playerTank.health / 100));

  healthText.textContent = `Health ${Math.max(0, Math.ceil(playerTank.health))}`;
  scoreText.textContent = `Score ${score}`;
  enemiesText.textContent = `Enemies ${enemiesAlive}`;
  objectiveText.textContent = pickupActive
    ? "Objective: capture the glyph for repair"
    : "Objective: hold position and clear the arena";
  healthFill.style.transform = `scaleX(${healthPercent})`;
}

function angleLerp(current: number, target: number, smoothing: number) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * smoothing;
}

function approachVector(
  current: THREE.Vector3,
  target: THREE.Vector3,
  delta: number,
  responsiveness: number,
) {
  const factor = 1 - Math.exp(-delta * responsiveness);
  current.lerp(target, factor);
}

function applyStandardMaterialTweaks(material: THREE.Material) {
  if (
    material instanceof THREE.MeshStandardMaterial ||
    material instanceof THREE.MeshPhysicalMaterial
  ) {
    material.envMapIntensity = 0.7;
  }
}

function normalizeAsset(root: THREE.Group, targetFootprint: number) {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;

      if (Array.isArray(child.material)) {
        child.material.forEach(applyStandardMaterialTweaks);
      } else {
        applyStandardMaterialTweaks(child.material);
      }
    }
  });

  root.updateMatrixWorld(true);
  const initialBox = new THREE.Box3().setFromObject(root);
  const initialSize = initialBox.getSize(new THREE.Vector3());
  const footprint = Math.max(initialSize.x, initialSize.z);
  const scale = targetFootprint / footprint;

  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);

  const scaledBox = new THREE.Box3().setFromObject(root);
  const center = scaledBox.getCenter(new THREE.Vector3());

  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= scaledBox.min.y;
  root.updateMatrixWorld(true);

  return root;
}

async function loadAssets() {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url, loaded, total) => {
    setStatus(`Loading assets ${loaded}/${total}...`);
  };

  const loader = new GLTFLoader(manager);
  const [tankGltf, containerGltf, boxesGltf, glyphGltf]: [
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
  ] = await Promise.all([
    loader.loadAsync(assetUrls.tank),
    loader.loadAsync(assetUrls.container),
    loader.loadAsync(assetUrls.boxes),
    loader.loadAsync(assetUrls.glyph),
  ]);

  return {
    tank: normalizeAsset(tankGltf.scene, 2.6),
    container: normalizeAsset(containerGltf.scene, 4.3),
    boxes: normalizeAsset(boxesGltf.scene, 2.4),
    glyph: normalizeAsset(glyphGltf.scene, 1.9),
  } satisfies Assets;
}

function createLights() {
  scene.add(new THREE.AmbientLight("#a9d8ff", 1.5));

  const sun = new THREE.DirectionalLight("#fff3d9", 2.35);
  sun.position.set(24, 44, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  scene.add(sun);

  const fill = new THREE.DirectionalLight("#47c8ff", 0.75);
  fill.position.set(-16, 18, -20);
  scene.add(fill);
}

function createFloor() {
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
  scene.add(base);

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
  scene.add(arenaPlate);

  const grid = new THREE.GridHelper(GRID_SIZE * CELL_SIZE, GRID_SIZE, "#58b7ff", "#174055");
  grid.position.y = 0.03;
  scene.add(grid);

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
  scene.add(border);
}

function buildArenaVisuals(assets: Assets, layout: ArenaLayout) {
  blockedGrid = layout.blocked;
  walkableCells = layout.walkable;

  const obstacleHeight = 2.8;

  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let col = 0; col < GRID_SIZE; col += 1) {
      if (!blockedGrid[row][col]) {
        continue;
      }

      const cell = { col, row };
      const center = worldFromCell(cell);
      const horizontalNeighbors =
        Number(col > 0 && blockedGrid[row][col - 1]) +
        Number(col < GRID_SIZE - 1 && blockedGrid[row][col + 1]);
      const verticalNeighbors =
        Number(row > 0 && blockedGrid[row - 1][col]) +
        Number(row < GRID_SIZE - 1 && blockedGrid[row + 1][col]);

      const visual =
        horizontalNeighbors + verticalNeighbors >= 2 || Math.random() > 0.5
          ? assets.container.clone(true)
          : assets.boxes.clone(true);

      visual.position.copy(center);
      visual.rotation.y =
        horizontalNeighbors > verticalNeighbors ? Math.PI / 2 : (Math.floor(Math.random() * 4) * Math.PI) / 2;
      scene.add(visual);

      const bounds = new THREE.Box3(
        new THREE.Vector3(center.x - CELL_SIZE * 0.48, 0, center.z - CELL_SIZE * 0.48),
        new THREE.Vector3(center.x + CELL_SIZE * 0.48, obstacleHeight, center.z + CELL_SIZE * 0.48),
      );
      obstacles.push({ bounds, center });
    }
  }
}

function createTank(assets: Assets, team: Team, spawn: GridCell) {
  const group = new THREE.Group();
  group.position.copy(worldFromCell(spawn));

  const visual = assets.tank.clone(true);
  const hull = visual.getObjectByName("Object001");
  const turret = visual.getObjectByName("Object002");

  if (!hull || !turret) {
    throw new Error("Tank asset is missing expected hull/turret nodes.");
  }

  group.add(visual);

  const ringMaterial = new THREE.MeshStandardMaterial({
    color: team === "player" ? "#59eeb3" : "#ff7f73",
    emissive: team === "player" ? "#1c6d50" : "#6c241c",
    roughness: 0.35,
    metalness: 0.08,
  });

  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(1.24, 1.24, 0.08, 28),
    ringMaterial,
  );
  ring.position.y = 0.05;
  ring.receiveShadow = true;
  group.add(ring);

  scene.add(group);

  return {
    team,
    group,
    hull,
    turret,
    turretBaseQuaternion: turret.quaternion.clone(),
    ring,
    radius: 1.05,
    bodyHeading: Math.PI,
    turretHeading: Math.PI,
    velocity: new THREE.Vector3(),
    maxSpeed: team === "player" ? 9 : 6,
    fireCooldown: team === "player" ? 0 : 1,
    health: 100,
    alive: true,
    path: [],
    repathTimer: 0,
    lastTargetCell: "",
    strafeDirection: Math.random() > 0.5 ? 1 : -1,
  } satisfies TankActor;
}

function forwardFromHeading(heading: number) {
  return new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
}

function circleIntersectsBox(position: THREE.Vector3, radius: number, box: THREE.Box3) {
  const closestX = THREE.MathUtils.clamp(position.x, box.min.x, box.max.x);
  const closestZ = THREE.MathUtils.clamp(position.z, box.min.z, box.max.z);
  const dx = position.x - closestX;
  const dz = position.z - closestZ;
  return dx * dx + dz * dz < radius * radius;
}

function collidesWithArena(position: THREE.Vector3, radius: number) {
  if (Math.abs(position.x) > MAP_HALF - radius || Math.abs(position.z) > MAP_HALF - radius) {
    return true;
  }
  return obstacles.some((obstacle) => circleIntersectsBox(position, radius, obstacle.bounds));
}

function tryMoveTank(tank: TankActor, movement: THREE.Vector3) {
  const candidateX = tank.group.position.clone();
  candidateX.x += movement.x;
  if (!collidesWithArena(candidateX, tank.radius)) {
    tank.group.position.x = candidateX.x;
  } else {
    tank.velocity.x *= 0.2;
  }

  const candidateZ = tank.group.position.clone();
  candidateZ.z += movement.z;
  if (!collidesWithArena(candidateZ, tank.radius)) {
    tank.group.position.z = candidateZ.z;
  } else {
    tank.velocity.z *= 0.2;
  }
}

function updateTankVisual(tank: TankActor) {
  tank.group.rotation.y = tank.bodyHeading;
  const relativeTurretHeading = tank.turretHeading - tank.bodyHeading;
  tank.turret.quaternion
    .copy(tank.turretBaseQuaternion)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), relativeTurretHeading));
}

function fireProjectile(tank: TankActor, color: string) {
  const direction = forwardFromHeading(tank.turretHeading).normalize();
  const spawn = tank.group.position.clone().add(direction.clone().multiplyScalar(1.55));
  spawn.y = 0.78;

  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 10, 10),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.55,
    }),
  );
  shell.position.copy(spawn);
  shell.castShadow = true;
  scene.add(shell);

  projectiles.push({
    mesh: shell,
    velocity: direction.multiplyScalar(22),
    ttl: 2.3,
    owner: tank.team,
    damage: 22,
  });

  tank.fireCooldown = tank.team === "player" ? 0.18 : 0.95;
  audio.onShot();
}

function acquirePointerWorld() {
  raycaster.setFromCamera(pointerNdc, camera);
  raycaster.ray.intersectPlane(aimPlane, pointerWorld);
}

function lineOfSightBlocked(start: THREE.Vector3, end: THREE.Vector3) {
  const direction = end.clone().sub(start);
  const distanceToTarget = direction.length();
  direction.normalize();

  const ray = new THREE.Ray(start, direction);
  const hitPoint = new THREE.Vector3();

  return obstacles.some((obstacle) => {
    const hit = ray.intersectBox(obstacle.bounds, hitPoint);
    return hit !== null && hit.distanceTo(start) < distanceToTarget;
  });
}

function heuristic(a: GridCell, b: GridCell) {
  return Math.hypot(a.col - b.col, a.row - b.row);
}

function reconstructPath(cameFrom: Map<string, string>, end: GridCell) {
  const path: GridCell[] = [end];
  let currentKey = keyOf(end);

  while (cameFrom.has(currentKey)) {
    const previousKey = cameFrom.get(currentKey)!;
    const [col, row] = previousKey.split(",").map(Number);
    path.push({ col, row });
    currentKey = previousKey;
  }

  return path.reverse();
}

function findPath(start: GridCell, goal: GridCell) {
  const open = new Set<string>([keyOf(start)]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[keyOf(start), 0]]);
  const fScore = new Map<string, number>([[keyOf(start), heuristic(start, goal)]]);

  while (open.size > 0) {
    let currentKey = "";
    let bestScore = Number.POSITIVE_INFINITY;

    for (const key of open) {
      const scoreValue = fScore.get(key) ?? Number.POSITIVE_INFINITY;
      if (scoreValue < bestScore) {
        bestScore = scoreValue;
        currentKey = key;
      }
    }

    const [col, row] = currentKey.split(",").map(Number);
    const current = { col, row };

    if (current.col === goal.col && current.row === goal.row) {
      return reconstructPath(cameFrom, current);
    }

    open.delete(currentKey);

    for (const neighbor of neighbors8(current)) {
      if (blockedGrid[neighbor.row][neighbor.col]) {
        continue;
      }

      const isDiagonal = neighbor.col !== current.col && neighbor.row !== current.row;
      if (isDiagonal) {
        if (
          blockedGrid[current.row][neighbor.col] ||
          blockedGrid[neighbor.row][current.col]
        ) {
          continue;
        }
      }

      const tentativeScore =
        (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + (isDiagonal ? Math.SQRT2 : 1);
      const neighborKey = keyOf(neighbor);

      if (tentativeScore < (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
        cameFrom.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentativeScore);
        fScore.set(neighborKey, tentativeScore + heuristic(neighbor, goal));
        open.add(neighborKey);
      }
    }
  }

  return [] as GridCell[];
}

function sampleWalkableCell() {
  return walkableCells[Math.floor(Math.random() * walkableCells.length)];
}

function updatePlayer(delta: number) {
  const input = new THREE.Vector3(
    Number(pressed.has("KeyD")) - Number(pressed.has("KeyA")),
    0,
    Number(pressed.has("KeyS")) - Number(pressed.has("KeyW")),
  );

  const desiredVelocity = new THREE.Vector3();
  if (input.lengthSq() > 0) {
    input.normalize();
    desiredVelocity.copy(input).multiplyScalar(playerTank.maxSpeed);
  }

  approachVector(playerTank.velocity, desiredVelocity, delta, input.lengthSq() > 0 ? 10 : 6);
  tryMoveTank(playerTank, playerTank.velocity.clone().multiplyScalar(delta));

  if (playerTank.velocity.lengthSq() > 0.2) {
    playerTank.bodyHeading = angleLerp(
      playerTank.bodyHeading,
      Math.atan2(playerTank.velocity.x, playerTank.velocity.z),
      1 - Math.exp(-delta * 10),
    );
  }

  playerTank.turretHeading = Math.atan2(
    pointerWorld.x - playerTank.group.position.x,
    pointerWorld.z - playerTank.group.position.z,
  );

  playerTank.fireCooldown = Math.max(0, playerTank.fireCooldown - delta);
  if ((fireQueued || pressed.has("Space")) && playerTank.fireCooldown <= 0) {
    fireProjectile(playerTank, "#76f2ff");
  }

  updateTankVisual(playerTank);
}

function pathDirection(enemy: TankActor) {
  if (enemy.path.length <= 1) {
    return new THREE.Vector3();
  }

  const currentPositionCell = cellFromWorld(enemy.group.position);
  const first = enemy.path[0];

  if (first.col === currentPositionCell.col && first.row === currentPositionCell.row) {
    enemy.path.shift();
  }

  const nextCell = enemy.path[Math.min(1, enemy.path.length - 1)];
  const targetWorld = worldFromCell(nextCell);
  const direction = targetWorld.sub(enemy.group.position);

  if (direction.length() < 0.75 && enemy.path.length > 1) {
    enemy.path.shift();
  }

  direction.y = 0;
  return direction.normalize();
}

function avoidNeighbors(enemy: TankActor) {
  const repulsion = new THREE.Vector3();
  for (const other of enemyTanks) {
    if (other === enemy || !other.alive) {
      continue;
    }
    const away = enemy.group.position.clone().sub(other.group.position);
    const distanceToOther = away.length();
    if (distanceToOther > 0 && distanceToOther < 4.2) {
      repulsion.add(away.normalize().multiplyScalar((4.2 - distanceToOther) * 0.9));
    }
  }
  return repulsion;
}

function updateEnemy(enemy: TankActor, delta: number) {
  if (!enemy.alive) {
    return;
  }

  const toPlayer = playerTank.group.position.clone().sub(enemy.group.position);
  const playerCell = cellFromWorld(playerTank.group.position);
  const enemyCell = cellFromWorld(enemy.group.position);
  const playerKey = keyOf(playerCell);

  enemy.repathTimer -= delta;
  if (
    enemy.repathTimer <= 0 ||
    enemy.lastTargetCell !== playerKey ||
    enemy.path.length === 0
  ) {
    enemy.path = findPath(enemyCell, playerCell);
    enemy.repathTimer = 0.65 + Math.random() * 0.35;
    enemy.lastTargetCell = playerKey;
  }

  const hasLineOfSight = !lineOfSightBlocked(enemy.group.position, playerTank.group.position);
  const distanceToPlayer = toPlayer.length();
  const desiredVelocity = new THREE.Vector3();

  if (hasLineOfSight) {
    const forward = toPlayer.normalize();
    const strafe = new THREE.Vector3(forward.z, 0, -forward.x).multiplyScalar(enemy.strafeDirection);

    if (distanceToPlayer > 13) {
      desiredVelocity.add(forward.multiplyScalar(enemy.maxSpeed * 0.8));
    } else if (distanceToPlayer < 8) {
      desiredVelocity.add(forward.multiplyScalar(-enemy.maxSpeed * 0.7));
    }

    desiredVelocity.add(strafe.multiplyScalar(enemy.maxSpeed * 0.62));
  } else {
    desiredVelocity.add(pathDirection(enemy).multiplyScalar(enemy.maxSpeed));
  }

  desiredVelocity.add(avoidNeighbors(enemy));

  if (desiredVelocity.lengthSq() > enemy.maxSpeed * enemy.maxSpeed) {
    desiredVelocity.normalize().multiplyScalar(enemy.maxSpeed);
  }

  approachVector(enemy.velocity, desiredVelocity, delta, 5.5);
  tryMoveTank(enemy, enemy.velocity.clone().multiplyScalar(delta));

  if (enemy.velocity.lengthSq() > 0.08) {
    enemy.bodyHeading = angleLerp(
      enemy.bodyHeading,
      Math.atan2(enemy.velocity.x, enemy.velocity.z),
      1 - Math.exp(-delta * 8),
    );
  }

  enemy.turretHeading = angleLerp(
    enemy.turretHeading,
    Math.atan2(toPlayer.x, toPlayer.z),
    1 - Math.exp(-delta * 11),
  );

  enemy.fireCooldown = Math.max(0, enemy.fireCooldown - delta);
  const aimError = Math.abs(
    Math.atan2(
      Math.sin(enemy.turretHeading - Math.atan2(toPlayer.x, toPlayer.z)),
      Math.cos(enemy.turretHeading - Math.atan2(toPlayer.x, toPlayer.z)),
    ),
  );

  if (
    hasLineOfSight &&
    distanceToPlayer < 26 &&
    enemy.fireCooldown <= 0 &&
    aimError < 0.14
  ) {
    fireProjectile(enemy, "#ff9e73");
  }

  updateTankVisual(enemy);
}

function damageTank(target: TankActor, amount: number) {
  target.health -= amount;

  if (target.team === "player") {
    const material = target.ring.material as THREE.MeshStandardMaterial;
    material.color.set("#ffd86c");
    material.emissive.set("#6f4e16");
  }

  if (target.health <= 0 && target.alive) {
    target.alive = false;
    target.group.visible = false;

    if (target.team === "enemy") {
      score += 120;
      setStatus("Enemy tank destroyed.");
    } else {
      setStatus("Player destroyed. Refresh to restart.");
    }
  }
}

function removeProjectileAt(index: number) {
  const projectile = projectiles[index];
  scene.remove(projectile.mesh);
  projectile.mesh.geometry.dispose();
  (projectile.mesh.material as THREE.Material).dispose();
  projectiles.splice(index, 1);
}

function updateProjectiles(delta: number) {
  const targetPoint = new THREE.Vector3();

  for (let index = projectiles.length - 1; index >= 0; index -= 1) {
    const projectile = projectiles[index];
    projectile.mesh.position.addScaledVector(projectile.velocity, delta);
    projectile.ttl -= delta;

    if (
      Math.abs(projectile.mesh.position.x) > MAP_HALF + 2 ||
      Math.abs(projectile.mesh.position.z) > MAP_HALF + 2 ||
      projectile.ttl <= 0
    ) {
      removeProjectileAt(index);
      continue;
    }

    if (obstacles.some((obstacle) => obstacle.bounds.containsPoint(projectile.mesh.position))) {
      removeProjectileAt(index);
      continue;
    }

    const targets = projectile.owner === "player" ? enemyTanks : [playerTank];
    let consumed = false;

    for (const target of targets) {
      if (!target.alive) {
        continue;
      }

      targetPoint.copy(target.group.position);
      targetPoint.y = projectile.mesh.position.y;
      if (targetPoint.distanceTo(projectile.mesh.position) < target.radius + 0.25) {
        damageTank(target, projectile.damage);
        audio.onHit();
        removeProjectileAt(index);
        consumed = true;
        break;
      }
    }

    if (consumed) {
      continue;
    }
  }
}

function placePickup() {
  let candidate = sampleWalkableCell();

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const next = sampleWalkableCell();
    if (distance(next, cellFromWorld(playerTank.group.position)) > 7) {
      candidate = next;
      break;
    }
  }

  pickupAnchor.position.copy(worldFromCell(candidate));
  pickupAnchor.position.y = 0.5;
  pickupAnchor.visible = true;
  pickupActive = true;
}

function updatePickup(delta: number) {
  pickupAnchor.rotation.y += delta * 1.5;
  pickupAnchor.position.y = 0.55 + Math.sin(clock.getElapsedTime() * 2) * 0.16;

  if (!pickupActive) {
    pickupCooldown -= delta;
    if (pickupCooldown <= 0 && playerTank.alive) {
      placePickup();
    }
    return;
  }

  if (playerTank.group.position.distanceTo(pickupAnchor.position) < 1.8) {
    pickupActive = false;
    pickupAnchor.visible = false;
    pickupCooldown = 8;
    playerTank.health = Math.min(100, playerTank.health + 32);
    score += 35;
    audio.onPickup();
    setStatus("Glyph captured. Armor restored.");
  }
}

function updateCamera(delta: number) {
  const desiredFocus = playerTank.group.position.clone();
  desiredFocus.y = 0;
  approachVector(cameraFocus, desiredFocus, delta, 7);

  camera.position.set(cameraFocus.x, CAMERA_HEIGHT, cameraFocus.z);
  camera.lookAt(cameraFocus.x, 0, cameraFocus.z);

  reticle.position.set(pointerWorld.x, 0.08, pointerWorld.z);
}

function updateStatusLine() {
  if (!playerTank.alive) {
    setStatus("Player destroyed. Refresh to restart.");
    return;
  }

  const enemiesAlive = enemyTanks.filter((enemy) => enemy.alive).length;
  if (enemiesAlive === 0) {
    setStatus("Arena clear. You won this round.");
    return;
  }

  setStatus("Top-down combat active. Use cover and keep moving.");
}

function resize() {
  const width = viewportNode.clientWidth;
  const height = viewportNode.clientHeight;
  const aspect = width / Math.max(height, 1);

  camera.left = -CAMERA_HALF_HEIGHT * aspect;
  camera.right = CAMERA_HALF_HEIGHT * aspect;
  camera.top = CAMERA_HALF_HEIGHT;
  camera.bottom = -CAMERA_HALF_HEIGHT;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height, false);
}

function animate() {
  const delta = Math.min(clock.getDelta(), 0.05);

  if (playerTank.alive) {
    acquirePointerWorld();
    updatePlayer(delta);
    for (const enemy of enemyTanks) {
      updateEnemy(enemy, delta);
    }
  }

  updateProjectiles(delta);
  updatePickup(delta);
  updateCamera(delta);
  updateStatusLine();
  updateHud();

  fireQueued = false;
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

async function init() {
  setStatus("Loading arena assets...");
  createLights();
  createFloor();

  const assets = await loadAssets();
  const layout = generateLayout();
  buildArenaVisuals(assets, layout);

  const pickupVisual = assets.glyph.clone(true);
  pickupAnchor.add(pickupVisual);

  playerTank = createTank(assets, "player", layout.playerSpawn);
  updateTankVisual(playerTank);

  for (const spawn of layout.enemySpawns) {
    const enemy = createTank(assets, "enemy", spawn);
    enemy.bodyHeading = 0;
    enemy.turretHeading = 0;
    updateTankVisual(enemy);
    enemyTanks.push(enemy);
  }

  placePickup();
  updateHud();
  resize();
  setStatus("Arena ready.");
  animate();
}

renderer.domElement.addEventListener("pointermove", (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
});

renderer.domElement.addEventListener("pointerdown", () => {
  fireQueued = true;
  audio.resume();
});

window.addEventListener("keydown", (event) => {
  pressed.add(event.code);
  if (event.code === "Space") {
    fireQueued = true;
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  pressed.delete(event.code);
});

window.addEventListener("resize", resize);

void init().catch((error: unknown) => {
  console.error(error);
  setStatus("Failed to initialize arena.");
});
