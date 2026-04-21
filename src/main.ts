import "./style.css";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type LoadedGLTF = Awaited<ReturnType<GLTFLoader["loadAsync"]>>;
type Team = "player" | "enemy";

type Obstacle = {
  bounds: THREE.Box3;
};

type Projectile = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  ttl: number;
  owner: Team;
  damage: number;
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
  speed: number;
  fireCooldown: number;
  health: number;
  alive: boolean;
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

const viewportEl = document.querySelector<HTMLDivElement>("#viewport");
const statusNode = document.querySelector<HTMLParagraphElement>("#status");
const healthNode = document.querySelector<HTMLParagraphElement>("#health");
const scoreNode = document.querySelector<HTMLParagraphElement>("#score");
const enemiesNode = document.querySelector<HTMLParagraphElement>("#enemies");

if (!viewportEl || !statusNode || !healthNode || !scoreNode || !enemiesNode) {
  throw new Error("Missing HUD nodes.");
}

const viewportNode = viewportEl;
const statusText = statusNode;
const healthText = healthNode;
const scoreText = scoreNode;
const enemiesText = enemiesNode;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
viewportNode.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#06111a");
scene.fog = new THREE.Fog("#06111a", 25, 58);

const camera = new THREE.OrthographicCamera(-16, 16, 16, -16, 0.1, 120);
camera.position.set(0, 28, 0.01);
camera.lookAt(0, 0, 0);

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pointerNdc = new THREE.Vector2(0, 0);
const pointerWorld = new THREE.Vector3(0, 0, 0);
const clock = new THREE.Clock();
const audio = new AudioBridge();
const pressed = new Set<string>();

const projectiles: Projectile[] = [];
const obstacles: Obstacle[] = [];
const enemyTanks: TankActor[] = [];

const arenaRadius = 15;
const reticle = new THREE.Mesh(
  new THREE.TorusGeometry(0.5, 0.06, 12, 24),
  new THREE.MeshBasicMaterial({ color: "#6be9ff" }),
);
reticle.rotation.x = Math.PI / 2;
reticle.position.y = 0.05;
scene.add(reticle);

const pickupAnchor = new THREE.Group();
scene.add(pickupAnchor);

let playerTank: TankActor;
let score = 0;
let pickupCooldown = 0;
let pickupActive = true;
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

function updateHud() {
  const enemiesAlive = enemyTanks.filter((enemy) => enemy.alive).length;
  healthText.textContent = `Health: ${Math.max(0, Math.ceil(playerTank.health))}`;
  scoreText.textContent = `Score: ${score}`;
  enemiesText.textContent = `Enemies: ${enemiesAlive}`;
}

function angleLerp(current: number, target: number, smoothing: number) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * smoothing;
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

  const assets: Assets = {
    tank: normalizeAsset(tankGltf.scene, 2.6),
    container: normalizeAsset(containerGltf.scene, 4.6),
    boxes: normalizeAsset(boxesGltf.scene, 1.8),
    glyph: normalizeAsset(glyphGltf.scene, 1.6),
  };

  return assets;
}

