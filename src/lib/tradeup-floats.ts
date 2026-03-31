export const WEAR_FLOAT_RANGES: Record<string, [number, number]> = {
  'Factory New': [0.00, 0.07],
  'Minimal Wear': [0.07, 0.15],
  'Field-Tested': [0.15, 0.38],
  'Well-Worn': [0.38, 0.45],
  'Battle-Scarred': [0.45, 1.00],
};

export const WEAR_ORDER = [
  'Factory New',
  'Minimal Wear',
  'Field-Tested',
  'Well-Worn',
  'Battle-Scarred',
];

export function estimateFloat(wearName: string, skinMinFloat: number, skinMaxFloat: number): number {
  const range = WEAR_FLOAT_RANGES[wearName];
  if (!range) return (skinMinFloat + skinMaxFloat) / 2;

  const clampedMin = Math.max(range[0], skinMinFloat);
  const clampedMax = Math.min(range[1], skinMaxFloat);
  if (clampedMin > clampedMax) {
    return clampFloatToRange((skinMinFloat + skinMaxFloat) / 2, skinMinFloat, skinMaxFloat);
  }
  return (clampedMin + clampedMax) / 2;
}

export function estimateFloatForWearAlignment(
  wearName: string,
  skinMinFloat: number,
  skinMaxFloat: number
): number {
  const range = WEAR_FLOAT_RANGES[wearName];
  if (!range) return clampFloatToRange((skinMinFloat + skinMaxFloat) / 2, skinMinFloat, skinMaxFloat);

  const clampedMin = Math.max(range[0], skinMinFloat);
  const clampedMax = Math.min(range[1], skinMaxFloat);
  if (clampedMin <= clampedMax) {
    return (clampedMin + clampedMax) / 2;
  }

  if (skinMaxFloat < range[0]) {
    return skinMaxFloat;
  }

  return skinMinFloat;
}

export function calculateTFloat(actualFloat: number, minFloat: number, maxFloat: number): number {
  if (maxFloat <= minFloat) return 0;
  return (actualFloat - minFloat) / (maxFloat - minFloat);
}

export function calculateOutputFloat(avgTFloat: number, outMinFloat: number, outMaxFloat: number): number {
  return avgTFloat * (outMaxFloat - outMinFloat) + outMinFloat;
}

export function floatToWear(value: number): string {
  if (value < 0.07) return 'Factory New';
  if (value < 0.15) return 'Minimal Wear';
  if (value < 0.38) return 'Field-Tested';
  if (value < 0.45) return 'Well-Worn';
  return 'Battle-Scarred';
}

export function getWearOrderIndex(wearName: string): number {
  return WEAR_ORDER.indexOf(wearName);
}

function clampFloatToRange(value: number, minFloat: number, maxFloat: number): number {
  return Math.min(Math.max(value, minFloat), maxFloat);
}
