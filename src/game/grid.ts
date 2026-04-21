import * as THREE from "three";
import { CELL_SIZE, GRID_SIZE, HALF_GRID } from "./config";

export type GridCell = {
  col: number;
  row: number;
};

export function keyOf(cell: GridCell) {
  return `${cell.col},${cell.row}`;
}

export function createGridValue<T>(factory: () => T) {
  return Array.from({ length: GRID_SIZE }, () =>
    Array.from({ length: GRID_SIZE }, factory),
  );
}

export function inBounds(cell: GridCell) {
  return cell.col >= 0 && cell.col < GRID_SIZE && cell.row >= 0 && cell.row < GRID_SIZE;
}

export function worldFromCell(cell: GridCell) {
  return new THREE.Vector3(
    (cell.col - HALF_GRID) * CELL_SIZE,
    0,
    (cell.row - HALF_GRID) * CELL_SIZE,
  );
}

export function cellFromWorld(position: THREE.Vector3): GridCell {
  return {
    col: THREE.MathUtils.clamp(Math.round(position.x / CELL_SIZE + HALF_GRID), 0, GRID_SIZE - 1),
    row: THREE.MathUtils.clamp(Math.round(position.z / CELL_SIZE + HALF_GRID), 0, GRID_SIZE - 1),
  };
}

export function neighbors4(cell: GridCell) {
  return [
    { col: cell.col + 1, row: cell.row },
    { col: cell.col - 1, row: cell.row },
    { col: cell.col, row: cell.row + 1 },
    { col: cell.col, row: cell.row - 1 },
  ].filter(inBounds);
}

export function neighbors8(cell: GridCell) {
  const results: GridCell[] = [];

  for (let dc = -1; dc <= 1; dc += 1) {
    for (let dr = -1; dr <= 1; dr += 1) {
      if (dc === 0 && dr === 0) {
        continue;
      }

      const next = {
        col: cell.col + dc,
        row: cell.row + dr,
      };

      if (inBounds(next)) {
        results.push(next);
      }
    }
  }

  return results;
}

export function gridDistance(a: GridCell, b: GridCell) {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}