function createFloor() {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(arenaRadius + 2, 48),
    new THREE.MeshStandardMaterial({
      color: "#24404c",
      roughness: 0.95,
      metalness: 0.04,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const innerPlate = new THREE.Mesh(
    new THREE.CircleGeometry(arenaRadius - 1.4, 48),
    new THREE.MeshStandardMaterial({
      color: "#2b5362",
      roughness: 0.88,
      metalness: 0.08,
    }),
  );
  innerPlate.rotation.x = -Math.PI / 2;
  innerPlate.position.y = 0.02;
  innerPlate.receiveShadow = true;
  scene.add(innerPlate);

  const grid = new THREE.GridHelper(2 * arenaRadius, 18, "#79d4ff", "#174354");
  grid.position.y = 0.03;
  scene.add(grid);
}

function createLights() {
  scene.add(new THREE.AmbientLight("#b6ddff", 1.55));

  const keyLight = new THREE.DirectionalLight("#fff3db", 2.2);
  keyLight.position.set(10, 18, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = -22;
  keyLight.shadow.camera.right = 22;
  keyLight.shadow.camera.top = 22;
  keyLight.shadow.camera.bottom = -22;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight("#58c9ff", 0.8);
  fillLight.position.set(-8, 10, -12);
  scene.add(fillLight);
}

function addObstacle(object: THREE.Object3D) {
  scene.add(object);

  const bounds = new THREE.Box3().setFromObject(object).expandByScalar(0.15);
  obstacles.push({ bounds });
}

function createArenaProps(assets: Assets) {
  const placements = [
    { template: assets.container, position: new THREE.Vector3(-7.5, 0, -6.5), rotation: 0 },
    { template: assets.container, position: new THREE.Vector3(7.5, 0, 5.8), rotation: Math.PI / 2 },
    { template: assets.container, position: new THREE.Vector3(0, 0, -11), rotation: Math.PI / 2 },
    { template: assets.boxes, position: new THREE.Vector3(-4.4, 0, 8.6), rotation: 0 },
    { template: assets.boxes, position: new THREE.Vector3(4.8, 0, -1.2), rotation: Math.PI / 3 },
    { template: assets.boxes, position: new THREE.Vector3(-11, 0, 2.3), rotation: -Math.PI / 6 },
    { template: assets.boxes, position: new THREE.Vector3(10.2, 0, -8.6), rotation: Math.PI / 5 },
  ];

  for (const placement of placements) {
    const clone = placement.template.clone(true);
    clone.position.copy(placement.position);
    clone.rotation.y = placement.rotation;
    addObstacle(clone);
  }

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: "#4c6772",
    roughness: 0.88,
    metalness: 0.1,
  });

  const walls = [
    { size: new THREE.Vector3(arenaRadius * 2, 2, 1), position: new THREE.Vector3(0, 1, arenaRadius + 0.6) },
    { size: new THREE.Vector3(arenaRadius * 2, 2, 1), position: new THREE.Vector3(0, 1, -arenaRadius - 0.6) },
    { size: new THREE.Vector3(1, 2, arenaRadius * 2), position: new THREE.Vector3(arenaRadius + 0.6, 1, 0) },
    { size: new THREE.Vector3(1, 2, arenaRadius * 2), position: new THREE.Vector3(-arenaRadius - 0.6, 1, 0) },
  ];

  for (const wall of walls) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(wall.size.x, wall.size.y, wall.size.z), wallMaterial);
    mesh.position.copy(wall.position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    addObstacle(mesh);
  }
}

function createTank(assets: Assets, team: Team, position: THREE.Vector3) {
  const group = new THREE.Group();
  group.position.copy(position);

  const visual = assets.tank.clone(true);
  const hull = visual.getObjectByName("Object001");
  const turret = visual.getObjectByName("Object002");

  if (!hull || !turret) {
    throw new Error("Tank asset is missing expected hull/turret nodes.");
  }

  group.add(visual);

  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.1, 0.08, 28),
    new THREE.MeshStandardMaterial({
      color: team === "player" ? "#58f4b4" : "#ff7a6d",
      emissive: team === "player" ? "#1e6b4e" : "#6f241c",
      roughness: 0.4,
      metalness: 0.05,
    }),
  );
  ring.position.y = 0.04;
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
    bodyHeading: 0,
    turretHeading: 0,
    speed: team === "player" ? 7 : 4.2,
    fireCooldown: team === "player" ? 0 : 0.8,
    health: 100,
    alive: true,
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
  if (Math.abs(position.x) > arenaRadius - radius || Math.abs(position.z) > arenaRadius - radius) {
    return true;
  }

  return obstacles.some((obstacle) => circleIntersectsBox(position, radius, obstacle.bounds));
}

function tryMoveTank(tank: TankActor, movement: THREE.Vector3) {
  const candidateX = tank.group.position.clone();
  candidateX.x += movement.x;
  if (!collidesWithArena(candidateX, tank.radius)) {
    tank.group.position.x = candidateX.x;
  }

  const candidateZ = tank.group.position.clone();
  candidateZ.z += movement.z;
  if (!collidesWithArena(candidateZ, tank.radius)) {
    tank.group.position.z = candidateZ.z;
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
  const spawn = tank.group.position.clone().add(direction.clone().multiplyScalar(1.45));
  spawn.y = 0.78;

  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 10, 10),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.48,
    }),
  );
  shell.position.copy(spawn);
  shell.castShadow = true;
  scene.add(shell);

  projectiles.push({
    mesh: shell,
    velocity: direction.multiplyScalar(17),
    ttl: 2,
    owner: tank.team,
    damage: 25,
  });

  tank.fireCooldown = tank.team === "player" ? 0.22 : 1.15;
  audio.onShot();
}

