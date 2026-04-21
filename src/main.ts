import "./style.css";
import { Game } from "./game/Game";

const viewport = document.querySelector<HTMLDivElement>("#viewport");

if (!viewport) {
  throw new Error("Missing viewport.");
}

const game = new Game(viewport);
void game.boot();
