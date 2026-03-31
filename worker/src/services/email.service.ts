/**
 * Email service — uses Resend (https://resend.com) for transactional email.
 * Set RESEND_API_KEY as a wrangler secret to enable. Falls back to console log in dev.
 */

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
}

function formatTranscript(history: TranscriptEntry[], storeName: string): string {
  const lines = history.map(h =>
    `${h.role === 'user' ? 'You' : 'Avery'}: ${h.content}`
  );
  return `Your ${storeName} Voice Session Transcript\n${'─'.repeat(50)}\n\n${lines.join('\n\n')}\n\n${'─'.repeat(50)}\nThank you for choosing ${storeName}!`;
}

function formatHtml(history: TranscriptEntry[], storeName: string): string {
  const rows = history.map(h => {
    const isUser = h.role === 'user';
    const color = isUser ? '#1a1a2e' : '#6c47ff';
    const label = isUser ? 'You' : 'Avery';
    return `<tr>
      <td style="padding:8px 0">
        <span style="font-weight:700;color:${color}">${label}:</span>
        <span style="margin-left:8px">${h.content}</span>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;color:#222">
  <h2 style="color:#6c47ff">${storeName} — Voice Session Transcript</h2>
  <table style="width:100%;border-collapse:collapse">${rows}</table>
  <p style="margin-top:24px;color:#888;font-size:13px">Thank you for choosing ${storeName}!</p>
</body>
</html>`;
}

export async function emailTranscript(
  to: string,
  history: TranscriptEntry[],
  businessType: string,
  apiKey?: string,
  fromEmail?: string,
  storeName?: string,
): Promise<void> {
  const name = storeName ?? businessType;
  const from = fromEmail ?? `Avery <avery@avery.ai>`;

  if (!apiKey || apiKey === 'CHANGE_ME') {
    console.log(`\n[EMAIL] Would send transcript to ${to}:\n${formatTranscript(history, name)}\n`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Your ${name} session recap`,
      text: formatTranscript(history, name),
      html: formatHtml(history, name),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
}
