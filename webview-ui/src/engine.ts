import { drawCharacterSprite, getPcFrame, loadSprites } from './sprites.js';
import type { ToolHistoryEntry, ToolStatus } from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TILE = 16;
const RENDER_SCALE = 2;
const CHAR_W = 16;
const CHAR_H = 32;
const MAX_HISTORY = 50;

const WALL_ROWS = 2;
const DESK_SPACING_X = 3;
const DESK_SPACING_Y = 5;
const DESK_START_COL = 1;
const DESK_START_ROW = WALL_ROWS;

// Decoration scale helpers (applied via ctx.save/scale/restore in drawRoomDecorations)
const STATIC_DECO_SCALE = 2;   // plants, bookshelf, coffee machine
const LEISURE_SCALE     = 1.8; // gaming setup, TV+couch

// Idle leisure timings
const IDLE_WANDER_MS = 10_000;      // after this long idle, consider leisure
const LEISURE_MIN_MS = 15_000;      // minimum time at leisure spot
const LEISURE_MAX_MS = 35_000;      // maximum time at leisure spot
const LEISURE_CHANCE = 0.45;        // probability of picking leisure vs staying at desk


// ─── Types ────────────────────────────────────────────────────────────────────

export type CharacterActivity =
  | 'idle' | 'walking' | 'typing' | 'reading' | 'waiting'
  | 'running' | 'searching'
  | 'gaming' | 'watching_tv' | 'coffee_break';

export type LeisureType = 'gaming' | 'tv' | 'coffee';

export interface Character {
  id: string;
  name: string;
  x: number; y: number;
  targetX: number; targetY: number;
  deskX: number; deskY: number;
  activity: CharacterActivity;
  activeTools: Map<string, { name: string; status: ToolStatus }>;
  toolHistory: ToolHistoryEntry[];
  palette: number;
  frame: number; frameTimer: number;
  direction: 'left' | 'right' | 'up' | 'down';
  inputTokens: number; outputTokens: number;
  sessionStartedAt: number;
  speechBubble?: { text: string; expiresAt: number };
  selected: boolean;
  // Leisure system
  idleGoal: LeisureType | 'desk' | null;
  idleTimer: number;       // ms until next idle action
  leisureTimer: number;    // ms remaining in leisure activity
}

interface Pet {
  x: number; y: number;
  targetX: number; targetY: number;
  direction: 'left' | 'right';
  frame: number; frameTimer: number;
  isSitting: boolean;
  sitTimer: number;    // ms until next sit/unsit toggle
  color: 'orange' | 'gray';
}

interface LeisureSpot {
  type: LeisureType;
  itemX: number; itemY: number;
  standX: number; standY: number;
  occupant: string | null;
}

export interface Office {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  characters: Map<string, Character>;
  animFrameId: number;
  lastTimestamp: number;
  pcFrame: number; pcFrameTimer: number;
  cols: number; rows: number;
  onCharacterClick?: (id: string) => void;
  pet: Pet;
  leisureSpots: LeisureSpot[];
  elapsedTime: number;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let nextPaletteIndex = 0;

export function createOffice(canvas: HTMLCanvasElement): Office {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const pet: Pet = {
    x: 80, y: 80,
    targetX: 80, targetY: 80,
    direction: 'right',
    frame: 0, frameTimer: 0,
    isSitting: true,
    sitTimer: 4000,
    color: 'orange',
  };

  const office: Office = {
    canvas, ctx,
    characters: new Map(),
    animFrameId: 0,
    lastTimestamp: 0,
    pcFrame: 0, pcFrameTimer: 0,
    cols: 9, rows: 18,
    pet,
    leisureSpots: [],
    elapsedTime: 0,
  };

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX / RENDER_SCALE;
    const cy = (e.clientY - rect.top) * scaleY / RENDER_SCALE;
    let hit = false;
    for (const char of office.characters.values()) {
      if (cx >= char.x && cx <= char.x + CHAR_W && cy >= char.y && cy <= char.y + CHAR_H) {
        for (const c of office.characters.values()) c.selected = false;
        char.selected = true;
        office.onCharacterClick?.(char.id);
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const c of office.characters.values()) c.selected = false;
      office.onCharacterClick?.('');
    }
  });

  loadSprites();
  return office;
}

// ─── Resize & Layout ──────────────────────────────────────────────────────────

export function resizeOffice(office: Office, cssWidth: number, cssHeight: number): void {
  const w = Math.max(Math.round(cssWidth), 64);
  const h = Math.max(Math.round(cssHeight), 64);
  if (office.canvas.width === w && office.canvas.height === h) return;

  office.canvas.width = w;
  office.canvas.height = h;
  office.canvas.getContext('2d')!.imageSmoothingEnabled = false;

  office.cols = Math.max(2, Math.floor(w / TILE / RENDER_SCALE));
  office.rows = Math.max(2, Math.floor(h / TILE / RENDER_SCALE));

  computeLeisureSpots(office);
  repositionDesks(office);

  // Clamp pet into new bounds
  const floorY = WALL_ROWS * TILE + TILE;
  const maxX = (office.cols - 2) * TILE;
  const maxY = (office.rows - 2) * TILE;
  office.pet.x = Math.min(Math.max(office.pet.x, TILE), maxX);
  office.pet.y = Math.min(Math.max(office.pet.y, floorY), maxY);
}

function computeLeisureSpots(office: Office): void {
  const { cols, rows } = office;
  const spots: LeisureSpot[] = [];

  // Coffee machine (drawn at STATIC_DECO_SCALE = 2×): 24×40px logical from (cmX, cmY)
  if (cols >= 5) {
    const cx = (cols - 2) * TILE;
    const cy = WALL_ROWS * TILE;
    spots.push({
      type: 'coffee',
      itemX: cx, itemY: cy,
      standX: cx - TILE, standY: cy + TILE * 2 + 4,
      occupant: null,
    });
  }

  // Gaming setup (drawn at LEISURE_SCALE = 1.5×): bean bag at ~(3, 27–42) from origin
  if (rows >= 10 && cols >= 6) {
    const gY = (rows - 5) * TILE;
    spots.push({
      type: 'gaming',
      itemX: 0, itemY: gY,
      standX: TILE + 4, standY: gY + TILE * 2 + 4,
      occupant: null,
    });
  }

  // TV + couch (drawn at LEISURE_SCALE = 1.5×): shifted right to avoid overlap with gaming
  // tvX uses (cols-4) instead of (cols-6) so gaming (ends ~42px) and TV (starts at cols-4*TILE) don't overlap
  if (rows >= 10 && cols >= 7) {
    const tvX = Math.max(TILE * 3, (cols - 4) * TILE);
    const tvY = (rows - 5) * TILE;
    spots.push({
      type: 'tv',
      itemX: tvX, itemY: tvY,
      standX: tvX + TILE * 2, standY: tvY + TILE * 2,
      occupant: null,
    });
  }

  office.leisureSpots = spots;
}

function repositionDesks(office: Office): void {
  let idx = 0;
  for (const c of office.characters.values()) {
    const { deskX, deskY } = deskPosition(office, idx);
    c.deskX = deskX;
    c.deskY = deskY;
    if (c.idleGoal === 'desk' || c.idleGoal === null) {
      c.targetX = deskX;
      c.targetY = deskY + TILE;
    }
    idx++;
  }
}

function deskPosition(office: Office, idx: number): { deskX: number; deskY: number } {
  // Keep desks away from the left column (plant) and right column (coffee)
  const usableCols = Math.max(1, office.cols - 3);
  const desksPerRow = Math.max(1, Math.floor(usableCols / DESK_SPACING_X));
  const col = DESK_START_COL + 1 + (idx % desksPerRow) * DESK_SPACING_X;
  const row = DESK_START_ROW + Math.floor(idx / desksPerRow) * DESK_SPACING_Y;
  return { deskX: col * TILE, deskY: row * TILE };
}

