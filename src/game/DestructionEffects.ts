import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Assets } from "./assets";

type PooledExplosionModel = {
  model: THREE.Group;
  mixer: THREE.AnimationMixer;
  action?: THREE.AnimationAction;
  active: boolean;
};

interface ExplosionEffect {
  core: THREE.Group;
  model?: PooledExplosionModel;
  particles: THREE.Points;
  particleVelocities: Float32Array;
  shockwave: THREE.Mesh;
  light: THREE.PointLight;
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

interface ImpactEffect {
  particles: THREE.Points;
  velocities: Float32Array;
  timer: number;
  duration: number;
}

export class DestructionEffects {
  private worldRoot: THREE.Group;
  private assets: Assets;
  private explosions: ExplosionEffect[] = [];
  private burningWrecks: BurningWreck[] = [];
  private impacts: ImpactEffect[] = [];
  private explosionModelPool: PooledExplosionModel[] = [];
  private readonly explosionLobeGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly wreckChunkGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly wreckHullGeometry = new THREE.BoxGeometry(2.4, 0.42, 1.55);
  private readonly wreckTurretGeometry = new THREE.CylinderGeometry(0.62, 0.72, 0.4, 10);
  private readonly wreckBarrelGeometry = new THREE.CylinderGeometry(0.08, 0.11, 1.65, 8);
  private readonly shockwaveGeometry = new THREE.RingGeometry(0.72, 0.88, 64);
  private readonly hotMaterials = [
    new THREE.MeshBasicMaterial({
      color: 0xfff0a8,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    new THREE.MeshBasicMaterial({
      color: 0xff8a1c,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    new THREE.MeshBasicMaterial({
      color: 0xff3b00,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    new THREE.MeshBasicMaterial({
      color: 0x2c2520,
      transparent: true,
      opacity: 0.72,
      blending: THREE.NormalBlending,
      depthWrite: false,
    }),
  ];
  private readonly charredMaterial = new THREE.MeshStandardMaterial({
    color: 0x151515,
    roughness: 0.95,
    metalness: 0.25,
    emissive: 0x120500,
    emissiveIntensity: 0.35,
  });
  private readonly ashMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b2722,
    roughness: 1,
    metalness: 0.05,
  });

  constructor(worldRoot: THREE.Group, assets: Assets) {
    this.worldRoot = worldRoot;
    this.assets = assets;
    this.buildExplosionModelPool();
  }

  createExplosion(position: THREE.Vector3) {
    const core = this.createExplosionCore(position);
    const model = this.acquireExplosionModel(position);
    const particles = this.createExplosionParticles(position);
    const shockwave = this.createShockwave(position);
    const light = new THREE.PointLight(0xff7a18, 8, 16);
    light.position.copy(position);
    light.position.y += 1.4;
    this.worldRoot.add(core, particles, shockwave, light);

    const duration = 1.25;

    this.explosions.push({
      core,
      model,
      particles,
      particleVelocities: particles.userData.velocities as Float32Array,
      shockwave,
      light,
      timer: 0,
      duration,
    });
  }

  createImpact(position: THREE.Vector3, color = 0xffd27a) {
    const particleCount = 34;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const velocities = new Float32Array(particleCount * 3);
    const baseColor = new THREE.Color(color);

    for (let i = 0; i < particleCount; i += 1) {
      const index = i * 3;
      const angle = Math.random() * Math.PI * 2;
      const lift = 0.15 + Math.random() * 0.65;
      const spread = 0.5 + Math.random() * 1.5;
      const speed = 1.8 + Math.random() * 5.2;

      positions[index] = position.x;
      positions[index + 1] = position.y;
      positions[index + 2] = position.z;

      velocities[index] = Math.cos(angle) * spread * speed;
      velocities[index + 1] = lift * speed;
      velocities[index + 2] = Math.sin(angle) * spread * speed;

      const heat = 0.65 + Math.random() * 0.35;
      colors[index] = baseColor.r * heat;
      colors[index + 1] = baseColor.g * heat;
      colors[index + 2] = baseColor.b * heat;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const particles = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.18,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    this.worldRoot.add(particles);
    this.impacts.push({
      particles,
      velocities,
      timer: 0,
      duration: 0.34,
    });
  }

  private buildExplosionModelPool() {
    for (let i = 0; i < 3; i += 1) {
      const model = SkeletonUtils.clone(this.assets.explosion) as THREE.Group;
      model.visible = false;
      model.scale.setScalar(0.55);
      model.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          if (Array.isArray(node.material)) {
            node.material = node.material.map((mat) => this.prepareExplosionModelMaterial(mat));
          } else {
            node.material = this.prepareExplosionModelMaterial(node.material);
          }
        }
      });

      const mixer = new THREE.AnimationMixer(model);
      const clip = this.assets.explosionAnimations[0];
      const action = clip ? mixer.clipAction(clip) : undefined;
      if (action) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = false;
        action.timeScale = 2.25;
      }

      this.worldRoot.add(model);
      this.explosionModelPool.push({ model, mixer, action, active: false });
    }
  }

  private prepareExplosionModelMaterial(material: THREE.Material) {
    const clone = material.clone();
    clone.transparent = true;
    clone.depthWrite = false;
    clone.blending = THREE.AdditiveBlending;
    clone.opacity = 0;

    if (clone instanceof THREE.MeshStandardMaterial || clone instanceof THREE.MeshPhysicalMaterial) {
      clone.emissive.setHex(0xff6a00);
      clone.emissiveIntensity = 1.7;
    }

    return clone;
  }

  private acquireExplosionModel(position: THREE.Vector3) {
    const pooled = this.explosionModelPool.find((item) => !item.active);
    if (!pooled) {
      return undefined;
    }

    pooled.active = true;
    pooled.model.visible = true;
    pooled.model.position.copy(position);
    pooled.model.position.y = 0.5;
    pooled.model.scale.setScalar(0.55);
    pooled.model.rotation.y = Math.random() * Math.PI * 2;
    pooled.model.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          material.opacity = 0.95;
        }
      }
    });
    pooled.mixer.stopAllAction();
    pooled.action?.reset().play();
    return pooled;
  }

  private releaseExplosionModel(pooled: PooledExplosionModel) {
    pooled.mixer.stopAllAction();
    pooled.model.visible = false;
    pooled.active = false;
  }

  private createExplosionCore(position: THREE.Vector3) {
    const core = new THREE.Group();
    core.position.copy(position);
    core.position.y += 0.75;

    for (let i = 0; i < 5; i += 1) {
      const radius = 0.55 + Math.random() * 0.45;
      const lobe = new THREE.Mesh(
        this.explosionLobeGeometry,
        this.hotMaterials[Math.min(i, this.hotMaterials.length - 1)].clone(),
      );
      lobe.scale.setScalar(radius);
      const angle = (i / 5) * Math.PI * 2 + Math.random() * 0.45;
      const spread = i === 0 ? 0 : 0.3 + Math.random() * 0.35;
      lobe.position.set(Math.cos(angle) * spread, Math.random() * 0.45, Math.sin(angle) * spread);
      lobe.userData.expandSpeed = 1.3 + Math.random() * 1.2;
      lobe.userData.spinSpeed = (Math.random() - 0.5) * 4;
      core.add(lobe);
    }
    return core;
  }

  private createExplosionParticles(position: THREE.Vector3) {
    const particleCount = 170;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const velocities = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i += 1) {
      const index = i * 3;
      const angle = Math.random() * Math.PI * 2;
      const upward = Math.random() * 0.9 + 0.15;
      const horizontal = 0.45 + Math.random() * 0.85;
      const direction = new THREE.Vector3(
        Math.cos(angle) * horizontal,
        upward,
        Math.sin(angle) * horizontal,
      ).normalize();
      const speed = 5 + Math.random() * 12;
      const startRadius = Math.random() * 0.3;

      positions[index] = position.x + direction.x * startRadius;
      positions[index + 1] = position.y + 0.45 + Math.random() * 0.45;
      positions[index + 2] = position.z + direction.z * startRadius;

      velocities[index] = direction.x * speed;
      velocities[index + 1] = direction.y * speed * 0.85 + Math.random() * 2.5;
      velocities[index + 2] = direction.z * speed;

      const heat = Math.random();
      if (heat < 0.45) {
        colors[index] = 1;
        colors[index + 1] = 0.82;
        colors[index + 2] = 0.22;
      } else if (heat < 0.78) {
        colors[index] = 1;
        colors[index + 1] = 0.28;
        colors[index + 2] = 0.02;
      } else {
        colors[index] = 0.18;
        colors[index + 1] = 0.16;
        colors[index + 2] = 0.14;
      }
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.42,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const particles = new THREE.Points(geometry, material);
    particles.userData.velocities = velocities;
    return particles;
  }

  private createShockwave(position: THREE.Vector3) {
    const shockwave = new THREE.Mesh(
      this.shockwaveGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffb15a,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    shockwave.position.copy(position);
    shockwave.position.y = 0.12;
    shockwave.rotation.x = -Math.PI / 2;
    shockwave.scale.setScalar(0.35);
    return shockwave;
  }

  private disposeObject(root: THREE.Object3D, disposeGeometry = true) {
    const disposedMaterials = new Set<THREE.Material>();

    root.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        if (disposeGeometry) {
          node.geometry.dispose();
        }
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (!disposedMaterials.has(material)) {
            material.dispose();
            disposedMaterials.add(material);
          }
        }
      }
    });
  }

  createBurningWreck(position: THREE.Vector3) {
    const wreckVisual = this.createLightweightWreck(position);
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

  private createLightweightWreck(position: THREE.Vector3) {
    const wreck = new THREE.Group();
    wreck.position.copy(position);
    wreck.position.y = 0.18;
    wreck.rotation.y = Math.random() * Math.PI * 2;

    const hull = new THREE.Mesh(this.wreckHullGeometry, this.charredMaterial);
    hull.rotation.z = THREE.MathUtils.degToRad(-5 + Math.random() * 10);
    hull.castShadow = true;
    hull.receiveShadow = true;
    wreck.add(hull);

    const turret = new THREE.Mesh(this.wreckTurretGeometry, this.charredMaterial);
    turret.position.set(0.1, 0.48, 0);
    turret.rotation.z = Math.PI / 2;
    turret.castShadow = true;
    wreck.add(turret);

    const barrel = new THREE.Mesh(this.wreckBarrelGeometry, this.charredMaterial);
    barrel.position.set(0.95, 0.52, 0.1);
    barrel.rotation.z = Math.PI / 2 + THREE.MathUtils.degToRad(12);
    barrel.castShadow = true;
    wreck.add(barrel);

    for (let i = 0; i < 6; i += 1) {
      const chunk = new THREE.Mesh(
        this.wreckChunkGeometry,
        i % 2 === 0 ? this.charredMaterial : this.ashMaterial,
      );
      chunk.scale.set(0.28 + Math.random() * 0.38, 0.14 + Math.random() * 0.22, 0.24 + Math.random() * 0.36);
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.8 + Math.random() * 1.2;
      chunk.position.set(Math.cos(angle) * radius, Math.random() * 0.18, Math.sin(angle) * radius);
      chunk.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      chunk.castShadow = true;
      chunk.receiveShadow = true;
      wreck.add(chunk);
    }

    return wreck;
  }

  update(delta: number) {
    // Update explosions
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const explosion = this.explosions[i];
      explosion.model?.mixer.update(delta);
      explosion.timer += delta;
      const progress = Math.min(explosion.timer / explosion.duration, 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const fade = Math.max(0, 1 - progress);

      explosion.core.scale.setScalar(0.55 + easeOut * 2.15);
      if (explosion.model) {
        explosion.model.model.scale.setScalar(0.55 + easeOut * 1.35);
        explosion.model.model.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            for (const material of materials) {
              material.opacity = Math.min(0.95, fade * 1.3);
            }
          }
        });
      }
      for (const child of explosion.core.children) {
        if (child instanceof THREE.Mesh) {
          child.rotation.y += (child.userData.spinSpeed as number) * delta;
          child.scale.addScalar((child.userData.expandSpeed as number) * delta);
          (child.material as THREE.MeshBasicMaterial).opacity = Math.min(0.95, fade * 1.4);
        }
      }

      const positions = explosion.particles.geometry.attributes.position.array as Float32Array;
      for (let p = 0; p < positions.length / 3; p += 1) {
        const index = p * 3;
        positions[index] += explosion.particleVelocities[index] * delta;
        positions[index + 1] += explosion.particleVelocities[index + 1] * delta;
        positions[index + 2] += explosion.particleVelocities[index + 2] * delta;

        explosion.particleVelocities[index] *= Math.max(0, 1 - delta * 1.6);
        explosion.particleVelocities[index + 1] -= 6.5 * delta;
        explosion.particleVelocities[index + 2] *= Math.max(0, 1 - delta * 1.6);
      }
      explosion.particles.geometry.attributes.position.needsUpdate = true;

      const particleMaterial = explosion.particles.material as THREE.PointsMaterial;
      particleMaterial.opacity = fade;
      particleMaterial.size = 0.42 + easeOut * 0.45;

      explosion.shockwave.scale.setScalar(0.35 + easeOut * 5.2);
      (explosion.shockwave.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.75 * (1 - progress * 1.35));

      explosion.light.intensity = Math.max(0, 8 * Math.pow(1 - progress, 2.2));
      explosion.light.distance = 10 + easeOut * 8;

      if (explosion.timer >= explosion.duration) {
        this.worldRoot.remove(explosion.core);
        this.worldRoot.remove(explosion.particles);
        this.worldRoot.remove(explosion.shockwave);
        this.worldRoot.remove(explosion.light);
        this.disposeObject(explosion.core, false);
        if (explosion.model) {
          this.releaseExplosionModel(explosion.model);
        }
        explosion.particles.geometry.dispose();
        (explosion.particles.material as THREE.Material).dispose();
        (explosion.shockwave.material as THREE.Material).dispose();
        this.explosions.splice(i, 1);
      }
    }

    // Update bullet impacts
    for (let i = this.impacts.length - 1; i >= 0; i -= 1) {
      const impact = this.impacts[i];
      impact.timer += delta;
      const progress = Math.min(impact.timer / impact.duration, 1);
      const positions = impact.particles.geometry.attributes.position.array as Float32Array;

      for (let p = 0; p < positions.length / 3; p += 1) {
        const index = p * 3;
        positions[index] += impact.velocities[index] * delta;
        positions[index + 1] += impact.velocities[index + 1] * delta;
        positions[index + 2] += impact.velocities[index + 2] * delta;

        impact.velocities[index] *= Math.max(0, 1 - delta * 6);
        impact.velocities[index + 1] -= 8 * delta;
        impact.velocities[index + 2] *= Math.max(0, 1 - delta * 6);
      }

      impact.particles.geometry.attributes.position.needsUpdate = true;
      const material = impact.particles.material as THREE.PointsMaterial;
      material.opacity = Math.max(0, 1 - progress);
      material.size = 0.18 + progress * 0.08;

      if (impact.timer >= impact.duration) {
        this.worldRoot.remove(impact.particles);
        impact.particles.geometry.dispose();
        (impact.particles.material as THREE.Material).dispose();
        this.impacts.splice(i, 1);
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
      this.worldRoot.remove(explosion.core);
      this.worldRoot.remove(explosion.particles);
      this.worldRoot.remove(explosion.shockwave);
      this.worldRoot.remove(explosion.light);
      this.disposeObject(explosion.core, false);
      if (explosion.model) {
        this.releaseExplosionModel(explosion.model);
      }
      explosion.particles.geometry.dispose();
      (explosion.particles.material as THREE.Material).dispose();
      (explosion.shockwave.material as THREE.Material).dispose();
    }
    this.explosions = [];

    for (const wreck of this.burningWrecks) {
      this.worldRoot.remove(wreck.visual);
      this.worldRoot.remove(wreck.fire);
      this.worldRoot.remove(wreck.smoke);
      this.worldRoot.remove(wreck.light);

      this.disposeObject(wreck.visual, false);
      wreck.fire.geometry.dispose();
      (wreck.fire.material as THREE.Material).dispose();
      wreck.smoke.geometry.dispose();
      (wreck.smoke.material as THREE.Material).dispose();
    }
    this.burningWrecks = [];

    for (const impact of this.impacts) {
      this.worldRoot.remove(impact.particles);
      impact.particles.geometry.dispose();
      (impact.particles.material as THREE.Material).dispose();
    }
    this.impacts = [];

    for (const pooled of this.explosionModelPool) {
      this.worldRoot.remove(pooled.model);
      this.disposeObject(pooled.model, false);
    }
    this.explosionModelPool = [];
    this.explosionLobeGeometry.dispose();
    this.wreckChunkGeometry.dispose();
    this.wreckHullGeometry.dispose();
    this.wreckTurretGeometry.dispose();
    this.wreckBarrelGeometry.dispose();
    this.shockwaveGeometry.dispose();
    this.hotMaterials.forEach((material) => material.dispose());
    this.charredMaterial.dispose();
    this.ashMaterial.dispose();
  }
}