function acquirePointerWorld() {
  raycaster.setFromCamera(pointerNdc, camera);
  raycaster.ray.intersectPlane(aimPlane, pointerWorld);
}

function updatePlayer(delta: number) {
  const input = new THREE.Vector3(
    Number(pressed.has("KeyD")) - Number(pressed.has("KeyA")),
    0,
    Number(pressed.has("KeyS")) - Number(pressed.has("KeyW")),
  );

  if (input.lengthSq() > 0) {
    input.normalize();
    tryMoveTank(playerTank, input.multiplyScalar(playerTank.speed * delta));
    playerTank.bodyHeading = angleLerp(
      playerTank.bodyHeading,
      Math.atan2(input.x, input.z),
      1 - Math.exp(-delta * 12),
    );
  }

  playerTank.turretHeading = Math.atan2(
    pointerWorld.x - playerTank.group.position.x,
    pointerWorld.z - playerTank.group.position.z,
  );

  playerTank.fireCooldown = Math.max(0, playerTank.fireCooldown - delta);
  if ((fireQueued || pressed.has("Space")) && playerTank.fireCooldown <= 0) {
    fireProjectile(playerTank, "#6be9ff");
  }

  updateTankVisual(playerTank);
}

function lineOfSightBlocked(start: THREE.Vector3, end: THREE.Vector3) {
  const direction = end.clone().sub(start);
  const distance = direction.length();
  direction.normalize();

  const ray = new THREE.Ray(start, direction);
  const hitPoint = new THREE.Vector3();

  return obstacles.some((obstacle) => {
    const hit = ray.intersectBox(obstacle.bounds, hitPoint);
    return hit !== null && hit.distanceTo(start) < distance;
  });
}

function updateEnemy(enemy: TankActor, delta: number) {
  if (!enemy.alive) {
    return;
  }

  const toPlayer = playerTank.group.position.clone().sub(enemy.group.position);
  const distance = toPlayer.length();
  const desired = new THREE.Vector3();

  if (distance > 9) {
    desired.copy(toPlayer.normalize());
  } else if (distance < 5.5) {
    desired.copy(toPlayer.normalize().multiplyScalar(-1));
  } else {
    desired.set(toPlayer.z, 0, -toPlayer.x).normalize();
  }

  for (const obstacle of obstacles) {
    const center = obstacle.bounds.getCenter(new THREE.Vector3());
    const away = enemy.group.position.clone().sub(center);
    const planarDistance = Math.hypot(away.x, away.z);
    if (planarDistance < 4.2) {
      desired.add(away.normalize().multiplyScalar((4.2 - planarDistance) * 0.7));
    }
  }

  if (desired.lengthSq() > 0.001) {
    desired.normalize();
    tryMoveTank(enemy, desired.multiplyScalar(enemy.speed * delta));
    enemy.bodyHeading = angleLerp(
      enemy.bodyHeading,
      Math.atan2(desired.x, desired.z),
      1 - Math.exp(-delta * 6),
    );
  }

  enemy.turretHeading = angleLerp(
    enemy.turretHeading,
    Math.atan2(toPlayer.x, toPlayer.z),
    1 - Math.exp(-delta * 9),
  );

  enemy.fireCooldown = Math.max(0, enemy.fireCooldown - delta);
  if (
    enemy.fireCooldown <= 0 &&
    distance < 18 &&
    !lineOfSightBlocked(enemy.group.position, playerTank.group.position)
  ) {
    fireProjectile(enemy, "#ff9f7b");
  }

  updateTankVisual(enemy);
}