// ─── Character management ─────────────────────────────────────────────────────

export function addCharacter(office: Office, id: string, name: string): void {
  if (office.characters.has(id)) return;
  const idx = office.characters.size;
  const { deskX, deskY } = deskPosition(office, idx);
  office.characters.set(id, {
    id, name,
    x: deskX, y: deskY + TILE,
    targetX: deskX, targetY: deskY + TILE,
    deskX, deskY,
    activity: 'idle',
    activeTools: new Map(),
    toolHistory: [],
    palette: nextPaletteIndex++ % 6,
    frame: 0, frameTimer: 0,
    direction: 'down',
    inputTokens: 0, outputTokens: 0,
    sessionStartedAt: Date.now(),
    selected: false,
    idleGoal: null,
    idleTimer: IDLE_WANDER_MS * (0.5 + Math.random()),
    leisureTimer: 0,
  });
}

export function removeCharacter(office: Office, id: string): void {
  // Free any leisure spot this character was using
  for (const spot of office.leisureSpots) {
    if (spot.occupant === id) spot.occupant = null;
  }
  office.characters.delete(id);
  repositionDesks(office);
}

export function onToolStart(
  office: Office, agentId: string, toolId: string, toolName: string, status: ToolStatus,
): void {
  const c = office.characters.get(agentId);
  if (!c) return;
  // Snap back to desk immediately — no wandering while working
  freeSpotsFor(office, agentId);
  c.idleGoal = null;
  c.x = c.deskX;
  c.y = c.deskY + TILE;
  c.targetX = c.deskX;
  c.targetY = c.deskY + TILE;
  c.activeTools.set(toolId, { name: toolName, status });
  c.activity = toolStatusToActivity(status);
  c.direction = 'up';
  c.speechBubble = { text: shortToolName(toolName), expiresAt: Date.now() + 3500 };
  c.toolHistory.unshift({ toolId, toolName, status, startedAt: Date.now() });
  if (c.toolHistory.length > MAX_HISTORY) c.toolHistory.length = MAX_HISTORY;
  // Reset idle timer so they don't immediately dash to leisure after work ends
  c.idleTimer = IDLE_WANDER_MS * (1 + Math.random());
}

export function onToolDone(office: Office, agentId: string, toolId: string): void {
  const c = office.characters.get(agentId);
  if (!c) return;
  const entry = c.toolHistory.find((e) => e.toolId === toolId && !e.finishedAt);
  if (entry) entry.finishedAt = Date.now();
  c.activeTools.delete(toolId);
  if (c.activeTools.size === 0) {
    c.activity = 'idle';
    c.direction = 'down';
    c.idleTimer = IDLE_WANDER_MS * (0.5 + Math.random());
  } else {
    c.activity = toolStatusToActivity([...c.activeTools.values()][0].status);
  }
}

export function setWaiting(office: Office, agentId: string): void {
  const c = office.characters.get(agentId);
  if (!c) return;
  freeSpotsFor(office, agentId);
  c.activity = 'waiting';
  c.direction = 'down';
  c.idleGoal = null;
  c.speechBubble = { text: '?', expiresAt: Date.now() + 15000 };
}

export function setIdle(office: Office, agentId: string): void {
  const c = office.characters.get(agentId);
  if (!c) return;
  c.activity = 'idle';
  c.direction = 'down';
  c.idleTimer = IDLE_WANDER_MS * (0.5 + Math.random());
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

export function startLoop(office: Office): void {
  function tick(ts: number) {
    const dt = Math.min(ts - office.lastTimestamp, 100);
    office.lastTimestamp = ts;
    update(office, dt);
    render(office);
    office.animFrameId = requestAnimationFrame(tick);
  }
  office.animFrameId = requestAnimationFrame(tick);
}

export function stopLoop(office: Office): void {
  cancelAnimationFrame(office.animFrameId);
}

// ─── Update ───────────────────────────────────────────────────────────────────

function update(office: Office, dt: number): void {
  office.elapsedTime += dt;

  // PC animation
  office.pcFrameTimer += dt;
  if (office.pcFrameTimer >= 400) {
    office.pcFrameTimer = 0;
    office.pcFrame = (office.pcFrame + 1) % 3;
  }

  updatePet(office, dt);

  const maxX = Math.max(0, (office.cols - 2) * TILE);
  const maxY = Math.max(0, (office.rows - 3) * TILE);
  const floorStartY = WALL_ROWS * TILE;

  for (const c of office.characters.values()) {
    updateCharacterAnimation(c, dt);
    updateCharacterMovement(c, dt, maxX, maxY);

    // Only run idle behavior when character has no work
    if (c.activeTools.size === 0 && c.activity !== 'waiting') {
      updateIdleBehavior(office, c, dt, maxX, maxY, floorStartY);
    }

    if (c.speechBubble && Date.now() > c.speechBubble.expiresAt) c.speechBubble = undefined;
  }
}

function updateCharacterAnimation(c: Character, dt: number): void {
  c.frameTimer += dt;
  const fps = c.activity === 'idle' ? 3 : 8;
  if (c.frameTimer >= 1000 / fps) {
    c.frameTimer = 0;
    c.frame = (c.frame + 1) % 4;
  }
}

function updateCharacterMovement(c: Character, dt: number, maxX: number, maxY: number): void {
  if (c.activity !== 'walking') return;
  const speed = 55 * (dt / 1000);
  const dx = c.targetX - c.x;
  const dy = c.targetY - c.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < speed) {
    c.x = c.targetX;
    c.y = c.targetY;
    // Arrived — resolve pending goal
    if (c.idleGoal === 'desk' || c.idleGoal === null) {
      c.activity = 'idle';
      c.direction = 'down';
    } else if (c.idleGoal) {
      c.activity = goalToActivity(c.idleGoal);
      c.direction = 'down';
      c.speechBubble = { text: goalBubble(c.idleGoal), expiresAt: Date.now() + c.leisureTimer };
    }
    void maxX; void maxY;
  } else {
    c.x += (dx / dist) * speed;
    c.y += (dy / dist) * speed;
    c.direction = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? 'right' : 'left')
      : (dy > 0 ? 'down' : 'up');
  }
}

function updateIdleBehavior(
  office: Office, c: Character, dt: number,
  maxX: number, maxY: number, floorStartY: number,
): void {
  // Countdown idle timer
  if (c.idleTimer > 0) {
    c.idleTimer -= dt;
  }

  // If doing leisure, count down leisure timer
  if (c.idleGoal && c.idleGoal !== 'desk' && c.activity !== 'walking') {
    c.leisureTimer -= dt;
    if (c.leisureTimer <= 0) {
      // Done — go back to desk
      freeSpotsFor(office, c.id);
      c.idleGoal = 'desk';
      c.activity = 'walking';
      c.targetX = c.deskX;
      c.targetY = c.deskY + TILE;
      c.speechBubble = undefined;
      c.idleTimer = IDLE_WANDER_MS * (0.5 + Math.random());
    }
    return;
  }

  // Don't trigger if already moving or in leisure
  if (c.activity === 'walking') return;
  if (c.idleGoal && c.idleGoal !== 'desk') return;

  // Random idle wander at desk
  if (c.activity === 'idle' && c.idleGoal === null && Math.random() < 0.0003) {
    const wx = TILE + Math.floor(Math.random() * maxX);
    const wy = floorStartY + TILE + Math.floor(Math.random() * Math.max(1, maxY - floorStartY));
    c.targetX = wx;
    c.targetY = wy;
    c.activity = 'walking';
    return;
  }

  // When idle timer expires, consider leisure
  if (c.idleTimer <= 0 && c.activity === 'idle') {
    if (Math.random() < LEISURE_CHANCE && office.leisureSpots.length > 0) {
      // Pick an available leisure spot
      const available = office.leisureSpots.filter((s) => s.occupant === null);
      if (available.length > 0) {
        const spot = available[Math.floor(Math.random() * available.length)];
        spot.occupant = c.id;
        c.idleGoal = spot.type;
        c.leisureTimer = LEISURE_MIN_MS + Math.random() * (LEISURE_MAX_MS - LEISURE_MIN_MS);
        c.targetX = spot.standX;
        c.targetY = spot.standY;
        c.activity = 'walking';
        return;
      }
    }
    // Reset timer even if we didn't go anywhere
    c.idleTimer = IDLE_WANDER_MS * (0.5 + Math.random());
  }

  void maxX; void maxY;
}

