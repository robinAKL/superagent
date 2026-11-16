import { toBuffer } from '@office-kit/xlsx/node';
import { createZipWriter } from '@office-kit/xlsx/zip';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';

const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRel = 'http://schemas.openxmlformats.org/package/2006/relationships';

async function macroWorkbook() {
  const archive = createZipWriter(toBuffer());
  const parts = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>`,
    '_rels/.rels': `<Relationships xmlns="${packageRel}">
      <Relationship Id="rId1" Type="${officeRel}/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${spreadsheet}" xmlns:r="${officeRel}"><sheets>
      <sheet name="Orders" sheetId="1" r:id="rId1"/>
      <sheet name="Wholesale" sheetId="2" r:id="rId2"/>
    </sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${packageRel}">
      <Relationship Id="rId1" Type="${officeRel}/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="${officeRel}/worksheet" Target="worksheets/sheet2.xml"/>
      <Relationship Id="rId3" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>
    </Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${spreadsheet}"><sheetData>
      <row r="3"><c r="B3" t="inlineStr"><is><t>Order BRAVO-903</t></is></c><c r="D3"><f>21*2</f><v>42</v></c></row>
    </sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${spreadsheet}"><sheetData>
      <row r="9"><c r="A9" t="inlineStr"><is><t>Wholesale pricing</t></is></c></row>
    </sheetData></worksheet>`,
    'xl/vbaProject.bin': 'test fixture macro payload',
  };
  for (const [path, contents] of Object.entries(parts)) await archive.addEntry(path, Buffer.from(contents));
  return Buffer.from(await archive.finalize()).toString('base64');
}

it('uploads and searches an XLSM with saved cell values and original sheet and row references', async () => {
  const app = await buildApp({
    auth: { mode: 'dev', platformTenantId: 'workbook-test' },
    knowledgeDeps: { repo: new MemoryKnowledgeRepository() },
  });
  const headers = { 'x-dev-user': 'alice|owner|' };
  const root = '/api/v1/knowledge';
  try {
    const upload = await app.inject({ method: 'POST', url: `${root}/local-materials`, headers, payload: { name: 'Orders.XLSM', base64: await macroWorkbook() } });
    expect(upload.statusCode, upload.body).toBe(200);
    expect(upload.json()).toEqual({ status: 'ready' });

    const results = await app.inject({ url: `${root}/search?q=BRAVO-903`, headers });
    expect(results.json().hits).toEqual([expect.objectContaining({
      quote: expect.stringContaining('B: Order BRAVO-903\tD: 42'),
      locator: "Orders.XLSM#'Orders'!3:3",
    })]);
    const secondSheet = await app.inject({ url: `${root}/search?q=pricing`, headers });
    expect(secondSheet.json().hits[0].locator).toBe("Orders.XLSM#'Wholesale'!9:9");
    const macroPayload = await app.inject({ url: `${root}/search?q=fixture%20macro`, headers });
    expect(macroPayload.json().hits).toEqual([]);

    const corrupt = await app.inject({ method: 'POST', url: `${root}/local-materials`, headers, payload: { name: 'Orders.XLSM', base64: Buffer.from('not a workbook').toString('base64') } });
    expect(corrupt.statusCode).toBe(422);
    expect(corrupt.json().error).toBe('workbook_unreadable');
    const existing = await app.inject({ url: `${root}/search?q=BRAVO-903`, headers });
    expect(existing.json().hits).toHaveLength(1);
  } finally {
    await app.close();
  }
});