function damageTank(target: TankActor, amount: number) {
  target.health -= amount;

  if (target.team === "player") {
    target.ring.material = new THREE.MeshStandardMaterial({
      color: "#ffd76b",
      emissive: "#704f16",
      roughness: 0.45,
      metalness: 0.05,
    });
  }

  if (target.health <= 0 && target.alive) {
    target.alive = false;
    target.group.visible = false;
    if (target.team === "enemy") {
      score += 100;
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
  const tempPoint = new THREE.Vector3();

  for (let i = projectiles.length - 1; i >= 0; i -= 1) {
    const projectile = projectiles[i];
    projectile.mesh.position.addScaledVector(projectile.velocity, delta);
    projectile.ttl -= delta;

    if (
      Math.abs(projectile.mesh.position.x) > arenaRadius + 1 ||
      Math.abs(projectile.mesh.position.z) > arenaRadius + 1 ||
      projectile.ttl <= 0
    ) {
      removeProjectileAt(i);
      continue;
    }

    if (obstacles.some((obstacle) => obstacle.bounds.containsPoint(projectile.mesh.position))) {
      removeProjectileAt(i);
      continue;
    }

    const targets = projectile.owner === "player" ? enemyTanks : [playerTank];
    let consumed = false;

    for (const target of targets) {
      if (!target.alive) {
        continue;
      }

      tempPoint.copy(target.group.position);
      tempPoint.y = projectile.mesh.position.y;
      if (tempPoint.distanceTo(projectile.mesh.position) < target.radius + 0.22) {
        damageTank(target, projectile.damage);
        audio.onHit();
        removeProjectileAt(i);
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
  pickupAnchor.position.set(
    THREE.MathUtils.randFloatSpread(18),
    0.25,
    THREE.MathUtils.randFloatSpread(18),
  );

  if (collidesWithArena(pickupAnchor.position, 1.2)) {
    pickupAnchor.position.set(0, 0.25, 0);
  }

  pickupActive = true;
  pickupAnchor.visible = true;
}

function updatePickup(delta: number) {
  pickupAnchor.rotation.y += delta * 1.6;
  pickupAnchor.position.y = 0.35 + Math.sin(clock.getElapsedTime() * 2.2) * 0.12;

  if (!pickupActive) {
    pickupCooldown -= delta;
    if (pickupCooldown <= 0) {
      placePickup();
    }
    return;
  }

  if (playerTank.group.position.distanceTo(pickupAnchor.position) < 1.6) {
    pickupActive = false;
    pickupAnchor.visible = false;
    pickupCooldown = 8;
    playerTank.health = Math.min(100, playerTank.health + 30);
    score += 25;
    audio.onPickup();
    setStatus("Glyph captured. Armor restored.");
  }
}

function updateCamera(delta: number) {
  const desired = new THREE.Vector3(
    playerTank.group.position.x,
    28,
    playerTank.group.position.z + 0.01,
  );
  camera.position.lerp(desired, 1 - Math.exp(-delta * 5));
  camera.lookAt(playerTank.group.position.x, 0, playerTank.group.position.z);

  reticle.position.set(pointerWorld.x, 0.06, pointerWorld.z);
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

  setStatus(`Top-down combat active. Keep moving and use cover.`);
}

function resize() {
  const width = viewportNode.clientWidth;
  const height = viewportNode.clientHeight;
  const aspect = width / Math.max(height, 1);
  const frustumHalfHeight = 12;

  camera.left = -frustumHalfHeight * aspect;
  camera.right = frustumHalfHeight * aspect;
  camera.top = frustumHalfHeight;
  camera.bottom = -frustumHalfHeight;
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

  createArenaProps(assets);

  const pickupVisual = assets.glyph.clone(true);
  pickupAnchor.add(pickupVisual);
  placePickup();

  playerTank = createTank(assets, "player", new THREE.Vector3(0, 0, 10));
  enemyTanks.push(
    createTank(assets, "enemy", new THREE.Vector3(-9, 0, -8)),
    createTank(assets, "enemy", new THREE.Vector3(8.5, 0, -9.5)),
    createTank(assets, "enemy", new THREE.Vector3(0, 0, -12.5)),
  );

  playerTank.bodyHeading = Math.PI;
  playerTank.turretHeading = Math.PI;
  updateTankVisual(playerTank);

  for (const enemy of enemyTanks) {
    enemy.bodyHeading = 0;
    enemy.turretHeading = 0;
    updateTankVisual(enemy);
  }

  updateHud();
  resize();
  setStatus("Top-down arena ready.");
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
  setStatus("Failed to initialize arena assets.");
});
