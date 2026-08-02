/**
 * Serverless functions cap the request body at ~4.5MB, and a photo straight off a
 * phone is often well past that — the upload then fails with a plain-text 413 that
 * looks like a JSON parse error to the caller. Shrinking the picture in the browser
 * keeps uploads inside the limit; 2048px is already more detail than the image
 * models use.
 */
export async function downscaleImage(
  file: File,
  maxDimension = 2048,
  quality = 0.9
): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    const scale = longest > maxDimension ? maxDimension / longest : 1;

    // Small enough already and not a heavyweight format → leave it untouched
    if (scale === 1 && file.size <= 3.5 * 1024 * 1024) {
      bitmap.close?.();
      return file;
    }

    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();

    // PNG keeps transparency but stays large; only images that need it pay that cost
    const keepPng = file.type === 'image/png' && (await hasTransparency(ctx, targetW, targetH));
    const mime = keepPng ? 'image/png' : 'image/jpeg';

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, mime === 'image/jpeg' ? quality : undefined)
    );
    if (!blob || blob.size >= file.size) return file; // no gain, keep the original

    const base = file.name.replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.${mime === 'image/png' ? 'png' : 'jpg'}`, { type: mime });
  } catch (err) {
    console.warn('[downscaleImage] leaving the original file as is:', err);
    return file;
  }
}

async function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number) {
  try {
    // Sampling the alpha channel is enough to tell a cutout from a photo
    const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (data[(y * w + x) * 4 + 3] < 250) return true;
      }
    }
  } catch {
    return true; // reading pixels can fail on tainted canvases; assume it matters
  }
  return false;
}

/** Human-readable failure for responses that aren't JSON (a 413 body is plain text). */
export async function readJsonOrExplain(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 413 || /too large/i.test(text)) {
      throw new Error('ไฟล์รูปภาพใหญ่เกินกว่าที่เซิร์ฟเวอร์รับได้ กรุณาใช้รูปที่เล็กลง');
    }
    throw new Error(
      `เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (${res.status}) ${text.slice(0, 80)}`
    );
  }
}
