type HudRefs = {
  intro: HTMLDivElement;
  hud: HTMLDivElement;
  loseScreen: HTMLDivElement;
  status: HTMLParagraphElement;
  health: HTMLSpanElement;
  healthFill: HTMLDivElement;
  score: HTMLSpanElement;
  enemies: HTMLSpanElement;
  objective: HTMLSpanElement;
  retryButton: HTMLButtonElement;
};

export class HUD {
  private readonly refs: HudRefs;
  private introTimer: number | undefined;

  constructor(onRetry: () => void) {
    const intro = document.querySelector<HTMLDivElement>("#intro-overlay");
    const hud = document.querySelector<HTMLDivElement>("#game-hud");
    const loseScreen = document.querySelector<HTMLDivElement>("#lose-screen");
    const status = document.querySelector<HTMLParagraphElement>("#status");
    const health = document.querySelector<HTMLSpanElement>("#health");
    const healthFill = document.querySelector<HTMLDivElement>("#health-fill");
    const score = document.querySelector<HTMLSpanElement>("#score");
    const enemies = document.querySelector<HTMLSpanElement>("#enemies");
    const objective = document.querySelector<HTMLSpanElement>("#objective");
    const retryButton = document.querySelector<HTMLButtonElement>("#retry-button");

    if (
      !intro ||
      !hud ||
      !loseScreen ||
      !status ||
      !health ||
      !healthFill ||
      !score ||
      !enemies ||
      !objective ||
      !retryButton
    ) {
      throw new Error("HUD nodes are missing.");
    }

    this.refs = {
      intro,
      hud,
      loseScreen,
      status,
      health,
      healthFill,
      score,
      enemies,
      objective,
      retryButton,
    };

    retryButton.addEventListener("click", onRetry);
  }

  startIntro() {
    this.refs.intro.classList.remove("hidden");
    this.refs.hud.classList.remove("visible");
    window.clearTimeout(this.introTimer);
    this.introTimer = window.setTimeout(() => {
      this.refs.intro.classList.add("hidden");
      this.refs.hud.classList.add("visible");
    }, 2800);
  }

  skipIntro() {
    window.clearTimeout(this.introTimer);
    this.refs.intro.classList.add("hidden");
    this.refs.hud.classList.add("visible");
  }

  showLoseScreen(score: number) {
    this.refs.loseScreen.classList.add("visible");
    this.refs.status.textContent = `You lost. Final score ${score}`;
  }

  hideLoseScreen() {
    this.refs.loseScreen.classList.remove("visible");
  }

  setStatus(text: string) {
    this.refs.status.textContent = text;
  }

  setHealth(value: number) {
    const clamped = Math.max(0, Math.min(100, value));
    this.refs.health.textContent = `Hull ${Math.ceil(clamped)}`;
    this.refs.healthFill.style.transform = `scaleX(${clamped / 100})`;
  }

  setScore(value: number) {
    this.refs.score.textContent = `Score ${value}`;
  }

  setEnemies(value: number) {
    this.refs.enemies.textContent = `Enemies ${value}`;
  }

  setObjective(text: string) {
    this.refs.objective.textContent = text;
  }
}
