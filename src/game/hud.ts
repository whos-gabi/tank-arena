type HudRefs = {
  intro: HTMLDivElement;
  hud: HTMLDivElement;
  loseScreen: HTMLDivElement;
  winScreen: HTMLDivElement;
  confettiCanvas: HTMLCanvasElement;
  status: HTMLParagraphElement;
  health: HTMLSpanElement;
  healthFill: HTMLDivElement;
  score: HTMLSpanElement;
  enemies: HTMLSpanElement;
  objective: HTMLSpanElement;
  retryButton: HTMLButtonElement;
  winRetryButton: HTMLButtonElement;
  startButton: HTMLButtonElement;
  modeTopDown: HTMLButtonElement;
  modeThirdPerson: HTMLButtonElement;
};

export class HUD {
  private readonly refs: HudRefs;
  private confettiAnimationId: number | null = null;
  private onStartCallback: ((mode: "topdown" | "thirdperson") => void) | null = null;
  private selectedMode: "topdown" | "thirdperson" = "topdown";

  constructor(onRetry: () => void) {
    const intro = document.querySelector<HTMLDivElement>("#intro-overlay");
    const hud = document.querySelector<HTMLDivElement>("#game-hud");
    const loseScreen = document.querySelector<HTMLDivElement>("#lose-screen");
    const winScreen = document.querySelector<HTMLDivElement>("#win-screen");
    const confettiCanvas = document.querySelector<HTMLCanvasElement>("#confetti-canvas");
    const status = document.querySelector<HTMLParagraphElement>("#status");
    const health = document.querySelector<HTMLSpanElement>("#health");
    const healthFill = document.querySelector<HTMLDivElement>("#health-fill");
    const score = document.querySelector<HTMLSpanElement>("#score");
    const enemies = document.querySelector<HTMLSpanElement>("#enemies");
    const objective = document.querySelector<HTMLSpanElement>("#objective");
    const retryButton = document.querySelector<HTMLButtonElement>("#retry-button");
    const winRetryButton = document.querySelector<HTMLButtonElement>("#win-retry-button");
    const startButton = document.querySelector<HTMLButtonElement>("#start-button");
    const modeTopDown = document.querySelector<HTMLButtonElement>("#mode-topdown");
    const modeThirdPerson = document.querySelector<HTMLButtonElement>("#mode-thirdperson");

    if (
      !intro ||
      !hud ||
      !loseScreen ||
      !winScreen ||
      !confettiCanvas ||
      !status ||
      !health ||
      !healthFill ||
      !score ||
      !enemies ||
      !objective ||
      !retryButton ||
      !winRetryButton ||
      !startButton ||
      !modeTopDown ||
      !modeThirdPerson
    ) {
      throw new Error("HUD nodes are missing.");
    }

    this.refs = {
      intro,
      hud,
      loseScreen,
      winScreen,
      confettiCanvas,
      status,
      health,
      healthFill,
      score,
      enemies,
      objective,
      retryButton,
      winRetryButton,
      startButton,
      modeTopDown,
      modeThirdPerson,
    };

    retryButton.addEventListener("click", onRetry);
    winRetryButton.addEventListener("click", onRetry);

    // Load saved camera mode
    const savedMode = localStorage.getItem("tankArenaCameraMode");
    if (savedMode === "thirdperson") {
      this.selectedMode = "thirdperson";
      modeTopDown.classList.remove("active");
      modeThirdPerson.classList.add("active");
    }

    modeTopDown.addEventListener("click", () => {
      this.selectedMode = "topdown";
      modeTopDown.classList.add("active");
      modeThirdPerson.classList.remove("active");
      localStorage.setItem("tankArenaCameraMode", "topdown");
    });

    modeThirdPerson.addEventListener("click", () => {
      this.selectedMode = "thirdperson";
      modeTopDown.classList.remove("active");
      modeThirdPerson.classList.add("active");
      localStorage.setItem("tankArenaCameraMode", "thirdperson");
    });

    startButton.addEventListener("click", () => {
      if (this.onStartCallback) {
        this.onStartCallback(this.selectedMode);
      }
    });
  }

  onStart(callback: (mode: "topdown" | "thirdperson") => void) {
    this.onStartCallback = callback;
  }

  startIntro() {
    this.refs.intro.classList.remove("hidden");
    this.refs.hud.classList.remove("visible");
  }

  skipIntro() {
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

  showWinScreen(score: number) {
    this.refs.winScreen.classList.add("visible");
    this.refs.status.textContent = `Victory! Final score ${score}`;
    this.startConfetti();
  }

  hideWinScreen() {
    this.refs.winScreen.classList.remove("visible");
    this.stopConfetti();
  }

  private startConfetti() {
    const canvas = this.refs.confettiCanvas;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const fireworks: Array<{
      x: number;
      y: number;
      particles: Array<{
        x: number;
        y: number;
        vx: number;
        vy: number;
        color: string;
        life: number;
      }>;
    }> = [];

    const colors = ["#6de8ff", "#76f2ff", "#58b7ff", "#ff9e73", "#ffd700", "#ff6b9d"];

    // Create 5 fireworks at random positions
    for (let i = 0; i < 5; i++) {
      const x = canvas.width * (0.2 + Math.random() * 0.6);
      const y = canvas.height * (0.2 + Math.random() * 0.4);
      const particles = [];

      for (let j = 0; j < 30; j++) {
        const angle = (Math.PI * 2 * j) / 30;
        const speed = 2 + Math.random() * 3;
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color: colors[Math.floor(Math.random() * colors.length)],
          life: 1.0,
        });
      }

      fireworks.push({ x, y, particles });
    }

    let frameCount = 0;
    const maxFrames = 90;

    const animate = () => {
      if (frameCount >= maxFrames) {
        this.stopConfetti();
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const firework of fireworks) {
        for (const particle of firework.particles) {
          particle.x += particle.vx;
          particle.y += particle.vy;
          particle.vy += 0.1;
          particle.life -= 0.015;

          if (particle.life > 0) {
            ctx.globalAlpha = particle.life;
            ctx.fillStyle = particle.color;
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      ctx.globalAlpha = 1;
      frameCount++;
      this.confettiAnimationId = requestAnimationFrame(animate);
    };

    animate();
  }

  private stopConfetti() {
    if (this.confettiAnimationId !== null) {
      cancelAnimationFrame(this.confettiAnimationId);
      this.confettiAnimationId = null;
    }
    const ctx = this.refs.confettiCanvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, this.refs.confettiCanvas.width, this.refs.confettiCanvas.height);
    }
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
