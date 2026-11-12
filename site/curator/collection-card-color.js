// Hue anchors select a fixed background dark enough for the card's white text.
const palette = [
  { hue: 2, color: '#8b3c46' },
  { hue: 25, color: '#8d4e34' },
  { hue: 52, color: '#78591f' },
  { hue: 118, color: '#426338' },
  { hue: 168, color: '#28655d' },
  { hue: 196, color: '#30647b' },
  { hue: 224, color: '#394d87' },
  { hue: 262, color: '#654b87' },
];

export const coverColorPattern = /^#[a-f\d]{6}$/iu;
export const neutralCoverColor = '#3e4962';

export function pickCollectionCardColor(pixels, width) {
  const scores = palette.map(() => 0);
  const count = pixels.length / 4;
  const height = count / width;
  let total = 0;
  let visible = 0;
  let lightness = 0;

  for (let pixel = 0; pixel < count; pixel++) {
    const offset = pixel * 4;
    const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
    const alpha = pixels[offset + 3] / 255;
    const brightest = Math.max(red, green, blue);
    const chroma = brightest - Math.min(red, green, blue);
    if (alpha < .5) continue;
    visible += alpha;
    lightness += (red * .2126 + green * .7152 + blue * .0722) * alpha;
    if (brightest < 36 || chroma < 16) continue;

    let hue = (red === brightest) ? (green - blue) / chroma
      : (green === brightest) ? 2 + (blue - red) / chroma
        : 4 + (red - green) / chroma;
    hue = (hue * 60 + 360) % 360;
    let nearest = 0;
    let bestDistance = Infinity;
    for (const [index, swatch] of palette.entries()) {
      const distance = Math.abs(hue - swatch.hue);
      const circularDistance = Math.min(distance, 360 - distance);
      if (circularDistance < bestDistance) {
        bestDistance = circularDistance;
        nearest = index;
      }
    }
    // The lower edge meets the gradient. Keep the rest of the cover in the vote.
    const verticalPosition = Math.floor(pixel / width) / height;
    const weight = chroma / 255 * alpha * (1 + .5 * verticalPosition);
    scores[nearest] += weight;
    total += weight;
  }

  if (!visible) return null;
  // White page backgrounds should not drown out the few colored parts of a diagram.
  if (total <= visible * .003) return lightness / visible >= 128 ? '#635441' : neutralCoverColor;
  return palette[scores.indexOf(Math.max(...scores))].color;
}

const colorsBySource = new Map();

export function collectionCardColorFromImage(image) {
  if (!image.naturalWidth) return null;
  const doc = image.ownerDocument;
  const source = new URL(image.currentSrc || image.src, doc.baseURI);
  const local = source.origin === doc.location.origin;
  if (!local && source.protocol !== 'data:' && image.crossOrigin !== 'anonymous') return null;
  const cacheable = source.protocol !== 'data:';
  if (cacheable && colorsBySource.has(source.href)) return colorsBySource.get(source.href);

  const sample = doc.createElement('canvas');
  sample.width = sample.height = 32;
  const context = sample.getContext('2d');
  let color = null;
  if (context) {
    try {
      context.drawImage(image, 0, 0, sample.width, sample.height);
      color = pickCollectionCardColor(context.getImageData(0, 0, sample.width, sample.height).data, sample.width);
    } catch {
      // Redirects can leave a loaded image readable by the browser but unavailable to Canvas.
    }
  }
  if (cacheable) {
    if (colorsBySource.size >= 128) colorsBySource.delete(colorsBySource.keys().next().value);
    colorsBySource.set(source.href, color);
  }
  return color;
}