function freeSpotsFor(office: Office, agentId: string): void {
  for (const spot of office.leisureSpots) {
    if (spot.occupant === agentId) spot.occupant = null;
  }
}

function furnitureZones(office: Office): Array<{ x: number; y: number; w: number; h: number }> {
  const { cols, rows } = office;
  const z: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (rows >= 10 && cols >= 6) {
    const gY = (rows - 5) * TILE;
    z.push({ x: 0, y: gY, w: 54, h: 50 });
  }
  if (rows >= 10 && cols >= 7) {
    const tvX = Math.max(TILE * 3, (cols - 4) * TILE);
    const tvY = (rows - 5) * TILE;
    z.push({ x: tvX, y: tvY - 4, w: 65, h: 58 });
  }
  return z;
}

function petInZone(px: number, py: number, zones: Array<{ x: number; y: number; w: number; h: number }>): boolean {
  const pw = 12, ph = 16;
  for (const z of zones) {
    if (px + pw > z.x && px < z.x + z.w && py + ph > z.y && py < z.y + z.h) return true;
  }
  return false;
}

function updatePet(office: Office, dt: number): void {
  const pet = office.pet;
  const floorY = WALL_ROWS * TILE + TILE;
  const maxX = Math.max(TILE, (office.cols - 3) * TILE);
  const maxY = Math.max(floorY + TILE, (office.rows - 2) * TILE);
  const zones = furnitureZones(office);

  // Frame animation
  pet.frameTimer += dt;
  const fps = pet.isSitting ? 1 : 5;
  if (pet.frameTimer >= 1000 / fps) {
    pet.frameTimer = 0;
    pet.frame = (pet.frame + 1) % 2;
  }

  // Sit/stand timer
  pet.sitTimer -= dt;
  if (pet.sitTimer <= 0) {
    pet.isSitting = !pet.isSitting;
    pet.sitTimer = pet.isSitting
      ? 3000 + Math.random() * 5000    // sit for 3-8s
      : 2000 + Math.random() * 4000;   // walk for 2-6s
    if (!pet.isSitting) {
      // Pick new target, retry up to 10 times to avoid furniture zones
      let tx = 0, ty = 0;
      for (let i = 0; i < 10; i++) {
        tx = Math.max(TILE, Math.min(maxX, TILE + Math.floor(Math.random() * maxX)));
        ty = Math.max(floorY, Math.min(maxY, floorY + Math.floor(Math.random() * (maxY - floorY))));
        if (!petInZone(tx, ty, zones)) break;
      }
      pet.targetX = tx;
      pet.targetY = ty;
    }
  }

  // Move if walking
  if (!pet.isSitting) {
    const speed = 35 * (dt / 1000);
    const dx = pet.targetX - pet.x;
    const dy = pet.targetY - pet.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < speed) {
      pet.x = pet.targetX;
      pet.y = pet.targetY;
      pet.isSitting = true;
      pet.sitTimer = 2000 + Math.random() * 4000;
    } else {
      const newX = pet.x + (dx / dist) * speed;
      const newY = pet.y + (dy / dist) * speed;
      if (petInZone(newX, newY, zones)) {
        // Hit furniture — sit and pick new target next cycle
        pet.isSitting = true;
        pet.sitTimer = 500 + Math.random() * 1000;
      } else {
        pet.x = newX;
        pet.y = newY;
        pet.direction = dx >= 0 ? 'right' : 'left';
      }
    }
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render(office: Office): void {
  const { ctx, canvas, characters } = office;
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;

  ctx.save();
  ctx.scale(RENDER_SCALE, RENDER_SCALE);

  drawFloor(ctx, office);
  drawWalls(ctx, office);
  drawBaseboardShadow(ctx, office);

  // Room decorations (behind characters)
  drawRoomDecorations(ctx, office);

  // Workstations
  const sorted = [...characters.values()].sort((a, b) => a.deskY - b.deskY);
  for (const c of sorted) drawWorkstation(ctx, c, office.pcFrame, office.elapsedTime);

  // Pet (below characters in y-order if possible)
  drawCat(ctx, office.pet, office.elapsedTime);

  // Characters
  const sortedByY = [...characters.values()].sort((a, b) => a.y - b.y);
  for (const c of sortedByY) drawCharacter(ctx, c, office);

  ctx.restore();
}

// ─── Floor ────────────────────────────────────────────────────────────────────

function drawFloor(ctx: CanvasRenderingContext2D, office: Office): void {
  const { cols, rows } = office;
  const W = cols * TILE;
  const floorY = WALL_ROWS * TILE;
  const floorH = (rows - WALL_ROWS) * TILE;

  // Base fill — warm gray-teal tile (RPG office style)
  ctx.fillStyle = '#afc0b8';
  ctx.fillRect(0, floorY, W, floorH);

  // Alternating 2×2 tile shading for subtle checkerboard depth
  for (let row = WALL_ROWS; row < rows; row += 2) {
    for (let col = 0; col < cols; col += 2) {
      ctx.fillStyle = (Math.floor(row / 2) + Math.floor(col / 2)) % 2 === 0
        ? 'rgba(255,255,255,0.06)'
        : 'rgba(0,0,0,0.04)';
      ctx.fillRect(col * TILE, row * TILE, TILE * 2, TILE * 2);
    }
  }

  // Tile grid lines — horizontal
  ctx.fillStyle = 'rgba(0,0,0,0.13)';
  for (let row = WALL_ROWS; row <= rows; row++) {
    ctx.fillRect(0, row * TILE, W, 1);
  }
  // Tile grid lines — vertical
  for (let col = 0; col <= cols; col++) {
    ctx.fillRect(col * TILE, floorY, 1, floorH);
  }
}

// ─── Walls ────────────────────────────────────────────────────────────────────

function drawWalls(ctx: CanvasRenderingContext2D, office: Office): void {
  const { cols } = office;
  const LW = cols * TILE;
  const wallH = WALL_ROWS * TILE;

  // Cream/beige wall base
  ctx.fillStyle = '#d8cfb0';
  ctx.fillRect(0, 0, LW, wallH);

  // Subtle wall texture
  for (let y = 0; y < wallH; y += 3) {
    ctx.fillStyle = 'rgba(0,0,0,0.025)';
    ctx.fillRect(0, y, LW, 1);
  }

  // Ceiling line
  ctx.fillStyle = '#c2b898';
  ctx.fillRect(0, 0, LW, 1);

  // Windows with wood frames and blue glass panes
  const winW = 20;
  const winH = wallH - 6;
  let wx = 6;
  while (wx + winW + 4 <= LW - 22) {
    // Wood frame
    ctx.fillStyle = '#9a7030';
    ctx.fillRect(wx - 2, 2, winW + 4, winH + 2);
    // Glass — blue sky
    ctx.fillStyle = '#78aad0';
    ctx.fillRect(wx, 3, winW, winH);
    // Upper half brighter
    ctx.fillStyle = '#98c4e8';
    ctx.fillRect(wx + 1, 4, winW - 2, Math.floor(winH / 2) - 1);
    // Light streak
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(wx + 2, 4, 3, winH - 2);
    // Divider cross
    ctx.fillStyle = '#9a7030';
    ctx.fillRect(wx, 3 + Math.floor(winH / 2), winW, 2);
    ctx.fillRect(wx + Math.floor(winW / 2) - 1, 3, 2, winH);
    wx += winW + 14;
    if (wx + winW > LW - 18) break;
  }

  // Clock on the right side of the wall
  if (LW > 50) {
    const clkR = 7;
    const clkX = LW - clkR - 4;
    const clkY = clkR + 3;
    // Face
    ctx.fillStyle = '#f5eed8';
    ctx.beginPath();
    ctx.arc(clkX, clkY, clkR, 0, Math.PI * 2);
    ctx.fill();
    // Rim
    ctx.strokeStyle = '#8a6828';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(clkX, clkY, clkR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 0.5;
    // Hour tick marks
    ctx.fillStyle = '#5a4018';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      ctx.fillRect(
        Math.round(clkX + Math.cos(a) * (clkR - 1.5) - 0.5),
        Math.round(clkY + Math.sin(a) * (clkR - 1.5) - 0.5),
        1, 1,
      );
    }
    // Hands (real time)
    const now = new Date();
    const hrA = ((now.getHours() % 12) + now.getMinutes() / 60) / 12 * Math.PI * 2 - Math.PI / 2;
    const mnA = now.getMinutes() / 60 * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = '#2a1808';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(clkX, clkY);
    ctx.lineTo(clkX + Math.cos(hrA) * 3.5, clkY + Math.sin(hrA) * 3.5); ctx.stroke();
    ctx.strokeStyle = '#5a3810'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(clkX, clkY);
    ctx.lineTo(clkX + Math.cos(mnA) * 5.5, clkY + Math.sin(mnA) * 5.5); ctx.stroke();
    ctx.lineWidth = 1;
  }
}

function drawBaseboardShadow(ctx: CanvasRenderingContext2D, office: Office): void {
  const LW = office.cols * TILE;
  const baseY = WALL_ROWS * TILE;
  // Warm wood baseboard
  ctx.fillStyle = '#9a7030';
  ctx.fillRect(0, baseY, LW, 3);
  ctx.fillStyle = '#b88840';
  ctx.fillRect(0, baseY, LW, 1);
  // Shadow below baseboard
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, baseY + 3, LW, 3);
}

