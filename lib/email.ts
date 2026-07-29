import { Resend } from "resend";

const FROM = "Click-In <noreply@clickinmusical.com>";

function client(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  return new Resend(key);
}

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const { error } = await client().emails.send({
    from: FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    ...(params.replyTo ? { reply_to: params.replyTo } : {}),
    ...(params.headers ? { headers: params.headers } : {}),
  });
  if (error) throw new Error(`[email] send failed: ${error.message}`);
}
