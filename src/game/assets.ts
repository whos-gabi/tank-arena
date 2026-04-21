import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type LoadedGLTF = Awaited<ReturnType<GLTFLoader["loadAsync"]>>;

export type Assets = {
  tank: THREE.Group;
  container: THREE.Group;
  boxes: THREE.Group;
  glyph: THREE.Group;
};

const assetUrls = {
  tank: new URL("../../3d/mother_3_-_pork_tank.glb", import.meta.url).href,
  container: new URL("../../3d/Shipping Container.glb", import.meta.url).href,
  boxes: new URL("../../3d/Cardboard Boxes.glb", import.meta.url).href,
  glyph: new URL("../../3d/spell_glyph.glb", import.meta.url).href,
};

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

export async function loadAssets(setStatus: (message: string) => void) {
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