// ─── Room Decorations ─────────────────────────────────────────────────────────

// Helper: draw fn at position (tx, ty) with scale factor s
function scaled(
  ctx: CanvasRenderingContext2D,
  tx: number, ty: number, s: number,
  fn: (ctx: CanvasRenderingContext2D) => void,
): void {
  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(s, s);
  fn(ctx);
  ctx.restore();
}

function drawRoomDecorations(ctx: CanvasRenderingContext2D, office: Office): void {
  const { cols, rows } = office;
  const baseY = WALL_ROWS * TILE;
  const S = STATIC_DECO_SCALE;
  const LS = LEISURE_SCALE;

  // Tall plant — top-left corner (2×)
  scaled(ctx, 0, baseY, S, (c) => drawPlantTall(c, 0, 0));

  // Coffee machine — top-right (2×)
  if (cols >= 5) {
    const cmX = (cols - 2) * TILE;
    scaled(ctx, cmX, baseY, S, (c) => drawCoffeeMachine(c, 0, 0, office.elapsedTime));
  }

  // Bookshelf — beside coffee machine, top-right (2×)
  if (cols >= 6) {
    const bsX = (cols - 5) * TILE;
    scaled(ctx, bsX, baseY, S, (c) => drawBookshelf(c, 0, 0));
  }

  // Small plant — between bookshelf and coffee machine (2×)
  if (cols >= 8) {
    const cmX = (cols - 2) * TILE;
    scaled(ctx, cmX - TILE * 2, baseY + TILE, S, (c) => drawPlantSmall(c, 0, 0));
  }

  // Gaming setup — bottom-left (1.8×)
  if (rows >= 10 && cols >= 6) {
    const gY = (rows - 5) * TILE;
    const spot = office.leisureSpots.find((s) => s.type === 'gaming');
    const active = spot?.occupant !== null;
    scaled(ctx, 0, gY, LS, (c) => drawGamingSetup(c, 0, 0, active, office.elapsedTime));
  }

  // TV + couch — bottom-right (1.8×)
  if (rows >= 10 && cols >= 7) {
    const tvX = Math.max(TILE * 3, (cols - 4) * TILE);
    const tvY = (rows - 5) * TILE;
    const spot = office.leisureSpots.find((s) => s.type === 'tv');
    const active = spot?.occupant !== null;
    scaled(ctx, tvX, tvY, LS, (c) => drawCouchTV(c, 0, 0, active, office.elapsedTime));
  }
}

// ─── Tall Plant ───────────────────────────────────────────────────────────────

function drawPlantTall(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // Pot
  ctx.fillStyle = '#6b3a2a';
  ctx.fillRect(x + 2, y + 16, 10, 8);
  ctx.fillStyle = '#8b4a36';
  ctx.fillRect(x + 1, y + 14, 12, 3);
  // Soil
  ctx.fillStyle = '#2a1a0a';
  ctx.fillRect(x + 2, y + 14, 10, 2);
  // Main stem
  ctx.fillStyle = '#2d5a1e';
  ctx.fillRect(x + 6, y + 4, 2, 12);
  // Leaves — layered for depth
  const leafColors = ['#1a4a0e', '#2d7a1e', '#3a9628', '#4ab332'];
  // Left leaves
  ctx.fillStyle = leafColors[0];
  ctx.fillRect(x, y + 2, 6, 4);
  ctx.fillRect(x + 1, y, 5, 3);
  ctx.fillStyle = leafColors[1];
  ctx.fillRect(x + 1, y + 2, 5, 3);
  ctx.fillStyle = leafColors[2];
  ctx.fillRect(x + 2, y + 1, 4, 3);
  // Right leaves
  ctx.fillStyle = leafColors[0];
  ctx.fillRect(x + 8, y + 4, 6, 4);
  ctx.fillRect(x + 8, y + 6, 5, 3);
  ctx.fillStyle = leafColors[1];
  ctx.fillRect(x + 8, y + 5, 5, 3);
  ctx.fillStyle = leafColors[2];
  ctx.fillRect(x + 9, y + 4, 4, 3);
  // Center leaves (front)
  ctx.fillStyle = leafColors[2];
  ctx.fillRect(x + 4, y, 6, 4);
  ctx.fillStyle = leafColors[3];
  ctx.fillRect(x + 5, y, 4, 3);
  // Highlight on leaves
  ctx.fillStyle = 'rgba(255,255,200,0.12)';
  ctx.fillRect(x + 5, y + 1, 2, 1);
}

// ─── Small Plant (Succulent) ──────────────────────────────────────────────────

function drawPlantSmall(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // Tiny pot
  ctx.fillStyle = '#6b3a2a';
  ctx.fillRect(x + 2, y + 5, 8, 5);
  ctx.fillStyle = '#8b4a36';
  ctx.fillRect(x + 1, y + 4, 10, 2);
  ctx.fillStyle = '#2a1a0a';
  ctx.fillRect(x + 2, y + 4, 8, 1);
  // Succulent leaves - rosette pattern
  ctx.fillStyle = '#2d7a4a';
  ctx.fillRect(x + 4, y + 1, 4, 4);
  ctx.fillStyle = '#3a9a60';
  ctx.fillRect(x + 3, y + 2, 3, 3);
  ctx.fillRect(x + 6, y + 2, 3, 3);
  ctx.fillRect(x + 4, y, 4, 3);
  ctx.fillStyle = '#5ab878';
  ctx.fillRect(x + 4, y + 1, 2, 2);
  ctx.fillRect(x + 5, y, 2, 2);
  // Highlight
  ctx.fillStyle = 'rgba(200,255,220,0.25)';
  ctx.fillRect(x + 4, y + 1, 1, 1);
}

