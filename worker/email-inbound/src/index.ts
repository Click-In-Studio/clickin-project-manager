import PostalMime from "postal-mime";

export interface Env {
  NEXT_INBOUND_URL: string;   // https://www.clickinmusical.com/api/email-inbound
  EMAIL_INBOUND_SECRET: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);

    const payload = {
      from: message.from,
      to: message.to,
      subject: parsed.subject ?? "",
      text: parsed.text ?? "",
      html: parsed.html ?? "",
      messageId: message.headers.get("message-id") ?? "",
      inReplyTo: message.headers.get("in-reply-to") ?? null,
      references: message.headers.get("references") ?? null,
    };

    const res = await fetch(env.NEXT_INBOUND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.EMAIL_INBOUND_SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Inbound forward failed: ${res.status}`);
    }
  },
} satisfies ExportedHandler<Env>;
