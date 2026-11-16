import { cellValueAsString } from '@office-kit/xlsx/cell';
import { fromBuffer } from '@office-kit/xlsx/node';
import { loadWorkbookStream } from '@office-kit/xlsx/streaming';
import { columnLetterFromIndex, OpenXmlContentLimitError, OpenXmlDecompressionBombError } from '@office-kit/xlsx/utils';
import type { SourceContent } from '@superagent/shared';
import { KnowledgeError } from './domain.js';

const MAX_EXTRACTED_CHARS = 2_000_000;
const MiB = 1024 * 1024;

export async function parseMacroWorkbook(bytes: Buffer, filename: string): Promise<SourceContent> {
  const lines: string[] = [];
  const anchors: SourceContent['anchors'] = [];
  let offset = 0;
  try {
    const workbook = await loadWorkbookStream(fromBuffer(bytes), {
      decompressionLimits: { maxEntryUncompressedBytes: 32 * MiB, maxTotalUncompressedBytes: 64 * MiB },
      contentLimits: { maxRows: 100_000, maxCells: 500_000 },
    });
    try {
      for (const name of workbook.sheetNames) {
        for await (const row of workbook.openWorksheet(name).iterRows()) {
          const values = row.flatMap(cell => {
            const value = cellValueAsString(cell.value).replace(/[\x00-\x1f]+/g, ' ').trim();
            return value ? [`${columnLetterFromIndex(cell.col)}: ${value}`] : [];
          });
          if (!values.length) continue;
          const rowNumber = row[0]!.row;
          const reference = `'${name.replaceAll("'", "''")}'!${rowNumber}:${rowNumber}`;
          const line = `${reference}\t${values.join('\t')}`;
          if (offset + line.length > MAX_EXTRACTED_CHARS) throw new KnowledgeError('text_too_large', '工作簿提取出的内容超过大小限制。', 413);
          anchors.push({ start: offset, end: offset + line.length, locator: `${filename}#${reference}` });
          lines.push(line);
          offset += line.length + 1;
        }
      }
    } finally {
      await workbook.close();
    }
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    if (error instanceof OpenXmlContentLimitError || error instanceof OpenXmlDecompressionBombError) {
      throw new KnowledgeError('text_too_large', '工作簿提取出的内容超过大小限制。', 413);
    }
    throw new KnowledgeError('workbook_unreadable', '无法读取工作簿。请检查文件是否损坏或受密码保护。', 422);
  }
  if (!lines.length) throw new KnowledgeError('unreadable_file', '工作簿中没有可读取的单元格。', 422);
  return { text: lines.join('\n'), anchors };
}
