import { NextRequest, NextResponse } from 'next/server';
import { buildXlsx } from '@/lib/xlsx';

export const dynamic = 'force-dynamic';

const SHEET_HEADERS = [
  'ฉาก',
  'ลำดับ',
  'รหัสตัวละคร',
  'ชื่อตัวละคร',
  'บทพูด',
  'อารมณ์',
  'ความเร็วพูด'
];

/**
 * Writes the current project out as a spreadsheet so a script can be edited
 * outside the app and imported back. Backgrounds and face tags stay in the
 * app — they need the tagging canvas — so the sheet carries structure only.
 */
export async function POST(req: NextRequest) {
  try {
    const { rows, characters, projectTitle } = await req.json();

    const scriptRows: (string | number)[][] = [SHEET_HEADERS];
    for (const r of Array.isArray(rows) ? rows : []) {
      scriptRows.push([
        r.scene ?? '',
        r.order ?? '',
        r.characterCode ?? '',
        r.characterName ?? '',
        r.script ?? '',
        r.emotion ?? '',
        r.speed ?? 1
      ]);
    }

    // A reference sheet so the exact codes are at hand while editing
    const charRows: (string | number)[][] = [['รหัสตัวละคร', 'ชื่อตัวละคร']];
    for (const c of Array.isArray(characters) ? characters : []) {
      charRows.push([c.code ?? '', c.name ?? '']);
    }

    const buffer = await buildXlsx([
      { name: 'บทสนทนา', rows: scriptRows, widths: [18, 8, 16, 20, 60, 16, 12] },
      { name: 'ตัวละครในคลัง', rows: charRows, widths: [16, 24] }
    ]);

    // Keep letters/digits from any script (Thai titles are normal here) and drop the rest
    const safeTitle = String(projectTitle || 'kruth-dialogue').replace(/[\\/:*?"<>|\s]+/g, '_');
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle)}.xlsx`
      }
    });
  } catch (error: any) {
    console.error('[Dialogue Sheet Export]', error);
    return NextResponse.json(
      { success: false, error: error.message || 'สร้างไฟล์ Excel ไม่สำเร็จ' },
      { status: 500 }
    );
  }
}