// ─── Coffee Machine ───────────────────────────────────────────────────────────

function drawCoffeeMachine(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  // Body
  ctx.fillStyle = '#2a2a3a';
  ctx.fillRect(x, y + 2, 12, 18);
  ctx.fillStyle = '#3a3a4e';
  ctx.fillRect(x + 1, y + 2, 10, 16);
  // Top panel
  ctx.fillStyle = '#1e1e2c';
  ctx.fillRect(x, y, 12, 4);
  ctx.fillStyle = '#2e2e40';
  ctx.fillRect(x + 1, y + 1, 10, 2);
  // Screen
  ctx.fillStyle = '#00aa33';
  ctx.fillRect(x + 2, y + 4, 5, 4);
  ctx.fillStyle = '#00dd44';
  ctx.fillRect(x + 2, y + 4, 4, 3);
  // Pixel "88" on screen
  ctx.fillStyle = '#00ff55';
  ctx.fillRect(x + 3, y + 5, 1, 2);
  ctx.fillRect(x + 5, y + 5, 1, 2);
  // Buttons
  ctx.fillStyle = '#cc3300';
  ctx.fillRect(x + 9, y + 4, 2, 2);
  ctx.fillStyle = '#ff6600';
  ctx.fillRect(x + 9, y + 7, 2, 2);
  ctx.fillStyle = '#0066cc';
  ctx.fillRect(x + 9, y + 10, 2, 2);
  // Dispensing spout
  ctx.fillStyle = '#1a1a28';
  ctx.fillRect(x + 3, y + 12, 6, 2);
  ctx.fillStyle = '#555566';
  ctx.fillRect(x + 4, y + 14, 4, 2);
  // Cup tray
  ctx.fillStyle = '#4a4a5a';
  ctx.fillRect(x + 1, y + 16, 10, 2);
  ctx.fillStyle = '#3a3a48';
  ctx.fillRect(x + 2, y + 16, 8, 1);
  // Cup (when idle or being used)
  ctx.fillStyle = '#eeeecc';
  ctx.fillRect(x + 4, y + 14, 4, 3);
  ctx.fillStyle = '#cc8833';
  ctx.fillRect(x + 4, y + 14, 4, 1);
  // Steam animation (bubbles rising)
  const steamPhase = (t / 600) % 1;
  for (let i = 0; i < 3; i++) {
    const phase = (steamPhase + i * 0.33) % 1;
    const sy = y + 10 - Math.floor(phase * 8);
    const sx = x + 4 + (i % 2 === 0 ? 0 : 2);
    const alpha = 1 - phase;
    ctx.fillStyle = `rgba(220,220,255,${alpha * 0.6})`;
    if (sy < y + 2) continue;
    ctx.fillRect(sx, sy, 1, 1);
  }
  // Brand label
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '4px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('☕', x + 6, y + 23);
  ctx.textAlign = 'left';
}

// ─── Bookshelf ────────────────────────────────────────────────────────────────

function drawBookshelf(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // Shelf body
  ctx.fillStyle = '#5c3822';
  ctx.fillRect(x, y, 14, 20);
  ctx.fillStyle = '#6e4a2e';
  ctx.fillRect(x + 1, y + 1, 12, 18);
  // Shelf boards
  ctx.fillStyle = '#5c3822';
  ctx.fillRect(x, y + 9, 14, 2);
  // Books — top shelf
  const books1 = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261'];
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = books1[i % books1.length];
    ctx.fillRect(x + 2 + i * 2, y + 2, 2, 7);
    // Spine highlight
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(x + 2 + i * 2, y + 2, 1, 5);
  }
  // Books — bottom shelf
  const books2 = ['#6d6875', '#b5838d', '#e5989b', '#ffb4a2', '#ffcdb2'];
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = books2[i % books2.length];
    ctx.fillRect(x + 2 + i * 2 + 1, y + 11, 2, 7);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(x + 2 + i * 2 + 1, y + 11, 1, 5);
  }
  // Small figurine on top
  ctx.fillStyle = '#ffd700';
  ctx.fillRect(x + 11, y - 3, 2, 4);
  ctx.fillStyle = '#ffaa00';
  ctx.fillRect(x + 11, y - 3, 2, 2);
}

// ─── Gaming Setup ─────────────────────────────────────────────────────────────

function drawGamingSetup(
  ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean, t: number,
): void {
  // Floor mat / rug
  ctx.fillStyle = '#2a1a3a';
  ctx.fillRect(x, y + TILE, 28, 12);
  ctx.fillStyle = '#3a2850';
  ctx.fillRect(x + 1, y + TILE + 1, 26, 10);

  // Bean bag chair
  ctx.fillStyle = '#8b0000';
  ctx.fillRect(x + 2, y + TILE + 2, 14, 10);
  ctx.fillStyle = '#cc1111';
  ctx.fillRect(x + 3, y + TILE + 2, 12, 8);
  ctx.fillStyle = '#dd3333';
  ctx.fillRect(x + 5, y + TILE + 2, 8, 5);
  // Highlight
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(x + 6, y + TILE + 3, 4, 2);

  // TV stand
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(x + 18, y + TILE + 4, 2, 8);
  ctx.fillStyle = '#333';
  ctx.fillRect(x + 16, y + TILE + 10, 6, 2);

  // TV screen
  const screenGlow = active ? '#1a0a3a' : '#0a0a0e';
  ctx.fillStyle = screenGlow;
  ctx.fillRect(x + 14, y, 14, 12);
  ctx.fillStyle = active ? '#2a1a5a' : '#111';
  ctx.fillRect(x + 15, y + 1, 12, 10);

  if (active) {
    // Game screen glow — blue/purple
    const gPhase = Math.sin(t / 200) * 0.5 + 0.5;
    ctx.fillStyle = `rgba(80,40,180,${0.3 + gPhase * 0.2})`;
    ctx.fillRect(x + 15, y + 1, 12, 10);
    // Pixel "game" elements on screen
    ctx.fillStyle = '#ff4444';
    ctx.fillRect(x + 17, y + 3, 3, 3);
    ctx.fillStyle = '#44ff44';
    ctx.fillRect(x + 22, y + 6, 3, 3);
    ctx.fillStyle = '#4444ff';
    ctx.fillRect(x + 19, y + 7, 2, 2);
  } else {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(x + 17, y + 3, 8, 6);
  }

  // Game console
  ctx.fillStyle = '#111122';
  ctx.fillRect(x + 15, y + 12, 10, 5);
  ctx.fillStyle = '#222233';
  ctx.fillRect(x + 16, y + 12, 8, 4);
  ctx.fillStyle = active ? '#00ff88' : '#004422';
  ctx.fillRect(x + 16, y + 13, 2, 2);

  // Controller (on floor or in hand)
  ctx.fillStyle = '#2a2a3a';
  ctx.fillRect(x + 4, y + TILE + 8, 8, 3);
  ctx.fillStyle = '#3a3a4a';
  ctx.fillRect(x + 5, y + TILE + 8, 6, 2);
  // D-pad
  ctx.fillStyle = '#555';
  ctx.fillRect(x + 5, y + TILE + 9, 1, 1);
  ctx.fillRect(x + 7, y + TILE + 9, 1, 1);
  // Buttons
  ctx.fillStyle = active ? '#ff4444' : '#663333';
  ctx.fillRect(x + 9, y + TILE + 9, 1, 1);
  ctx.fillStyle = active ? '#4444ff' : '#333366';
  ctx.fillRect(x + 10, y + TILE + 9, 1, 1);

}

