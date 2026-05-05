import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type LoadedGLTF = Awaited<ReturnType<GLTFLoader["loadAsync"]>>;

export type Assets = {
  playerTank: THREE.Group;
  enemyTank: THREE.Group;
  walkingRobot: THREE.Group;
  container: THREE.Group;
  boxes: THREE.Group;
  cardboardBoxes: THREE.Group;
  ibcTank: THREE.Group;
  damagedWall: THREE.Group;
  crashedCar: THREE.Group;
  stoneFloor: THREE.Group;
  glyph: THREE.Group;
  explosion: THREE.Group;
  explosionAnimations: THREE.AnimationClip[];
};

const assetUrls = {
  playerTank: new URL("../../3d/main-tank.glb", import.meta.url).href,
  enemyTank: new URL("../../3d/mother_3_-_pork_tank.glb", import.meta.url).href,
  walkingRobot: new URL("../../3d/walking_robot.glb", import.meta.url).href,
  container: new URL("../../3d/Shipping Container.glb", import.meta.url).href,
  boxes: new URL("../../3d/Cardboard Boxes.glb", import.meta.url).href,
  cardboardBoxes: new URL("../../3d/set_of_cardboard_boxes.glb", import.meta.url).href,
  ibcTank: new URL("../../3d/ibc_tank.glb", import.meta.url).href,
  damagedWall: new URL("../../3d/damaged_wall.glb", import.meta.url).href,
  crashedCar: new URL("../../3d/crashed_abandoned_car_-_game_ready.glb", import.meta.url).href,
  stoneFloor: new URL("../../3d/stone_floor.glb", import.meta.url).href,
  glyph: new URL("../../3d/spell_glyph.glb", import.meta.url).href,
  explosion: new URL("../../3d/timeframe_explosion.glb", import.meta.url).href,
};

function applyStandardMaterialTweaks(material: THREE.Material) {
  if (
    material instanceof THREE.MeshStandardMaterial ||
    material instanceof THREE.MeshPhysicalMaterial
  ) {
    material.envMapIntensity = 0.7;
    material.needsUpdate = true;
  }
}

function normalizeAsset(root: THREE.Group, targetFootprint: number, preserveTextures = false) {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;

      if (Array.isArray(child.material)) {
        child.material.forEach((mat) => {
          applyStandardMaterialTweaks(mat);
          if (preserveTextures && mat instanceof THREE.MeshStandardMaterial) {
            mat.needsUpdate = true;
          }
        });
      } else {
        applyStandardMaterialTweaks(child.material);
        if (preserveTextures && child.material instanceof THREE.MeshStandardMaterial) {
          child.material.needsUpdate = true;
        }
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
  root.position.y -= center.y;
  root.position.z -= center.z;
  root.position.y = -scaledBox.min.y;
  root.updateMatrixWorld(true);

  return root;
}

export async function loadAssets(setStatus: (message: string) => void) {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url, loaded, total) => {
    setStatus(`Loading assets ${loaded}/${total}...`);
  };

  const loader = new GLTFLoader(manager);
  const [playerTankGltf, enemyTankGltf, walkingRobotGltf, containerGltf, boxesGltf, cardboardBoxesGltf, ibcTankGltf, damagedWallGltf, crashedCarGltf, stoneFloorGltf, glyphGltf, explosionGltf]: [
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
    LoadedGLTF,
  ] = await Promise.all([
    loader.loadAsync(assetUrls.playerTank),
    loader.loadAsync(assetUrls.enemyTank),
    loader.loadAsync(assetUrls.walkingRobot),
    loader.loadAsync(assetUrls.container),
    loader.loadAsync(assetUrls.boxes),
    loader.loadAsync(assetUrls.cardboardBoxes),
    loader.loadAsync(assetUrls.ibcTank),
    loader.loadAsync(assetUrls.damagedWall),
    loader.loadAsync(assetUrls.crashedCar),
    loader.loadAsync(assetUrls.stoneFloor),
    loader.loadAsync(assetUrls.glyph),
    loader.loadAsync(assetUrls.explosion),
  ]);

  // Store animations in userData for robot
  const robotAsset = normalizeAsset(walkingRobotGltf.scene, 2.0, true);
  robotAsset.userData.animations = walkingRobotGltf.animations;

  return {
    playerTank: normalizeAsset(playerTankGltf.scene, 5.2),
    enemyTank: normalizeAsset(enemyTankGltf.scene, 2.6),
    walkingRobot: robotAsset,
    container: normalizeAsset(containerGltf.scene, 4.3),
    boxes: normalizeAsset(boxesGltf.scene, 2.4),
    cardboardBoxes: normalizeAsset(cardboardBoxesGltf.scene, 2.4),
    ibcTank: normalizeAsset(ibcTankGltf.scene, 3.5),
    damagedWall: normalizeAsset(damagedWallGltf.scene, 4.5),
    crashedCar: normalizeAsset(crashedCarGltf.scene, 4.0),
    stoneFloor: normalizeAsset(stoneFloorGltf.scene, 4.5),
    glyph: normalizeAsset(glyphGltf.scene, 1.9),
    explosion: explosionGltf.scene,
    explosionAnimations: explosionGltf.animations,
  } satisfies Assets;
}
