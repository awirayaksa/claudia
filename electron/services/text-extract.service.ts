/**
 * Text extraction for chat attachments (desktop, main process).
 *
 * The renderer sends the file bytes; this returns plain text that is inlined
 * into the user message, so non-image attachments actually reach the model.
 */
import {
  detectDocumentFormat,
  documentToText,
  inProcessExtractor,
  type DocumentFormat,
} from './builtin-mcp/document-extractor';

/** Largest input accepted, matching the chat input's drop limit. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Extracted text beyond this is cut off (roughly 50k tokens). */
export const MAX_EXTRACTED_CHARS = 200_000;

export interface ExtractTextRequest {
  name: string;
  mimeType?: string;
  data: Uint8Array;
}

export interface ExtractTextResult {
  text: string;
  truncated: boolean;
  format: DocumentFormat;
}

export class UnsupportedAttachmentError extends Error {
  constructor(name: string) {
    super(`Can't read text from "${name}". Supported: PDF, DOCX, XLSX, PPTX and text files.`);
    this.name = 'UnsupportedAttachmentError';
  }
}

const extractor = inProcessExtractor();

export async function extractText(
  req: ExtractTextRequest,
  maxChars = MAX_EXTRACTED_CHARS
): Promise<ExtractTextResult> {
  if (req.data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`"${req.name}" is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`);
  }
  const format = detectDocumentFormat(req.name, req.mimeType);
  if (!format) {
    throw new UnsupportedAttachmentError(req.name);
  }

  const buffer = Buffer.from(req.data.buffer, req.data.byteOffset, req.data.byteLength);
  const raw = (await documentToText(extractor, buffer, format)).trim();
  const truncated = raw.length > maxChars;
  return { text: truncated ? raw.slice(0, maxChars) : raw, truncated, format };
}
