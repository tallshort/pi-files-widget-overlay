import type { CommentPayload } from "./viewer";

export function formatCommentMessage(payload: CommentPayload, comment: string): string {
  const subject = payload.isDiff ? `In the diff for \`${payload.relPath}\`` : `In \`${payload.relPath}\``;
  return `${subject} (${payload.lineRange}):\n\`\`\`${payload.ext}\n${payload.selectedText}\n\`\`\`\n\nComment: ${comment}\n`;
}
