import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Assets } from "./assets";

interface ExplosionEffect {
  mixer: THREE.AnimationMixer;
  group: THREE.Group;
  timer: number;
  duration: number;
}

interface BurningWreck {
  visual: THREE.Group;
  fire: THREE.Points;
  smoke: THREE.Points;
  light: THREE.PointLight;
  timer: number;
  position: THREE.Vector3;
}

export class DestructionEffects {
  private worldRoot: THREE.Group;
  private assets: Assets;
  private explosions: ExplosionEffect[] = [];
  private burningWrecks: BurningWreck[] = [];

  constructor(worldRoot: THREE.Group, assets: Assets) {
    this.worldRoot = worldRoot;
    this.assets = assets;
  }

  createExplosion(position: THREE.Vector3) {
    const explosionGroup = SkeletonUtils.clone(this.assets.explosion) as THREE.Group;
    explosionGroup.position.copy(position);
    explosionGroup.position.y = 0.5;

    const mixer = new THREE.AnimationMixer(explosionGroup);

    if (this.assets.explosionAnimations.length > 0) {
      const action = mixer.clipAction(this.assets.explosionAnimations[0]);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
    }

    this.worldRoot.add(explosionGroup);

    const duration = this.assets.explosionAnimations[0]?.duration || 1.5;

    this.explosions.push({
      mixer,
      group: explosionGroup,
      timer: 0,
      duration,
    });
  }

