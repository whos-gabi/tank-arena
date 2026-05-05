import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  CAMERA_HALF_HEIGHT,
  CAMERA_HEIGHT,
  ENEMY_MAX_SPEED,
  MAP_HALF,
  PLAYER_MAX_SPEED,
  ROBOT_MAX_SPEED,
  SHELL_SPEED,
} from "./config";
import { Assets, loadAssets } from "./assets";
import { buildArenaScene, generateLayout, Obstacle } from "./arena";
import { cellFromWorld, GridCell, keyOf, worldFromCell } from "./grid";
import { HUD } from "./hud";
import { angleLerp, approachVector, circleIntersectsBox, forwardFromHeading } from "./math";
import { findPath } from "./pathfinding";
import { DestructionEffects } from "./DestructionEffects";

type Team = "player" | "enemy" | "robot";

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
  bodyHeading: number;
  aimHeading: number;
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
  mixer?: THREE.AnimationMixer;
};

const projectileMuzzleOffsets: Record<Team, { forward: number; height: number }> = {
  player: { forward: 2.15, height: 1.1 },
  enemy: { forward: 1.55, height: 0.78 },
  robot: { forward: 1.0, height: 1.2 },
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
  private readonly orthoCam = new THREE.OrthographicCamera(
    -CAMERA_HALF_HEIGHT,
    CAMERA_HALF_HEIGHT,
    CAMERA_HALF_HEIGHT,
    -CAMERA_HALF_HEIGHT,
    0.1,
    200,
  );
  private readonly perspCam = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    200,
  );
  private camera!: THREE.Camera;
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
  private readonly pickupAnchors: THREE.Group[] = [];
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
  private destructionEffects!: DestructionEffects;
  private score = 0;
  private fireQueued = false;
  private matchRunning = false;
  private cameraMode: "topdown" | "thirdperson" = "topdown";
  private gameStarted = false;
  private cameraAngle: number | undefined;

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

    this.camera = this.orthoCam;
    this.orthoCam.up.set(0, 0, -1);
    this.reticle.rotation.x = -Math.PI / 2;
    this.reticle.position.y = 0.08;

    this.scene.add(this.worldRoot);
    this.scene.add(this.reticle);
    this.scene.add(this.orthoCam);
    this.scene.add(this.perspCam);

    this.createLights();
    this.bindEvents();
  }

  async boot() {
    this.hud.startIntro();
    this.hud.setStatus("Loading assets...");
    this.assets = await loadAssets((message) => this.hud.setStatus(message));

    this.hud.onStart((mode) => {
      this.cameraMode = mode;
      this.camera = mode === "topdown" ? this.orthoCam : this.perspCam;
      this.gameStarted = true;
      this.hud.skipIntro();
      void this.restartMatch();
    });

    this.animate();
  }

  private bindEvents() {
    this.renderer.domElement.addEventListener("pointermove", (event) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    });

    this.renderer.domElement.addEventListener("pointerdown", () => {
      if (!this.gameStarted) return;
      this.fireQueued = true;
      this.audio.resume();
    });

    window.addEventListener("keydown", (event) => {
      if (!this.gameStarted) return;
      this.pressed.add(event.code);
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
    this.scene.add(new THREE.AmbientLight("#a9d8ff", 1.8));

    const sun = new THREE.DirectionalLight("#fff3d9", 2.5);
    sun.position.set(0, 44, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -60;
    sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    sun.shadow.bias = -0.0001;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight("#47c8ff", 0.6);
    fill.position.set(0, 18, 0);
    this.scene.add(fill);
  }

  private clearWorldRoot() {
    // Clean up destruction effects
    if (this.destructionEffects) {
      this.destructionEffects.dispose();
    }

    for (let i = this.worldRoot.children.length - 1; i >= 0; i -= 1) {
      const child = this.worldRoot.children[i];
      this.worldRoot.remove(child);
    }

    this.projectiles.length = 0;
    this.obstacles.length = 0;
    this.enemyTanks.length = 0;

    for (const anchor of this.pickupAnchors) {
      this.scene.remove(anchor);
    }
    this.pickupAnchors.length = 0;
  }

  private createTank(team: Team, spawn: GridCell) {
    if (!this.assets) {
      throw new Error("Assets not loaded.");
    }

    const root = new THREE.Group();
    root.position.copy(worldFromCell(spawn));

    let visual: THREE.Group;
    let mixer: THREE.AnimationMixer | undefined;
    let maxSpeed: number;
    let fireCooldown: number;
    let health: number;

    if (team === "player") {
      visual = this.assets.playerTank.clone(true);
      maxSpeed = PLAYER_MAX_SPEED;
      fireCooldown = 0;
      health = 224; // 140 * 1.6
    } else if (team === "robot") {
      visual = SkeletonUtils.clone(this.assets.walkingRobot) as THREE.Group;
      mixer = new THREE.AnimationMixer(visual);

      // Play walking animation
      const animations = this.assets.walkingRobot.userData.animations;
      if (animations?.length > 0) {
        const action = mixer.clipAction(animations[0]);
        action.play();
      }

      maxSpeed = ROBOT_MAX_SPEED;
      fireCooldown = 1.5;
      health = 60;
    } else {
      visual = this.assets.enemyTank.clone(true);

      // Ensure enemy tank materials are properly cloned
      visual.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          if (Array.isArray(node.material)) {
            node.material = node.material.map(m => m.clone());
          } else {
            node.material = node.material.clone();
          }
        }
      });

      maxSpeed = ENEMY_MAX_SPEED;
      fireCooldown = 1;
      health = 100;
    }

    root.add(visual);
    this.worldRoot.add(root);

    return {
      team,
      root,
      visual,
      bodyHeading: Math.PI,
      aimHeading: Math.PI,
      velocity: new THREE.Vector3(),
      maxSpeed,
      fireCooldown,
      health,
      alive: true,
      radius: team === "robot" ? 0.8 : 1.05,
      path: [],
      repathTimer: 0,
      lastTargetCell: "",
      strafeDirection: Math.random() > 0.5 ? 1 : -1,
      mixer,
    } satisfies TankActor;
  }

  private updateTankVisual(tank: TankActor) {
    tank.root.rotation.y = tank.bodyHeading;
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

  private placePickups() {
    // Place 3 glyphs randomly on the map
    for (let i = 0; i < 3; i++) {
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

      const pickupAnchor = new THREE.Group();
      const pickupVisual = this.assets!.glyph.clone(true);
      pickupVisual.rotation.x = -Math.PI / 2; // Flip 90 degrees to lay flat
      pickupAnchor.add(pickupVisual);
      pickupAnchor.position.copy(worldFromCell(candidate));
      pickupAnchor.position.y = 0.02;
      pickupAnchor.userData.active = true;
      this.scene.add(pickupAnchor);
      this.pickupAnchors.push(pickupAnchor);
    }
  }

  private fireProjectile(tank: TankActor, color: string) {
    const direction = forwardFromHeading(tank.aimHeading).normalize();
    const muzzleOffset = projectileMuzzleOffsets[tank.team];
    const spawn = tank.root.position.clone().add(direction.clone().multiplyScalar(muzzleOffset.forward));
    spawn.y = muzzleOffset.height;

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
      damage: tank.team === "robot" ? 15 : tank.team === "player" ? 35 : 22,
    });

    tank.fireCooldown = tank.team === "player" ? 0.18 : tank.team === "robot" ? 1.5 : 0.95;
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

      // Create explosion and burning wreck
      const position = new THREE.Vector3();
      target.root.getWorldPosition(position);
      this.destructionEffects.createExplosion(position);
      this.destructionEffects.createBurningWreck(position);

      target.root.visible = false;

      if (target.team === "enemy") {
        this.score += 120;
        this.hud.setStatus("Enemy tank destroyed.");
      } else if (target.team === "robot") {
        this.score += 80;
        this.hud.setStatus("Robot destroyed.");
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
    if (this.cameraMode === "topdown") {
      // Top-down controls: WASD for movement, mouse for aim
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

      this.playerTank.aimHeading = Math.atan2(
        this.pointerWorld.x - this.playerTank.root.position.x,
        this.pointerWorld.z - this.playerTank.root.position.z,
      );
    } else {
      // Third-person controls: W forward, S backward, A/D rotate
      const turnSpeed = 1.2;
      const moveSpeed = this.playerTank.maxSpeed;

      // Rotation
      if (this.pressed.has("KeyA")) {
        this.playerTank.bodyHeading += turnSpeed * delta;
      }
      if (this.pressed.has("KeyD")) {
        this.playerTank.bodyHeading -= turnSpeed * delta;
      }

      // Forward/backward movement
      const forward = forwardFromHeading(this.playerTank.bodyHeading);
      const desiredVelocity = new THREE.Vector3();

      if (this.pressed.has("KeyW")) {
        desiredVelocity.copy(forward).multiplyScalar(moveSpeed);
      } else if (this.pressed.has("KeyS")) {
        desiredVelocity.copy(forward).multiplyScalar(-moveSpeed * 0.7);
      }

      approachVector(
        this.playerTank.velocity,
        desiredVelocity,
        delta,
        desiredVelocity.lengthSq() > 0 ? 10 : 6,
      );
      this.tryMoveTank(this.playerTank, this.playerTank.velocity.clone().multiplyScalar(delta));

      // Aim always forward in third-person
      this.playerTank.aimHeading = this.playerTank.bodyHeading;
    }

    this.playerTank.fireCooldown = Math.max(0, this.playerTank.fireCooldown - delta);
    if ((this.fireQueued || this.pressed.has("Space")) && this.playerTank.fireCooldown <= 0) {
      this.fireProjectile(this.playerTank, "#00ff00");
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

    enemy.aimHeading = Math.atan2(toPlayer.x, toPlayer.z);

    enemy.fireCooldown = Math.max(0, enemy.fireCooldown - delta);
    const targetAngle = Math.atan2(toPlayer.x, toPlayer.z);
    const aimError = Math.abs(
      Math.atan2(
        Math.sin(enemy.aimHeading - targetAngle),
        Math.cos(enemy.aimHeading - targetAngle),
      ),
    );

    if (hasLineOfSight && distanceToPlayer < 26 && enemy.fireCooldown <= 0 && aimError < 0.14) {
      const color = enemy.team === "robot" ? "#ffff00" : "#ff0000";
      this.fireProjectile(enemy, color);
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

      // Check destructible obstacles
      let hitObstacle = false;
      for (let i = this.obstacles.length - 1; i >= 0; i--) {
        const obstacle = this.obstacles[i];
        if (obstacle.bounds.containsPoint(projectile.mesh.position)) {
          if (obstacle.destructible && obstacle.health !== undefined) {
            obstacle.health -= projectile.damage;
            if (obstacle.health <= 0) {
              if (obstacle.visual) {
                this.worldRoot.remove(obstacle.visual);
              }
              this.obstacles.splice(i, 1);
              this.audio.onHit();
            }
          }
          this.destructionEffects.createImpact(projectile.mesh.position, 0xffc46a);
          this.removeProjectileAt(index);
          hitObstacle = true;
          break;
        }
      }

      if (hitObstacle) {
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
          this.destructionEffects.createImpact(projectile.mesh.position, 0xfff0a8);
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

  private updatePickup() {
    for (const anchor of this.pickupAnchors) {
      if (!anchor.userData.active) continue;

      if (this.playerTank.root.position.distanceTo(anchor.position) < 2.5) {
        anchor.userData.active = false;
        anchor.visible = false;
        this.playerTank.health = Math.min(100, this.playerTank.health + 32);
        this.score += 35;
        this.audio.onPickup();
        this.hud.setStatus("Glyph captured. Armor restored.");
      }
    }
  }

  private updateCamera(delta: number) {
    const desiredFocus = this.playerTank.root.position.clone();
    desiredFocus.y = 0;
    approachVector(this.cameraFocus, desiredFocus, delta, 7);

    if (this.cameraMode === "topdown") {
      // Top-down view
      this.orthoCam.position.set(this.cameraFocus.x, CAMERA_HEIGHT, this.cameraFocus.z);
      this.orthoCam.lookAt(this.cameraFocus.x, 0, this.cameraFocus.z);
      this.reticle.visible = true;
      this.reticle.position.set(this.pointerWorld.x, 0.08, this.pointerWorld.z);
    } else {
      // Third-person view - smooth camera rotation following tank
      const distance = 15;
      const height = 8;
      const smoothFactor = 1 - Math.exp(-delta * 0.7); // ~1.5 second smooth follow

      // Calculate desired camera angle based on tank rotation
      const desiredCameraAngle = this.playerTank.bodyHeading;

      // Smoothly interpolate current camera angle toward desired angle
      if (!this.cameraAngle) {
        this.cameraAngle = desiredCameraAngle;
      }

      const angleDelta = Math.atan2(
        Math.sin(desiredCameraAngle - this.cameraAngle),
        Math.cos(desiredCameraAngle - this.cameraAngle)
      );
      this.cameraAngle += angleDelta * smoothFactor;

      const offsetX = -Math.sin(this.cameraAngle) * distance;
      const offsetZ = -Math.cos(this.cameraAngle) * distance;

      this.perspCam.position.set(
        this.cameraFocus.x + offsetX,
        height,
        this.cameraFocus.z + offsetZ
      );
      this.perspCam.lookAt(this.cameraFocus.x, 0, this.cameraFocus.z);
      this.reticle.visible = false;
    }
  }

  private updateHud() {
    const enemiesAlive = this.enemyTanks.filter((enemy) => enemy.alive).length;
    this.hud.setHealth(this.playerTank.health);
    this.hud.setScore(this.score);
    this.hud.setEnemies(enemiesAlive);
    this.hud.setObjective(
      this.pickupAnchors.some(a => a.userData.active)
        ? "Capture glyphs for emergency repair"
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
      this.matchRunning = false;
      this.hud.showWinScreen(this.score);
      return;
    }

    this.hud.setStatus("Stay mobile. Use the cover lanes.");
  }

  private resize() {
    const width = this.viewport.clientWidth;
    const height = this.viewport.clientHeight;
    const aspect = width / Math.max(height, 1);

    this.orthoCam.left = -CAMERA_HALF_HEIGHT * aspect;
    this.orthoCam.right = CAMERA_HALF_HEIGHT * aspect;
    this.orthoCam.top = CAMERA_HALF_HEIGHT;
    this.orthoCam.bottom = -CAMERA_HALF_HEIGHT;
    this.orthoCam.updateProjectionMatrix();

    this.perspCam.aspect = aspect;
    this.perspCam.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
  }

  private animate = () => {
    const delta = Math.min(this.clock.getDelta(), 0.05);

    if (this.matchRunning && this.playerTank && this.playerTank.alive) {
      this.acquirePointerWorld();
      this.updatePlayer(delta);
      for (const enemy of this.enemyTanks) {
        this.updateEnemy(enemy, delta);
        if (enemy.mixer) {
          enemy.mixer.update(delta);
        }
      }
      this.updateProjectiles(delta);
      this.updatePickup();
      this.updateCamera(delta);
    }

    // Update destruction effects
    if (this.destructionEffects) {
      this.destructionEffects.update(delta);
    }

    if (this.assets && this.playerTank) {
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
    this.hud.hideWinScreen();
    this.clearWorldRoot();

    // Initialize destruction effects system
    this.destructionEffects = new DestructionEffects(this.worldRoot, this.assets);

    const layout = generateLayout();
    this.blockedGrid = layout.blocked;
    this.walkableCells = layout.walkable;
    this.obstacles.push(...buildArenaScene(this.worldRoot, this.scene, this.assets, layout));

    this.playerTank = this.createTank("player", layout.playerSpawn);
    this.updateTankVisual(this.playerTank);

    for (const spawn of layout.enemySpawns) {
      const enemy = this.createTank("enemy", spawn);
      enemy.bodyHeading = 0;
      enemy.aimHeading = 0;
      this.updateTankVisual(enemy);
      this.enemyTanks.push(enemy);
    }

    // Spawn 3 robots at random walkable positions far from player
    const spawnedPositions: THREE.Vector3[] = [];
    for (let i = 0; i < 3; i++) {
      let robotSpawn;
      let attempts = 0;

      // Find spawn position far from player and other robots
      do {
        robotSpawn = this.walkableCells[Math.floor(Math.random() * this.walkableCells.length)];
        const spawnPos = worldFromCell(robotSpawn);

        // Check distance from player
        const distFromPlayer = spawnPos.distanceTo(worldFromCell(layout.playerSpawn));

        // Check distance from other robots
        const tooClose = spawnedPositions.some(pos => pos.distanceTo(spawnPos) < 10);

        if (distFromPlayer > 15 && !tooClose) break;
        attempts++;
      } while (attempts < 50);

      const robot = this.createTank("robot", robotSpawn);
      robot.bodyHeading = Math.random() * Math.PI * 2;
      robot.aimHeading = robot.bodyHeading;
      this.updateTankVisual(robot);
      this.enemyTanks.push(robot);
      spawnedPositions.push(worldFromCell(robotSpawn));
    }

    this.score = 0;
    this.placePickups();
    this.matchRunning = true;
    this.resize();
    this.hud.setStatus("Arena ready.");
  }
}
