export interface TextAttachment {
  id: string;
  name: string;
  size: number;
  content: string;
}

export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;

const BLOCKED_DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);
const BLOCKED_DOCUMENT_MIME_PARTS = ["pdf", "msword", "wordprocessingml"];

const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".fish",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".log",
  ".lua",
  ".markdown",
  ".md",
  ".mjs",
  ".ndjson",
  ".php",
  ".pl",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".text",
  ".toml",
  ".ts",
  ".tsx",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/xml",
  "application/x-ndjson",
  "application/x-yaml",
  "application/yaml",
  "image/svg+xml",
]);

export const ATTACHMENT_ACCEPT = [
  ...TEXT_EXTENSIONS,
  ".dockerfile",
  ".gitignore",
  ".pdf",
  ".doc",
  ".docx",
  "text/*",
  ...TEXT_MIME_TYPES,
].join(",");

export function isBlockedDocumentFile(file: File): boolean {
  const ext = extensionOf(file.name);
  const mime = file.type.toLowerCase();
  return BLOCKED_DOCUMENT_EXTENSIONS.has(ext) || BLOCKED_DOCUMENT_MIME_PARTS.some((part) => mime.includes(part));
}

export function isSupportedTextFile(file: File): boolean {
  const name = file.name.toLowerCase();
  const ext = extensionOf(name);
  const mime = file.type.toLowerCase();
  return (
    mime.startsWith("text/") ||
    TEXT_MIME_TYPES.has(mime) ||
    TEXT_EXTENSIONS.has(ext) ||
    name === "dockerfile" ||
    name === "makefile" ||
    name === ".gitignore" ||
    name.startsWith(".env")
  );
}

export async function textAttachmentFromFile(file: File): Promise<TextAttachment> {
  return {
    id: `${file.name || "attachment"}-${file.lastModified}-${file.size}-${Math.random().toString(36).slice(2)}`,
    name: file.name || "attachment.txt",
    size: file.size,
    content: await file.text(),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
}