  createBurningWreck(visual: THREE.Group, position: THREE.Vector3) {
    // Clone and blacken the visual
    const wreckVisual = visual.clone(true);
    wreckVisual.position.copy(position);

    // Turn all materials black/charred
    wreckVisual.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        if (Array.isArray(node.material)) {
          node.material = node.material.map(mat => {
            const charredMat = mat.clone();
            if (charredMat instanceof THREE.MeshStandardMaterial) {
              charredMat.color.setHex(0x1a1a1a);
              charredMat.roughness = 0.9;
              charredMat.metalness = 0.1;
              charredMat.emissive.setHex(0x000000);
            }
            return charredMat;
          });
        } else {
          const charredMat = node.material.clone();
          if (charredMat instanceof THREE.MeshStandardMaterial) {
            charredMat.color.setHex(0x1a1a1a);
            charredMat.roughness = 0.9;
            charredMat.metalness = 0.1;
            charredMat.emissive.setHex(0x000000);
          }
          node.material = charredMat;
        }
      }
    });

    this.worldRoot.add(wreckVisual);

    // Create fire particles
    const fireParticleCount = 80;
    const fireGeometry = new THREE.BufferGeometry();
    const firePositions = new Float32Array(fireParticleCount * 3);
    const fireColors = new Float32Array(fireParticleCount * 3);
    const fireSizes = new Float32Array(fireParticleCount);

    for (let i = 0; i < fireParticleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 0.8;
      firePositions[i * 3] = position.x + Math.cos(angle) * radius;
      firePositions[i * 3 + 1] = position.y + Math.random() * 0.5;
      firePositions[i * 3 + 2] = position.z + Math.sin(angle) * radius;

      const colorChoice = Math.random();
      if (colorChoice < 0.4) {
        fireColors[i * 3] = 1.0;
        fireColors[i * 3 + 1] = 0.3;
        fireColors[i * 3 + 2] = 0.0;
      } else if (colorChoice < 0.7) {
        fireColors[i * 3] = 1.0;
        fireColors[i * 3 + 1] = 0.6;
        fireColors[i * 3 + 2] = 0.0;
      } else {
        fireColors[i * 3] = 1.0;
        fireColors[i * 3 + 1] = 1.0;
        fireColors[i * 3 + 2] = 0.2;
      }

      fireSizes[i] = 0.3 + Math.random() * 0.4;
    }

    fireGeometry.setAttribute('position', new THREE.BufferAttribute(firePositions, 3));
    fireGeometry.setAttribute('color', new THREE.BufferAttribute(fireColors, 3));
    fireGeometry.setAttribute('size', new THREE.BufferAttribute(fireSizes, 1));

    const fireMaterial = new THREE.PointsMaterial({
      size: 0.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const firePoints = new THREE.Points(fireGeometry, fireMaterial);
    this.worldRoot.add(firePoints);

    // Create smoke particles
    const smokeParticleCount = 50;
    const smokeGeometry = new THREE.BufferGeometry();
    const smokePositions = new Float32Array(smokeParticleCount * 3);
    const smokeColors = new Float32Array(smokeParticleCount * 3);
    const smokeSizes = new Float32Array(smokeParticleCount);

    for (let i = 0; i < smokeParticleCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 0.6;
      smokePositions[i * 3] = position.x + Math.cos(angle) * radius;
      smokePositions[i * 3 + 1] = position.y + Math.random() * 1.5;
      smokePositions[i * 3 + 2] = position.z + Math.sin(angle) * radius;

      const gray = 0.2 + Math.random() * 0.2;
      smokeColors[i * 3] = gray;
      smokeColors[i * 3 + 1] = gray;
      smokeColors[i * 3 + 2] = gray;

      smokeSizes[i] = 0.5 + Math.random() * 0.5;
    }

    smokeGeometry.setAttribute('position', new THREE.BufferAttribute(smokePositions, 3));
    smokeGeometry.setAttribute('color', new THREE.BufferAttribute(smokeColors, 3));
    smokeGeometry.setAttribute('size', new THREE.BufferAttribute(smokeSizes, 1));

    const smokeMaterial = new THREE.PointsMaterial({
      size: 0.8,
      vertexColors: true,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });

    const smokePoints = new THREE.Points(smokeGeometry, smokeMaterial);
    this.worldRoot.add(smokePoints);

    // Create flickering light
    const light = new THREE.PointLight(0xff6600, 3, 8);
    light.position.copy(position);
    light.position.y += 1;
    this.worldRoot.add(light);

    this.burningWrecks.push({
      visual: wreckVisual,
      fire: firePoints,
      smoke: smokePoints,
      light,
      timer: 0,
      position: position.clone(),
    });
  }

  update(delta: number) {
    // Update explosions
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const explosion = this.explosions[i];
      explosion.mixer.update(delta);
      explosion.timer += delta;

      if (explosion.timer >= explosion.duration) {
        this.worldRoot.remove(explosion.group);
        explosion.group.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry.dispose();
            if (Array.isArray(node.material)) {
              node.material.forEach(mat => mat.dispose());
            } else {
              node.material.dispose();
            }
          }
        });
        this.explosions.splice(i, 1);
      }
    }

    // Update burning wrecks
    for (const wreck of this.burningWrecks) {
      wreck.timer += delta;

      // Animate fire particles
      const firePositions = wreck.fire.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < firePositions.length / 3; i++) {
        firePositions[i * 3 + 1] += delta * (0.5 + Math.random() * 0.5);

        if (firePositions[i * 3 + 1] > wreck.position.y + 2) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * 0.8;
          firePositions[i * 3] = wreck.position.x + Math.cos(angle) * radius;
          firePositions[i * 3 + 1] = wreck.position.y + Math.random() * 0.5;
          firePositions[i * 3 + 2] = wreck.position.z + Math.sin(angle) * radius;
        }

        firePositions[i * 3] += (Math.random() - 0.5) * delta * 0.3;
        firePositions[i * 3 + 2] += (Math.random() - 0.5) * delta * 0.3;
      }
      wreck.fire.geometry.attributes.position.needsUpdate = true;

      // Animate smoke particles
      const smokePositions = wreck.smoke.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < smokePositions.length / 3; i++) {
        smokePositions[i * 3 + 1] += delta * (0.8 + Math.random() * 0.4);

        if (smokePositions[i * 3 + 1] > wreck.position.y + 4) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * 0.6;
          smokePositions[i * 3] = wreck.position.x + Math.cos(angle) * radius;
          smokePositions[i * 3 + 1] = wreck.position.y + Math.random() * 1.5;
          smokePositions[i * 3 + 2] = wreck.position.z + Math.sin(angle) * radius;
        }

        smokePositions[i * 3] += (Math.random() - 0.5) * delta * 0.5;
        smokePositions[i * 3 + 2] += (Math.random() - 0.5) * delta * 0.5;
      }
      wreck.smoke.geometry.attributes.position.needsUpdate = true;

      // Flicker light
      wreck.light.intensity = 2.5 + Math.random() * 1.5;
      wreck.light.distance = 7 + Math.random() * 2;
    }
  }

  dispose() {
    for (const explosion of this.explosions) {
      this.worldRoot.remove(explosion.group);
    }
    this.explosions = [];

    for (const wreck of this.burningWrecks) {
      this.worldRoot.remove(wreck.visual);
      this.worldRoot.remove(wreck.fire);
      this.worldRoot.remove(wreck.smoke);
      this.worldRoot.remove(wreck.light);

      wreck.fire.geometry.dispose();
      (wreck.fire.material as THREE.Material).dispose();
      wreck.smoke.geometry.dispose();
      (wreck.smoke.material as THREE.Material).dispose();
    }
    this.burningWrecks = [];
  }
}
