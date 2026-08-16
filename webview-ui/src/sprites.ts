// Sprite sheet layout for char_N.png:
//   112 × 96 px  →  7 frames × 3 directions (down, up, right)
//   Each frame: 16 × 32 px
//   Left direction is drawn by horizontally flipping the right row.

const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES = 7;

export type Direction = 'down' | 'up' | 'right' | 'left';

const DIR_ROW: Record<Direction, number> = { down: 0, up: 1, right: 2, left: 2 };

const characterImages: HTMLImageElement[] = [];
const furnitureImages: Map<string, HTMLImageElement> = new Map();
let floorImages: HTMLImageElement[] = [];

declare const window: Window & { ASSETS_BASE_URI?: string };

function assetUrl(relativePath: string): string {
  const base = window.ASSETS_BASE_URI ?? 'assets';
  return `${base.replace(/\/$/, '')}/${relativePath}`;
}

let loaded = false;
let loadPromise: Promise<void> | null = null;

export function getSpritesLoaded(): boolean {
  return loaded;
}

export function loadSprites(): Promise<void> {
  if (loadPromise) return loadPromise;

  const promises: Promise<void>[] = [];

  for (let i = 0; i < 6; i++) {
    const img = new Image();
    promises.push(
      new Promise<void>((res) => {
        img.onload = () => res();
        img.onerror = () => res(); // fallback: skip
      }),
    );
    img.src = assetUrl(`characters/char_${i}.png`);
    characterImages.push(img);
  }

  for (let i = 0; i < 3; i++) {
    const img = new Image();
    promises.push(
      new Promise<void>((res) => {
        img.onload = () => res();
        img.onerror = () => res();
      }),
    );
    img.src = assetUrl(`floors/floor_${i}.png`);
    floorImages.push(img);
  }

  const furnitureFiles = [
    ['desk_front', 'furniture/DESK/DESK_FRONT.png'],
    ['desk_side', 'furniture/DESK/DESK_SIDE.png'],
    ['chair_front', 'furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png'],
    ['chair_back', 'furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_BACK.png'],
    ['pc_off', 'furniture/PC/PC_FRONT_OFF.png'],
    ['pc_on_1', 'furniture/PC/PC_FRONT_ON_1.png'],
    ['pc_on_2', 'furniture/PC/PC_FRONT_ON_2.png'],
    ['pc_on_3', 'furniture/PC/PC_FRONT_ON_3.png'],
  ];

  for (const [key, src] of furnitureFiles) {
    const img = new Image();
    promises.push(
      new Promise<void>((res) => {
        img.onload = () => res();
        img.onerror = () => res();
      }),
    );
    img.src = assetUrl(src);
    furnitureImages.set(key, img);
  }

  loadPromise = Promise.all(promises).then(() => {
    loaded = true;
  });
  return loadPromise;
}

export function drawCharacterSprite(
  ctx: CanvasRenderingContext2D,
  paletteIndex: number,
  direction: Direction,
  frame: number,
  destX: number,
  destY: number,
  scale = 1,
): boolean {
  const img = characterImages[paletteIndex % characterImages.length];
  if (!img?.complete || img.naturalWidth === 0) return false;

  const row = DIR_ROW[direction];
  const col = frame % CHAR_FRAMES;
  const srcX = col * CHAR_FRAME_W;
  const srcY = row * CHAR_FRAME_H;

  if (direction === 'left') {
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(
      img,
      srcX, srcY, CHAR_FRAME_W, CHAR_FRAME_H,
      -(destX + CHAR_FRAME_W * scale), destY, CHAR_FRAME_W * scale, CHAR_FRAME_H * scale,
    );
    ctx.restore();
  } else {
    ctx.drawImage(
      img,
      srcX, srcY, CHAR_FRAME_W, CHAR_FRAME_H,
      destX, destY, CHAR_FRAME_W * scale, CHAR_FRAME_H * scale,
    );
  }
  return true;
}

export function drawFloorTile(
  ctx: CanvasRenderingContext2D,
  tileIndex: number,
  destX: number,
  destY: number,
  size = 16,
): boolean {
  const img = floorImages[tileIndex % floorImages.length];
  if (!img?.complete || img.naturalWidth === 0) return false;
  ctx.drawImage(img, destX, destY, size, size);
  return true;
}

export function drawFurniture(
  ctx: CanvasRenderingContext2D,
  key: string,
  destX: number,
  destY: number,
  scale = 1,
): boolean {
  const img = furnitureImages.get(key);
  if (!img?.complete || img.naturalWidth === 0) return false;
  ctx.drawImage(img, destX, destY, img.naturalWidth * scale, img.naturalHeight * scale);
  return true;
}

export function getPcFrame(frame: number, isActive: boolean): string {
  if (!isActive) return 'pc_off';
  return `pc_on_${(frame % 3) + 1}`;
}
