import JSZip from 'jszip';

/**
 * Minimal .xlsx reader/writer built on JSZip, which the project already ships.
 * Full spreadsheet libraries pull in a large dependency tree; we only need a
 * grid of text in and out, and we control the sheet we hand to the user.
 */

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Excel rejects most control characters outright
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

const unescapeXml = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');

export const columnName = (index: number): string => {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

const columnIndex = (ref: string): number => {
  const letters = ref.replace(/[0-9]/g, '');
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
};

export interface SheetSpec {
  name: string;
  rows: (string | number | null | undefined)[][];
  /** Column widths in characters; index-aligned with the columns. */
  widths?: number[];
}

const sheetXml = (sheet: SheetSpec): string => {
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';

  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null || value === undefined || value === '') return '';
          const ref = `${columnName(c)}${r + 1}`;
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          // Inline strings keep everything in one part — no sharedStrings table to maintain
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`;
};

export async function buildXlsx(sheets: SheetSpec[]): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join('')}
</Types>`
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );

  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets
      .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets>
</workbook>`
  );

  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join('')}
</Relationships>`
  );

  sheets.forEach((sheet, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet));
  });

  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Reads the first worksheet of an .xlsx into a grid of trimmed strings. */
export async function parseXlsx(data: Buffer | ArrayBuffer): Promise<string[][]> {
  const zip = await JSZip.loadAsync(data);

  // Shared strings are optional — files written with inline strings have none
  const shared: string[] = [];
  const sharedFile = zip.file('xl/sharedStrings.xml');
  if (sharedFile) {
    const xml = await sharedFile.async('string');
    const items = xml.match(/<si>[\s\S]*?<\/si>/g) || [];
    for (const si of items) {
      // A string can be split across several runs; concatenate every <t>
      const parts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
      shared.push(
        parts
          .map((p) => unescapeXml(p.replace(/<t[^>]*>/, '').replace(/<\/t>/, '')))
          .join('')
      );
    }
  }

  // Resolve the first sheet through the workbook relationships
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = zip.file('xl/workbook.xml');
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const wbXml = await workbook.async('string');
    const relsXml = await rels.async('string');
    const firstSheet = wbXml.match(/<sheet[^>]*r:id="([^"]+)"[^>]*\/>/);
    if (firstSheet) {
      const rel = relsXml.match(new RegExp(`<Relationship[^>]*Id="${firstSheet[1]}"[^>]*Target="([^"]+)"`));
      if (rel) {
        const target = rel[1].replace(/^\//, '').replace(/^xl\//, '');
        sheetPath = `xl/${target}`;
      }
    }
  }

  const sheetFile = zip.file(sheetPath) || zip.file('xl/worksheets/sheet1.xml');
  if (!sheetFile) throw new Error('ไม่พบแผ่นงานในไฟล์ Excel');
  const sheetXmlText = await sheetFile.async('string');

  const grid: string[][] = [];
  const rowMatches = sheetXmlText.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
  for (const rowXml of rowMatches) {
    const rowNum = parseInt((rowXml.match(/<row[^>]*r="(\d+)"/) || [])[1] || '0', 10);
    const cells = rowXml.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || [];
    const row: string[] = [];
    for (const cellXml of cells) {
      const ref = (cellXml.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (cellXml.match(/t="([^"]+)"/) || [])[1];
      let text = '';
      if (type === 'inlineStr') {
        const parts = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
        text = parts.map((p) => unescapeXml(p.replace(/<t[^>]*>/, '').replace(/<\/t>/, ''))).join('');
      } else {
        const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        if (v) {
          text = type === 's' ? shared[parseInt(v[1], 10)] ?? '' : unescapeXml(v[1]);
        }
      }
      const idx = ref ? columnIndex(ref) : row.length;
      row[idx] = (text || '').trim();
    }
    const target = rowNum > 0 ? rowNum - 1 : grid.length;
    grid[target] = row;
  }

  // Fill holes left by skipped rows/columns so callers can index safely
  for (let r = 0; r < grid.length; r++) {
    if (!grid[r]) grid[r] = [];
    for (let c = 0; c < grid[r].length; c++) if (grid[r][c] === undefined) grid[r][c] = '';
  }
  return grid;
}