// ─── TV + Couch ───────────────────────────────────────────────────────────────

function drawCouchTV(
  ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean, t: number,
): void {
  // TV unit — against the wall, drawn first so couch appears in front
  ctx.fillStyle = '#1a1a22';
  ctx.fillRect(x + 6, y - 2, 22, 16);
  ctx.fillStyle = active ? '#0d1520' : '#0a0a0e';
  ctx.fillRect(x + 7, y - 1, 20, 14);

  if (active) {
    const ch = Math.floor(t / 8000) % 3;
    if (ch === 0) {
      // Nature documentary (green)
      ctx.fillStyle = '#1a4a1a';
      ctx.fillRect(x + 8, y, 18, 12);
      ctx.fillStyle = '#2a7a2a';
      ctx.fillRect(x + 8, y + 7, 18, 5);
      ctx.fillStyle = '#3aaa3a';
      for (let i = 0; i < 5; i++) ctx.fillRect(x + 9 + i * 3, y + 4, 2, 4);
      ctx.fillStyle = '#88dd55';
      ctx.fillRect(x + 10, y + 3, 4, 3);
    } else if (ch === 1) {
      // News — pixel lines only, no text
      ctx.fillStyle = '#0a1a3a';
      ctx.fillRect(x + 8, y, 18, 12);
      ctx.fillStyle = '#1a3a7a';
      ctx.fillRect(x + 8, y, 18, 3);
      ctx.fillStyle = '#aaaaff';
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(x + 9, y + 4 + i * 3, 14, 1);
      }
    } else {
      // Code editor
      ctx.fillStyle = '#1e1e2e';
      ctx.fillRect(x + 8, y, 18, 12);
      const codeColors = ['#cba6f7', '#89b4fa', '#a6e3a1', '#f38ba8'];
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = codeColors[i % codeColors.length];
        const w2 = 4 + Math.floor(Math.random() * 8);
        ctx.fillRect(x + 9 + (i % 2) * 5, y + 2 + i * 3, w2, 1);
      }
    }
  } else {
    // Screen off — dark with subtle reflection
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(x + 8, y, 18, 12);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(x + 9, y + 1, 8, 3);
  }

  // TV stand
  ctx.fillStyle = '#2a2a32';
  ctx.fillRect(x + 15, y + 14, 4, 3);
  ctx.fillStyle = '#3a3a42';
  ctx.fillRect(x + 13, y + 16, 8, 2);

  // Area rug — drawn after TV stand so it appears in front
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(x, y + TILE, 36, 14);
  ctx.fillStyle = '#4a3525';
  ctx.fillRect(x + 1, y + TILE + 1, 34, 12);
  ctx.fillStyle = '#5a4535';
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(x + 4 + i * 8, y + TILE + 4, 4, 4);
  }

  // Couch — drawn last, appears in front of TV and rug
  ctx.fillStyle = '#4a5568';
  ctx.fillRect(x, y + TILE + 4, 34, 10);
  ctx.fillStyle = '#5a6678';
  ctx.fillRect(x + 1, y + TILE + 4, 32, 8);
  // Cushions
  ctx.fillStyle = '#6a7688';
  ctx.fillRect(x + 2, y + TILE + 5, 14, 6);
  ctx.fillRect(x + 18, y + TILE + 5, 14, 6);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(x + 3, y + TILE + 5, 8, 2);
  ctx.fillRect(x + 19, y + TILE + 5, 8, 2);
  // Armrests
  ctx.fillStyle = '#4a5568';
  ctx.fillRect(x, y + TILE + 3, 3, 11);
  ctx.fillRect(x + 31, y + TILE + 3, 3, 11);
  ctx.fillStyle = '#5a6678';
  ctx.fillRect(x, y + TILE + 3, 3, 2);
  ctx.fillRect(x + 31, y + TILE + 3, 3, 2);
  // Legs
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(x + 2, y + TILE + 13, 3, 2);
  ctx.fillRect(x + 29, y + TILE + 13, 3, 2);

  // Screen glow on couch cushions (active only, after couch is drawn)
  if (active) {
    const glow = Math.sin(t / 1500) * 0.05 + 0.08;
    ctx.fillStyle = `rgba(100,150,255,${glow})`;
    ctx.fillRect(x + 1, y + TILE + 4, 32, 8);
  }

  // Remote on armrest
  ctx.fillStyle = '#2a2a3a';
  ctx.fillRect(x + 28, y + TILE + 5, 4, 7);
  ctx.fillStyle = '#ff4444';
  ctx.fillRect(x + 29, y + TILE + 6, 1, 1);
  ctx.fillStyle = '#4444ff';
  ctx.fillRect(x + 31, y + TILE + 6, 1, 1);
}

// ─── Area Rug ────────────────────────────────────────────────────────────────

function drawAreaRug(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const W = TILE * 4;
  const H = TILE * 2;
  // Rug base — warm rust red, visible on teal floor
  ctx.fillStyle = 'rgba(160,60,40,0.38)';
  ctx.fillRect(x, y, W, H);
  // Border
  ctx.fillStyle = 'rgba(200,90,50,0.28)';
  ctx.fillRect(x + 2, y + 2, W - 4, H - 4);
  // Inner field
  ctx.fillStyle = 'rgba(120,40,20,0.22)';
  ctx.fillRect(x + 4, y + 4, W - 8, H - 8);
  // Diamond pattern
  ctx.fillStyle = 'rgba(220,140,80,0.2)';
  ctx.fillRect(x + W / 2 - 3, y + 4, 6, H - 8);
  ctx.fillRect(x + 4, y + H / 2 - 2, W - 8, 4);
  // Corner accents
  ctx.fillStyle = 'rgba(240,180,100,0.22)';
  ctx.fillRect(x + 4, y + 4, 4, 4);
  ctx.fillRect(x + W - 8, y + 4, 4, 4);
  ctx.fillRect(x + 4, y + H - 8, 4, 4);
  ctx.fillRect(x + W - 8, y + H - 8, 4, 4);
}

// ─── Workstation ─────────────────────────────────────────────────────────────

function drawWorkstation(
  ctx: CanvasRenderingContext2D, c: Character, pcFrame: number, t: number,
): void {
  const dx = c.deskX;
  const dy = c.deskY;
  const isActive = c.activity !== 'idle' && c.activity !== 'waiting'
    && c.activity !== 'gaming' && c.activity !== 'watching_tv' && c.activity !== 'coffee_break';

  // Chair
  ctx.fillStyle = '#5a3520';
  ctx.fillRect(dx + 2, dy + TILE * 2, 12, 10);
  ctx.fillStyle = '#4a2810';
  ctx.fillRect(dx + 4, dy + TILE + 10, 8, TILE);
  ctx.fillStyle = '#6a4030';
  ctx.fillRect(dx + 2, dy + TILE * 2, 12, 4);

  // Desk
  ctx.fillStyle = '#a07830';
  ctx.fillRect(dx - 16, dy + TILE, 48, 4);
  ctx.fillStyle = '#8a6420';
  ctx.fillRect(dx - 16, dy + TILE + 4, 48, 14);
  ctx.fillStyle = '#6a4a10';
  ctx.fillRect(dx - 14, dy + TILE + 18, 4, 8);
  ctx.fillRect(dx + 26, dy + TILE + 18, 4, 8);
  // Desk items: coffee mug
  ctx.fillStyle = '#eee8aa';
  ctx.fillRect(dx + 20, dy + TILE, 5, 5);
  ctx.fillStyle = '#cc8833';
  ctx.fillRect(dx + 20, dy + TILE, 5, 1);
  // Notepad
  ctx.fillStyle = '#f5f5dc';
  ctx.fillRect(dx - 14, dy + TILE, 10, 8);
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  for (let i = 0; i < 3; i++) ctx.fillRect(dx - 13, dy + TILE + 2 + i * 2, 7, 1);

  // PC monitor
  const pcKey = getPcFrame(pcFrame, isActive);
  const pcDrawn = drawMonitor(ctx, pcKey, dx + 2, dy + 2, isActive, t);
  void pcDrawn;

  // Glow when active
  if (isActive && c.activeTools.size > 0) {
    ctx.globalAlpha = 0.18 + Math.sin(t / 350) * 0.08;
    ctx.fillStyle = activityGlow(c.activity);
    ctx.fillRect(dx - 16, dy, 48, TILE * 3);
    ctx.globalAlpha = 1;
  }
}

