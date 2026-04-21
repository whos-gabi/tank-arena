import { GridCell, keyOf, neighbors8 } from "./grid";

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

export function findPath(start: GridCell, goal: GridCell, blocked: boolean[][]) {
  const open = new Set<string>([keyOf(start)]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[keyOf(start), 0]]);
  const fScore = new Map<string, number>([[keyOf(start), heuristic(start, goal)]]);

  while (open.size > 0) {
    let currentKey = "";
    let bestScore = Number.POSITIVE_INFINITY;

    for (const key of open) {
      const score = fScore.get(key) ?? Number.POSITIVE_INFINITY;
      if (score < bestScore) {
        bestScore = score;
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
      if (blocked[neighbor.row][neighbor.col]) {
        continue;
      }

      const isDiagonal = neighbor.col !== current.col && neighbor.row !== current.row;
      if (isDiagonal) {
        if (
          blocked[current.row][neighbor.col] ||
          blocked[neighbor.row][current.col]
        ) {
          continue;
        }
      }

      const tentative =
        (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + (isDiagonal ? Math.SQRT2 : 1);
      const neighborKey = keyOf(neighbor);

      if (tentative < (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
        cameFrom.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentative);
        fScore.set(neighborKey, tentative + heuristic(neighbor, goal));
        open.add(neighborKey);
      }
    }
  }

  return [] as GridCell[];
}
