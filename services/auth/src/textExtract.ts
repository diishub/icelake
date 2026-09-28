/**
 * Plain-text extraction for a steward's .pdf/.docx upload, so a platform-team
 * reviewer has something to read before approving one (there are no columns
 * to classify the way a .csv has). Never stores anything itself -- the
 * caller (server.ts) stages the result in RustFS beside the original file,
 * the same "log access, not data" boundary the rest of the identity schema
 * keeps (config/platform/018-upload-text-extraction.sql).
 *
 * A failure here (a corrupt or unusually-encoded file) is not fatal to the
 * upload: the caller still stages the original file and records the upload,
 * just with no extracted text -- the reviewer inspects the original
 * directly in that case, rather than the whole upload being refused over a
 * best-effort convenience feature.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import { extractRawText } from 'mammoth';

export type ExtractableFileKind = 'pdf' | 'docx';

export async function extractPlainText(
  fileKind: ExtractableFileKind,
  buffer: Buffer,
): Promise<string | null> {
  try {
    if (fileKind === 'pdf') {
      const document = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(document, { mergePages: true });
      return text;
    }
    const result = await extractRawText({ buffer });
    return result.value;
  } catch (error) {
    console.error(`[auth] text extraction failed for a .${fileKind} upload`, error);
    return null;
  }
}