function drawMonitor(
  ctx: CanvasRenderingContext2D, pcKey: string, x: number, y: number, isActive: boolean, t: number,
): boolean {
  void pcKey;
  // Monitor bezel
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(x, y, 12, 18);
  ctx.fillStyle = isActive ? '#2a3a56' : '#101018';
  ctx.fillRect(x + 1, y + 1, 10, 12);
  if (isActive) {
    // Animated code lines
    const lineOffset = Math.floor(t / 500) % 4;
    const lineColors = ['#cba6f7', '#89b4fa', '#a6e3a1', '#fab387', '#f38ba8'];
    for (let i = 0; i < 5; i++) {
      const li = (i + lineOffset) % 5;
      ctx.fillStyle = lineColors[li % lineColors.length];
      const lw = 3 + (li % 3) * 2;
      ctx.fillRect(x + 2, y + 2 + i * 2, lw, 1);
    }
    // Cursor blink
    if (Math.floor(t / 500) % 2 === 0) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x + 2, y + 11, 1, 2);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(x + 2, y + 2, 3, 8);
  } else {
    ctx.fillStyle = '#101018';
    ctx.fillRect(x + 2, y + 2, 8, 10);
  }
  // Stand
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(x + 5, y + 14, 2, 4);
  ctx.fillRect(x + 3, y + 17, 6, 2);
  return true;
}

// ─── Cat (Pet mascot) ────────────────────────────────────────────────────────

function drawCat(ctx: CanvasRenderingContext2D, pet: Pet, t: number): void {
  const x = Math.round(pet.x);
  const y = Math.round(pet.y);
  const isOrange = pet.color === 'orange';
  const body   = isOrange ? '#e8941a' : '#8a8a9a';
  const stripe = isOrange ? '#a55c00' : '#5a5a6a';
  const belly  = isOrange ? '#f5c878' : '#c8c8d8';
  const eye    = '#33cc66';
  const nose   = '#ff9999';

  if (pet.isSitting) {
    drawCatSitting(ctx, x, y, body, stripe, belly, eye, nose, t);
  } else {
    drawCatWalking(ctx, x, y, body, stripe, belly, eye, pet.direction, pet.frame);
  }

  // Name tag above cat
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x - 2, y - 7, 16, 6);
  ctx.fillStyle = '#f9e2af';
  ctx.font = '4px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('pixel', x + 6, y - 3);
  ctx.textAlign = 'left';
}

function drawCatSitting(
  ctx: CanvasRenderingContext2D, x: number, y: number,
  body: string, stripe: string, belly: string, eye: string, nose: string, t: number,
): void {
  // Ears
  ctx.fillStyle = body;
  ctx.fillRect(x + 1, y, 2, 3);
  ctx.fillRect(x + 9, y, 2, 3);
  ctx.fillStyle = nose;
  ctx.fillRect(x + 1, y, 1, 2);
  ctx.fillRect(x + 10, y, 1, 2);

  // Head
  ctx.fillStyle = body;
  ctx.fillRect(x, y + 2, 12, 7);

  // Stripe on head
  ctx.fillStyle = stripe;
  ctx.fillRect(x + 5, y + 2, 1, 3);
  ctx.fillRect(x + 3, y + 3, 1, 2);
  ctx.fillRect(x + 7, y + 3, 1, 2);

  // Eyes (blinking every ~3s)
  const blinkPhase = Math.floor(t / 3000) % 8;
  if (blinkPhase === 0) {
    ctx.fillStyle = stripe;
    ctx.fillRect(x + 2, y + 4, 2, 1);
    ctx.fillRect(x + 8, y + 4, 2, 1);
  } else {
    ctx.fillStyle = eye;
    ctx.fillRect(x + 2, y + 4, 2, 2);
    ctx.fillRect(x + 8, y + 4, 2, 2);
    // Pupil
    ctx.fillStyle = '#002200';
    ctx.fillRect(x + 3, y + 4, 1, 2);
    ctx.fillRect(x + 9, y + 4, 1, 2);
  }

  // Nose
  ctx.fillStyle = nose;
  ctx.fillRect(x + 5, y + 6, 2, 1);
  // Whiskers
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillRect(x - 2, y + 6, 3, 1);
  ctx.fillRect(x + 11, y + 6, 3, 1);
  ctx.fillRect(x - 2, y + 7, 3, 1);
  ctx.fillRect(x + 11, y + 7, 3, 1);

  // Body
  ctx.fillStyle = body;
  ctx.fillRect(x + 1, y + 8, 10, 8);
  // Belly
  ctx.fillStyle = belly;
  ctx.fillRect(x + 3, y + 9, 6, 6);
  // Body stripe
  ctx.fillStyle = stripe;
  ctx.fillRect(x + 1, y + 9, 1, 3);
  ctx.fillRect(x + 10, y + 9, 1, 3);

  // Tail (curling to side)
  ctx.fillStyle = body;
  ctx.fillRect(x + 11, y + 12, 3, 2);
  ctx.fillRect(x + 12, y + 10, 2, 3);
  ctx.fillStyle = stripe;
  ctx.fillRect(x + 13, y + 10, 1, 1);

  // Paws
  ctx.fillStyle = body;
  ctx.fillRect(x + 2, y + 15, 3, 2);
  ctx.fillRect(x + 7, y + 15, 3, 2);
  // Paw toes
  ctx.fillStyle = belly;
  ctx.fillRect(x + 2, y + 16, 1, 1);
  ctx.fillRect(x + 4, y + 16, 1, 1);
  ctx.fillRect(x + 7, y + 16, 1, 1);
  ctx.fillRect(x + 9, y + 16, 1, 1);
}

function drawCatWalking(
  ctx: CanvasRenderingContext2D, x: number, y: number,
  body: string, stripe: string, belly: string, eye: string, direction: 'left' | 'right', frame: number,
): void {
  const flip = direction === 'left';

  ctx.save();
  if (flip) {
    ctx.translate(x + 12, 0);
    ctx.scale(-1, 1);
    ctx.translate(-x, 0);
  }

  // Body (side view)
  ctx.fillStyle = body;
  ctx.fillRect(x, y + 4, 12, 7);
  // Belly
  ctx.fillStyle = belly;
  ctx.fillRect(x + 2, y + 7, 7, 4);
  // Stripes
  ctx.fillStyle = stripe;
  ctx.fillRect(x + 4, y + 4, 1, 5);
  ctx.fillRect(x + 7, y + 4, 1, 5);

  // Head
  ctx.fillStyle = body;
  ctx.fillRect(x + 8, y + 1, 8, 7);
  // Ear
  ctx.fillStyle = body;
  ctx.fillRect(x + 12, y, 2, 3);
  // Eye
  ctx.fillStyle = eye;
  ctx.fillRect(x + 13, y + 3, 2, 2);
  ctx.fillStyle = '#002200';
  ctx.fillRect(x + 14, y + 3, 1, 2);
  // Nose
  ctx.fillStyle = '#ff9999';
  ctx.fillRect(x + 15, y + 5, 1, 1);

  // Legs (animated)
  ctx.fillStyle = body;
  const legOff = frame === 0 ? 0 : 2;
  ctx.fillRect(x + 1, y + 10 + legOff, 3, 3 - legOff);
  ctx.fillRect(x + 5, y + 10 - legOff, 3, 3 + legOff);
  ctx.fillRect(x + 9, y + 10 + legOff, 3, 3 - legOff);

  // Tail (up)
  ctx.fillStyle = body;
  ctx.fillRect(x - 2, y + 3, 3, 2);
  ctx.fillRect(x - 3, y + 1, 2, 4);
  ctx.fillRect(x - 4, y, 2, 3);
  ctx.fillStyle = stripe;
  ctx.fillRect(x - 3, y + 1, 1, 2);

  ctx.restore();
}

