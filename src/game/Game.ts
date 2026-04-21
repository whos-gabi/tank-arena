import * as THREE from "three";
import {
  CAMERA_HALF_HEIGHT,
  CAMERA_HEIGHT,
  ENEMY_MAX_SPEED,
  MAP_HALF,
  PICKUP_RESPAWN_TIME,
  PLAYER_MAX_SPEED,
  SHELL_SPEED,
} from "./config";
import { Assets, loadAssets } from "./assets";
import { buildArenaScene, generateLayout, Obstacle } from "./arena";
import { cellFromWorld, GridCell, keyOf, worldFromCell } from "./grid";
import { HUD } from "./hud";
import { angleLerp, approachVector, circleIntersectsBox, forwardFromHeading } from "./math";
import { findPath } from "./pathfinding";

type Team = "player" | "enemy";

type Projectile = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  ttl: number;
  owner: Team;
  damage: number;
};

type TankActor = {
  team: Team;
  root: THREE.Group;
  visual: THREE.Group;
  hull: THREE.Object3D;
  turret: THREE.Object3D;
  hullBaseQuaternion: THREE.Quaternion;
  turretBaseQuaternion: THREE.Quaternion;
  bodyHeading: number;
  turretHeading: number;
  velocity: THREE.Vector3;
  maxSpeed: number;
  fireCooldown: number;
  health: number;
  alive: boolean;
  radius: number;
  path: GridCell[];
  repathTimer: number;
  lastTargetCell: string;
  strafeDirection: number;
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
    this.ping(68, 0.18, "sawtooth", 0.05);
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

export class Game {
  private readonly viewport: HTMLDivElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(
    -CAMERA_HALF_HEIGHT,
    CAMERA_HALF_HEIGHT,
    CAMERA_HALF_HEIGHT,
    -CAMERA_HALF_HEIGHT,
    0.1,
    200,
  );
  private readonly raycaster = new THREE.Raycaster();
  private readonly aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly pointerNdc = new THREE.Vector2(0, 0);
  private readonly pointerWorld = new THREE.Vector3(0, 0, 0);
  private readonly cameraFocus = new THREE.Vector3(0, 0, 0);
  private readonly clock = new THREE.Clock();
  private readonly pressed = new Set<string>();
  private readonly projectiles: Projectile[] = [];
  private readonly obstacles: Obstacle[] = [];
  private readonly enemyTanks: TankActor[] = [];
  private readonly pickupAnchor = new THREE.Group();
  private readonly reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.38, 0.54, 28),
    new THREE.MeshBasicMaterial({ color: "#6de8ff", transparent: true, opacity: 0.92 }),
  );
  private readonly worldRoot = new THREE.Group();
  private readonly hud = new HUD(() => {
    void this.restartMatch();
  });
  private readonly audio = new AudioBridge();

  private assets: Assets | null = null;
  private blockedGrid: boolean[][] = [];
  private walkableCells: GridCell[] = [];
  private playerTank!: TankActor;
  private score = 0;
  private pickupCooldown = 0;
  private pickupActive = false;
  private fireQueued = false;
  private matchRunning = false;

  constructor(viewport: HTMLDivElement) {
    this.viewport = viewport;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.viewport.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color("#071118");
    this.scene.fog = new THREE.Fog("#071118", 50, 110);

    this.camera.up.set(0, 0, -1);
    this.reticle.rotation.x = -Math.PI / 2;
    this.reticle.position.y = 0.08;

    this.scene.add(this.worldRoot);
    this.scene.add(this.reticle);
    this.scene.add(this.pickupAnchor);

    this.createLights();
    this.bindEvents();
  }

  async boot() {
    this.hud.startIntro();
    this.hud.setStatus("Loading assets...");
    this.assets = await loadAssets((message) => this.hud.setStatus(message));
    await this.restartMatch();
    this.animate();
  }

  private bindEvents() {
    this.renderer.domElement.addEventListener("pointermove", (event) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      this.hud.skipIntro();
    });

    this.renderer.domElement.addEventListener("pointerdown", () => {
      this.fireQueued = true;
      this.audio.resume();
      this.hud.skipIntro();
    });

    window.addEventListener("keydown", (event) => {
      this.pressed.add(event.code);
      this.hud.skipIntro();
      if (event.code === "Space") {
        this.fireQueued = true;
        event.preventDefault();
      }
    });

    window.addEventListener("keyup", (event) => {
      this.pressed.delete(event.code);
    });

    window.addEventListener("resize", () => {
      this.resize();
    });
  }

  private createLights() {
    this.scene.add(new THREE.AmbientLight("#a9d8ff", 1.5));

    const sun = new THREE.DirectionalLight("#fff3d9", 2.35);
    sun.position.set(24, 44, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -60;
    sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight("#47c8ff", 0.75);
    fill.position.set(-16, 18, -20);
    this.scene.add(fill);
  }

  private clearWorldRoot() {
    for (let i = this.worldRoot.children.length - 1; i >= 0; i -= 1) {
      const child = this.worldRoot.children[i];
      this.worldRoot.remove(child);
    }

    this.projectiles.length = 0;
    this.obstacles.length = 0;
    this.enemyTanks.length = 0;
    this.pickupAnchor.clear();
    this.pickupAnchor.visible = false;
  }

  private createTank(team: Team, spawn: GridCell) {
    if (!this.assets) {
      throw new Error("Assets not loaded.");
    }

    const root = new THREE.Group();
    root.position.copy(worldFromCell(spawn));

    const visual = this.assets.tank.clone(true);
    const hull = visual.getObjectByName("Object001");
    const turret = visual.getObjectByName("Object002");

    if (!hull || !turret) {
      throw new Error("Tank asset is missing expected hull/turret nodes.");
    }

    root.add(visual);
    this.worldRoot.add(root);

    return {
      team,
      root,
      visual,
      hull,
      turret,
      hullBaseQuaternion: hull.quaternion.clone(),
      turretBaseQuaternion: turret.quaternion.clone(),
      bodyHeading: Math.PI,
      turretHeading: Math.PI,
      velocity: new THREE.Vector3(),
      maxSpeed: team === "player" ? PLAYER_MAX_SPEED : ENEMY_MAX_SPEED,
      fireCooldown: team === "player" ? 0 : 1,
      health: 100,
      alive: true,
      radius: 1.05,
      path: [],
      repathTimer: 0,
      lastTargetCell: "",
      strafeDirection: Math.random() > 0.5 ? 1 : -1,
    } satisfies TankActor;
  }

  private updateTankVisual(tank: TankActor) {
    const hullRotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      tank.bodyHeading,
    );
    const turretRotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      tank.turretHeading,
    );

    tank.hull.quaternion.copy(tank.hullBaseQuaternion).multiply(hullRotation);
    tank.turret.quaternion.copy(tank.turretBaseQuaternion).multiply(turretRotation);
  }

  private collidesWithArena(position: THREE.Vector3, radius: number) {
    if (Math.abs(position.x) > MAP_HALF - radius || Math.abs(position.z) > MAP_HALF - radius) {
      return true;
    }
    return this.obstacles.some((obstacle) =>
      circleIntersectsBox(position, radius, obstacle.bounds),
    );
  }

  private tryMoveTank(tank: TankActor, movement: THREE.Vector3) {
    const candidateX = tank.root.position.clone();
    candidateX.x += movement.x;
    if (!this.collidesWithArena(candidateX, tank.radius)) {
      tank.root.position.x = candidateX.x;
    } else {
      tank.velocity.x *= 0.2;
    }

    const candidateZ = tank.root.position.clone();
    candidateZ.z += movement.z;
    if (!this.collidesWithArena(candidateZ, tank.radius)) {
      tank.root.position.z = candidateZ.z;
    } else {
      tank.velocity.z *= 0.2;
    }
  }

  private lineOfSightBlocked(start: THREE.Vector3, end: THREE.Vector3) {
    const direction = end.clone().sub(start);
    const distanceToTarget = direction.length();
    direction.normalize();

    const ray = new THREE.Ray(start, direction);
    const hitPoint = new THREE.Vector3();

    return this.obstacles.some((obstacle) => {
      const hit = ray.intersectBox(obstacle.bounds, hitPoint);
      return hit !== null && hit.distanceTo(start) < distanceToTarget;
    });
  }

  private sampleWalkableCell() {
    return this.walkableCells[Math.floor(Math.random() * this.walkableCells.length)];
  }

  private placePickup() {
    let candidate = this.sampleWalkableCell();

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const next = this.sampleWalkableCell();
      if (
        Math.abs(next.col - cellFromWorld(this.playerTank.root.position).col) +
          Math.abs(next.row - cellFromWorld(this.playerTank.root.position).row) >
        7
      ) {
        candidate = next;
        break;
      }
    }

    this.pickupAnchor.position.copy(worldFromCell(candidate));
    this.pickupAnchor.position.y = 0.5;
    this.pickupAnchor.visible = true;
    this.pickupActive = true;
  }

  private fireProjectile(tank: TankActor, color: string) {
    const direction = forwardFromHeading(tank.turretHeading).normalize();
    const spawn = tank.root.position.clone().add(direction.clone().multiplyScalar(1.55));
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
    this.worldRoot.add(shell);

    this.projectiles.push({
      mesh: shell,
      velocity: direction.multiplyScalar(SHELL_SPEED),
      ttl: 2.3,
      owner: tank.team,
      damage: 22,
    });

    tank.fireCooldown = tank.team === "player" ? 0.18 : 0.95;
    this.audio.onShot();
  }

  private removeProjectileAt(index: number) {
    const projectile = this.projectiles[index];
    this.worldRoot.remove(projectile.mesh);
    projectile.mesh.geometry.dispose();
    (projectile.mesh.material as THREE.Material).dispose();
    this.projectiles.splice(index, 1);
  }

  private damageTank(target: TankActor, amount: number) {
    target.health -= amount;

    if (target.health <= 0 && target.alive) {
      target.alive = false;
      target.root.visible = false;

      if (target.team === "enemy") {
        this.score += 120;
        this.hud.setStatus("Enemy tank destroyed.");
      } else {
        this.matchRunning = false;
        this.hud.showLoseScreen(this.score);
      }
    }
  }

  private acquirePointerWorld() {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    this.raycaster.ray.intersectPlane(this.aimPlane, this.pointerWorld);
  }

  private updatePlayer(delta: number) {
    const input = new THREE.Vector3(
      Number(this.pressed.has("KeyD")) - Number(this.pressed.has("KeyA")),
      0,
      Number(this.pressed.has("KeyS")) - Number(this.pressed.has("KeyW")),
    );

    const desiredVelocity = new THREE.Vector3();
    if (input.lengthSq() > 0) {
      input.normalize();
      desiredVelocity.copy(input).multiplyScalar(this.playerTank.maxSpeed);
    }

    approachVector(
      this.playerTank.velocity,
      desiredVelocity,
      delta,
      input.lengthSq() > 0 ? 10 : 6,
    );
    this.tryMoveTank(this.playerTank, this.playerTank.velocity.clone().multiplyScalar(delta));

    if (this.playerTank.velocity.lengthSq() > 0.2) {
      this.playerTank.bodyHeading = angleLerp(
        this.playerTank.bodyHeading,
        Math.atan2(this.playerTank.velocity.x, this.playerTank.velocity.z),
        1 - Math.exp(-delta * 10),
      );
    }

    this.playerTank.turretHeading = Math.atan2(
      this.pointerWorld.x - this.playerTank.root.position.x,
      this.pointerWorld.z - this.playerTank.root.position.z,
    );

    this.playerTank.fireCooldown = Math.max(0, this.playerTank.fireCooldown - delta);
    if ((this.fireQueued || this.pressed.has("Space")) && this.playerTank.fireCooldown <= 0) {
      this.fireProjectile(this.playerTank, "#76f2ff");
    }

    this.updateTankVisual(this.playerTank);
  }

  private pathDirection(enemy: TankActor) {
    if (enemy.path.length <= 1) {
      return new THREE.Vector3();
    }

    const currentCell = cellFromWorld(enemy.root.position);
    const first = enemy.path[0];

    if (first.col === currentCell.col && first.row === currentCell.row) {
      enemy.path.shift();
    }

    const nextCell = enemy.path[Math.min(1, enemy.path.length - 1)];
    const targetWorld = worldFromCell(nextCell);
    const direction = targetWorld.sub(enemy.root.position);

    if (direction.length() < 0.75 && enemy.path.length > 1) {
      enemy.path.shift();
    }

    direction.y = 0;
    return direction.normalize();
  }

  private avoidNeighbors(enemy: TankActor) {
    const repulsion = new THREE.Vector3();
    for (const other of this.enemyTanks) {
      if (other === enemy || !other.alive) {
        continue;
      }
      const away = enemy.root.position.clone().sub(other.root.position);
      const distanceToOther = away.length();
      if (distanceToOther > 0 && distanceToOther < 4.2) {
        repulsion.add(away.normalize().multiplyScalar((4.2 - distanceToOther) * 0.9));
      }
    }
    return repulsion;
  }

  private updateEnemy(enemy: TankActor, delta: number) {
    if (!enemy.alive) {
      return;
    }

    const toPlayer = this.playerTank.root.position.clone().sub(enemy.root.position);
    const playerCell = cellFromWorld(this.playerTank.root.position);
    const enemyCell = cellFromWorld(enemy.root.position);
    const playerKey = keyOf(playerCell);

    enemy.repathTimer -= delta;
    if (
      enemy.repathTimer <= 0 ||
      enemy.lastTargetCell !== playerKey ||
      enemy.path.length === 0
    ) {
      enemy.path = findPath(enemyCell, playerCell, this.blockedGrid);
      enemy.repathTimer = 0.65 + Math.random() * 0.35;
      enemy.lastTargetCell = playerKey;
    }

    const hasLineOfSight = !this.lineOfSightBlocked(enemy.root.position, this.playerTank.root.position);
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
      desiredVelocity.add(this.pathDirection(enemy).multiplyScalar(enemy.maxSpeed));
    }

    desiredVelocity.add(this.avoidNeighbors(enemy));

    if (desiredVelocity.lengthSq() > enemy.maxSpeed * enemy.maxSpeed) {
      desiredVelocity.normalize().multiplyScalar(enemy.maxSpeed);
    }

    approachVector(enemy.velocity, desiredVelocity, delta, 5.5);
    this.tryMoveTank(enemy, enemy.velocity.clone().multiplyScalar(delta));

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
    const targetAngle = Math.atan2(toPlayer.x, toPlayer.z);
    const aimError = Math.abs(
      Math.atan2(
        Math.sin(enemy.turretHeading - targetAngle),
        Math.cos(enemy.turretHeading - targetAngle),
      ),
    );

    if (hasLineOfSight && distanceToPlayer < 26 && enemy.fireCooldown <= 0 && aimError < 0.14) {
      this.fireProjectile(enemy, "#ff9e73");
    }

    this.updateTankVisual(enemy);
  }

  private updateProjectiles(delta: number) {
    const targetPoint = new THREE.Vector3();

    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.mesh.position.addScaledVector(projectile.velocity, delta);
      projectile.ttl -= delta;

      if (
        Math.abs(projectile.mesh.position.x) > MAP_HALF + 2 ||
        Math.abs(projectile.mesh.position.z) > MAP_HALF + 2 ||
        projectile.ttl <= 0
      ) {
        this.removeProjectileAt(index);
        continue;
      }

      if (this.obstacles.some((obstacle) => obstacle.bounds.containsPoint(projectile.mesh.position))) {
        this.removeProjectileAt(index);
        continue;
      }

      const targets = projectile.owner === "player" ? this.enemyTanks : [this.playerTank];
      let consumed = false;

      for (const target of targets) {
        if (!target.alive) {
          continue;
        }

        targetPoint.copy(target.root.position);
        targetPoint.y = projectile.mesh.position.y;
        if (targetPoint.distanceTo(projectile.mesh.position) < target.radius + 0.25) {
          this.damageTank(target, projectile.damage);
          this.audio.onHit();
          this.removeProjectileAt(index);
          consumed = true;
          break;
        }
      }

      if (consumed) {
        continue;
      }
    }
  }

  private updatePickup(delta: number) {
    this.pickupAnchor.rotation.y += delta * 1.5;
    this.pickupAnchor.position.y = 0.55 + Math.sin(this.clock.getElapsedTime() * 2) * 0.16;

    if (!this.pickupActive) {
      this.pickupCooldown -= delta;
      if (this.pickupCooldown <= 0 && this.playerTank.alive) {
        this.placePickup();
      }
      return;
    }

    if (this.playerTank.root.position.distanceTo(this.pickupAnchor.position) < 1.8) {
      this.pickupActive = false;
      this.pickupAnchor.visible = false;
      this.pickupCooldown = PICKUP_RESPAWN_TIME;
      this.playerTank.health = Math.min(100, this.playerTank.health + 32);
      this.score += 35;
      this.audio.onPickup();
      this.hud.setStatus("Glyph captured. Armor restored.");
    }
  }

  private updateCamera(delta: number) {
    const desiredFocus = this.playerTank.root.position.clone();
    desiredFocus.y = 0;
    approachVector(this.cameraFocus, desiredFocus, delta, 7);

    this.camera.position.set(this.cameraFocus.x, CAMERA_HEIGHT, this.cameraFocus.z);
    this.camera.lookAt(this.cameraFocus.x, 0, this.cameraFocus.z);
    this.reticle.position.set(this.pointerWorld.x, 0.08, this.pointerWorld.z);
  }

  private updateHud() {
    const enemiesAlive = this.enemyTanks.filter((enemy) => enemy.alive).length;
    this.hud.setHealth(this.playerTank.health);
    this.hud.setScore(this.score);
    this.hud.setEnemies(enemiesAlive);
    this.hud.setObjective(
      this.pickupActive
        ? "Capture the glyph for emergency repair"
        : "Sweep the arena and hold position",
    );
  }

  private updateStatusLine() {
    if (!this.playerTank.alive) {
      this.hud.setStatus("You lost.");
      return;
    }

    const enemiesAlive = this.enemyTanks.filter((enemy) => enemy.alive).length;
    if (enemiesAlive === 0) {
      this.hud.setStatus("Arena cleared.");
      this.matchRunning = false;
      return;
    }

    this.hud.setStatus("Stay mobile. Use the cover lanes.");
  }

  private resize() {
    const width = this.viewport.clientWidth;
    const height = this.viewport.clientHeight;
    const aspect = width / Math.max(height, 1);

    this.camera.left = -CAMERA_HALF_HEIGHT * aspect;
    this.camera.right = CAMERA_HALF_HEIGHT * aspect;
    this.camera.top = CAMERA_HALF_HEIGHT;
    this.camera.bottom = -CAMERA_HALF_HEIGHT;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
  }

  private animate = () => {
    const delta = Math.min(this.clock.getDelta(), 0.05);

    if (this.matchRunning && this.playerTank.alive) {
      this.acquirePointerWorld();
      this.updatePlayer(delta);
      for (const enemy of this.enemyTanks) {
        this.updateEnemy(enemy, delta);
      }
      this.updateProjectiles(delta);
      this.updatePickup(delta);
    }

    if (this.assets) {
      this.updateCamera(delta);
      this.updateStatusLine();
      this.updateHud();
    }

    this.fireQueued = false;
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.animate);
  };

  private async restartMatch() {
    if (!this.assets) {
      return;
    }

    this.hud.hideLoseScreen();
    this.hud.startIntro();
    this.clearWorldRoot();

    const layout = generateLayout();
    this.blockedGrid = layout.blocked;
    this.walkableCells = layout.walkable;
    this.obstacles.push(...buildArenaScene(this.worldRoot, this.scene, this.assets, layout));

    const pickupVisual = this.assets.glyph.clone(true);
    this.pickupAnchor.add(pickupVisual);

    this.playerTank = this.createTank("player", layout.playerSpawn);
    this.updateTankVisual(this.playerTank);

    for (const spawn of layout.enemySpawns) {
      const enemy = this.createTank("enemy", spawn);
      enemy.bodyHeading = 0;
      enemy.turretHeading = 0;
      this.updateTankVisual(enemy);
      this.enemyTanks.push(enemy);
    }

    this.score = 0;
    this.pickupCooldown = 0;
    this.pickupActive = false;
    this.placePickup();
    this.matchRunning = true;
    this.resize();
    this.hud.setStatus("Arena ready.");
  }
}
