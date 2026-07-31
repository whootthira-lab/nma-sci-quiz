import { NextRequest, NextResponse } from 'next/server';
import { parseXlsx } from '@/lib/xlsx';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// Header synonyms, so a sheet still imports if a column was renamed slightly
const FIELD_ALIASES: Record<string, string[]> = {
  scene: ['ฉาก', 'scene'],
  order: ['ลำดับ', 'order', 'no', 'ลําดับ'],
  characterCode: ['รหัสตัวละคร', 'code', 'character code', 'รหัส'],
  characterName: ['ชื่อตัวละคร', 'name', 'character', 'ตัวละคร'],
  script: ['บทพูด', 'script', 'dialogue', 'บท'],
  emotion: ['อารมณ์', 'emotion'],
  speed: ['ความเร็วพูด', 'speed', 'ความเร็ว']
};

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** Turns an uploaded sheet into plain rows. Matching names to the character library
 *  happens on the client, which already knows the library. */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file || file.size === 0) {
      return NextResponse.json({ success: false, error: 'ไม่พบไฟล์ที่อัปโหลด' }, { status: 400 });
    }

    const grid = await parseXlsx(Buffer.from(await file.arrayBuffer()));
    if (grid.length < 2) {
      return NextResponse.json(
        { success: false, error: 'ไฟล์ไม่มีข้อมูล (ต้องมีหัวตารางและอย่างน้อย 1 แถว)' },
        { status: 400 }
      );
    }

    // Locate the header row: the first row that names at least a scene and a script
    let headerRow = -1;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const cells = (grid[i] || []).map((c) => normalise(c || ''));
      const hasScene = cells.some((c) => FIELD_ALIASES.scene.some((a) => normalise(a) === c));
      const hasScript = cells.some((c) => FIELD_ALIASES.script.some((a) => normalise(a) === c));
      if (hasScene && hasScript) {
        headerRow = i;
        break;
      }
    }
    if (headerRow === -1) {
      return NextResponse.json(
        {
          success: false,
          error: 'ไม่พบหัวตารางที่ต้องการ — ต้องมีคอลัมน์ "ฉาก" และ "บทพูด" (แนะนำให้เริ่มจากไฟล์ที่ Export จากระบบ)'
        },
        { status: 400 }
      );
    }

    const header = (grid[headerRow] || []).map((c) => normalise(c || ''));
    const colOf = (field: string) =>
      header.findIndex((c) => FIELD_ALIASES[field].some((a) => normalise(a) === c));
    const idx = {
      scene: colOf('scene'),
      order: colOf('order'),
      characterCode: colOf('characterCode'),
      characterName: colOf('characterName'),
      script: colOf('script'),
      emotion: colOf('emotion'),
      speed: colOf('speed')
    };

    const rows = [];
    for (let r = headerRow + 1; r < grid.length; r++) {
      const raw = grid[r] || [];
      const cell = (i: number) => (i >= 0 ? (raw[i] || '').trim() : '');
      const scene = cell(idx.scene);
      const script = cell(idx.script);
      const characterCode = cell(idx.characterCode);
      const characterName = cell(idx.characterName);
      // Skip blank spacer rows
      if (!scene && !script && !characterCode && !characterName) continue;

      const speedRaw = cell(idx.speed);
      const speed = speedRaw ? parseFloat(speedRaw) : 1;
      rows.push({
        rowNumber: r + 1,
        scene,
        order: cell(idx.order),
        characterCode,
        characterName,
        script,
        emotion: cell(idx.emotion),
        speed: Number.isFinite(speed) && speed > 0 ? speed : 1
      });
    }

    return NextResponse.json({ success: true, rows });
  } catch (error: any) {
    console.error('[Dialogue Sheet Import]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'อ่านไฟล์ Excel ไม่สำเร็จ' },
      { status: 500 }
    );
  }
}