// ─── Character ────────────────────────────────────────────────────────────────

function drawCharacter(ctx: CanvasRenderingContext2D, c: Character, office: Office): void {
  const x = Math.round(c.x);
  const y = Math.round(c.y);

  // If character is at leisure, draw them doing the activity
  if (c.activity === 'gaming' || c.activity === 'watching_tv' || c.activity === 'coffee_break') {
    const spot = office.leisureSpots.find((s) => s.occupant === c.id);
    if (spot) {
      drawCharacterAtLeisure(ctx, c, spot, office.elapsedTime);
      return;
    }
  }

  // Selection ring
  if (c.selected) {
    ctx.strokeStyle = '#f5c2e7';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 1]);
    ctx.strokeRect(x - 1, y - 1, CHAR_W + 2, CHAR_H + 2);
    ctx.setLineDash([]);
  }

  // Ground shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(x + CHAR_W / 2, y + CHAR_H, CHAR_W / 3, 2, 0, 0, Math.PI * 2);
  ctx.fill();

  const spriteDrawn = drawCharacterSprite(ctx, c.palette, c.direction, c.frame, x, y, 1);
  if (!spriteDrawn) {
    ctx.fillStyle = activityGlow(c.activity);
    ctx.fillRect(x + 2, y, CHAR_W - 4, CHAR_H);
    ctx.fillStyle = '#FFCBA4';
    ctx.fillRect(x + 3, y, CHAR_W - 6, 10);
  }

  drawCharacterBadge(ctx, c, x, y);
  drawCharacterLabel(ctx, c, x, y);
  drawSpeechBubble(ctx, c, x, y);
  drawTokenBar(ctx, c, x, y);
}

function drawCharacterAtLeisure(
  ctx: CanvasRenderingContext2D, c: Character, spot: LeisureSpot, t: number,
): void {
  const x = Math.round(spot.standX);
  const y = Math.round(spot.standY);

  // Ground shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(x + CHAR_W / 2, y + CHAR_H, CHAR_W / 3, 2, 0, 0, Math.PI * 2);
  ctx.fill();

  // Draw character facing the spot
  const dir = spot.type === 'coffee' ? 'up' : 'down';
  const frame = Math.floor(t / 600) % 4;
  const spriteDrawn = drawCharacterSprite(ctx, c.palette, dir, frame, x, y, 1);
  if (!spriteDrawn) {
    ctx.fillStyle = activityGlow(c.activity);
    ctx.fillRect(x + 2, y, CHAR_W - 4, CHAR_H);
    ctx.fillStyle = '#FFCBA4';
    ctx.fillRect(x + 3, y, CHAR_W - 6, 10);
  }

  // Activity indicator above character
  const icons: Record<string, string> = { gaming: '🎮', tv: '📺', coffee: '☕' };
  const icon = icons[spot.type] ?? '•';
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(x + 1, y - 10, 14, 9);
  ctx.font = '7px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(icon, x + CHAR_W / 2, y - 3);
  ctx.textAlign = 'left';

  drawCharacterLabel(ctx, c, x, y);
}

function drawCharacterBadge(ctx: CanvasRenderingContext2D, c: Character, x: number, y: number): void {
  const badge = activityBadge(c.activity);
  if (!badge) return;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(x + 3, y - 8, 10, 7);
  ctx.font = '6px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.fillText(badge, x + CHAR_W / 2, y - 3);
  ctx.textAlign = 'left';
}

function drawCharacterLabel(ctx: CanvasRenderingContext2D, c: Character, x: number, y: number): void {
  const label = c.name.length > 9 ? c.name.slice(0, 8) + '…' : c.name;
  const lw = label.length * 4 + 4;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(x + CHAR_W / 2 - lw / 2, y + CHAR_H + 1, lw, 7);
  ctx.fillStyle = c.selected ? '#f5c2e7' : '#ddd';
  ctx.font = '5px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + CHAR_W / 2, y + CHAR_H + 6);
  ctx.textAlign = 'left';
}

function drawSpeechBubble(ctx: CanvasRenderingContext2D, c: Character, x: number, y: number): void {
  if (!c.speechBubble) return;
  const txt = c.speechBubble.text;
  const bw = Math.min(txt.length * 4 + 8, 60);
  const bx = Math.max(1, x + CHAR_W / 2 - bw / 2);
  const by = y - 18;
  ctx.fillStyle = '#fff';
  ctx.fillRect(bx, by, bw, 11);
  ctx.strokeStyle = '#aaa';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(bx, by, bw, 11);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + CHAR_W / 2 - 2, by + 10, 4, 3);
  ctx.fillStyle = '#333';
  ctx.font = '5px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(txt, bx + bw / 2, by + 7);
  ctx.textAlign = 'left';
}

function drawTokenBar(ctx: CanvasRenderingContext2D, c: Character, x: number, y: number): void {
  const usage = Math.min((c.inputTokens + c.outputTokens) / 200_000, 1);
  if (usage === 0) return;
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(x, y + CHAR_H + 9, CHAR_W, 2);
  ctx.fillStyle = usage > 0.8 ? '#f38ba8' : usage > 0.5 ? '#fab387' : '#a6e3a1';
  ctx.fillRect(x, y + CHAR_H + 9, Math.round(CHAR_W * usage), 2);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toolStatusToActivity(status: ToolStatus): CharacterActivity {
  switch (status) {
    case 'reading': return 'reading';
    case 'writing': return 'typing';
    case 'running': return 'running';
    case 'searching': return 'searching';
    default: return 'typing';
  }
}

function goalToActivity(goal: LeisureType): CharacterActivity {
  switch (goal) {
    case 'gaming': return 'gaming';
    case 'tv': return 'watching_tv';
    case 'coffee': return 'coffee_break';
  }
}

function goalBubble(goal: LeisureType): string {
  switch (goal) {
    case 'gaming': return 'GG EZ';
    case 'tv': return '📺';
    case 'coffee': return '☕ ahhh';
  }
}

function activityBadge(activity: CharacterActivity): string {
  switch (activity) {
    case 'typing': return '⌨';
    case 'reading': return '📖';
    case 'running': return '⚙';
    case 'searching': return '🔍';
    case 'waiting': return '⏳';
    default: return '';
  }
}

function activityGlow(activity: CharacterActivity): string {
  switch (activity) {
    case 'typing': return '#5599ff';
    case 'reading': return '#55cc99';
    case 'running': return '#ff9955';
    case 'searching': return '#cc55ff';
    case 'waiting': return '#ffdd55';
    case 'gaming': return '#8844ff';
    case 'watching_tv': return '#4488ff';
    case 'coffee_break': return '#cc7722';
    default: return '#6B8CFF';
  }
}

function shortToolName(name: string): string {
  const n = name.replace(/([A-Z])/g, ' $1').trim();
  return n.length > 11 ? n.slice(0, 10) + '…' : n;
}
