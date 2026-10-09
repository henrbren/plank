import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

// Tillat plank://-lenker gjennom sanitering
const ALLOWED_URI = /^(?:(?:https?|mailto|tel|plank):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: ALLOWED_URI, ADD_ATTR: ["target"] });
}
