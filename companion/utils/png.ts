export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 24_000_000;

type DecodedImage = { width: number; height: number; close(): void };
type ImageDecoder = (blob: Blob) => Promise<DecodedImage>;

export async function decodeScreenshot(dataUrl: string,
  decode: ImageDecoder = (blob) => createImageBitmap(blob)):
  Promise<{ dataBase64: string; width: number; height: number }> {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix) || dataUrl.length > prefix.length + Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error('Screenshot is not a PNG or exceeds the 8 MiB image limit.');
  }
  const dataBase64 = dataUrl.slice(prefix.length);
  if (!dataBase64 || dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw new Error('Screenshot encoding is invalid.');
  }
  let raw: string;
  try { raw = atob(dataBase64); } catch { throw new Error('Screenshot encoding is invalid.'); }
  if (raw.length > MAX_IMAGE_BYTES || btoa(raw) !== dataBase64) throw new Error('Screenshot encoding is invalid.');
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  if (bytes.length < 33 || [137, 80, 78, 71, 13, 10, 26, 10].some((byte, i) => bytes[i] !== byte)) {
    throw new Error('Screenshot does not contain a PNG image.');
  }
  const header = new DataView(bytes.buffer);
  if (header.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') {
    throw new Error('Screenshot PNG header is invalid.');
  }
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (!width || !height || width > 32768 || height > 32768 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('Screenshot exceeds the 24 megapixel image limit. Reduce the viewport and capture again.');
  }
  let image: DecodedImage | undefined;
  try {
    image = await decode(new Blob([bytes], { type: 'image/png' }));
    if (image.width !== width || image.height !== height) throw new Error('Mismatched dimensions');
  } catch {
    throw new Error('Screenshot PNG could not be decoded. Capture again.');
  } finally {
    image?.close();
  }
  return { dataBase64, width, height };
}
