import type { BotContext } from "../../types";
import type { SkillModule } from "../_types";
import { config } from "./config";
import { sendMessage } from "../../feishu";

const VALID_COLORS = new Set([
  "blue", "green", "red", "yellow", "orange",
  "purple", "indigo", "wathet", "turquoise", "carmine", "violet",
]);

type CardButton = {
  label: string;
  value: string;
  type?: "primary" | "default" | "danger";
};

type SendCardArgs = {
  title:    string;
  content:  string;
  color?:   string;
  buttons?: CardButton[];
};

export const sendCardSkill: SkillModule<SendCardArgs> = {
  config,
  run: async (ctx: BotContext, args: SendCardArgs) => {
    const { title, content, color, buttons } = args;
    const template = color && VALID_COLORS.has(color) ? color : "blue";

    // Session key is deterministic — same formula as agent/index.ts sessionKey().
    // Embedded in button values so the card-action webhook can resume the session.
    const sessionKey = `${ctx.trigger.chatId}:${ctx.trigger.senderId}`;

    const elements: object[] = [{ tag: "markdown", content }];

    if (buttons?.length) {
      elements.push({
        tag: "action",
        actions: buttons.map(btn => ({
          tag:  "button",
          text: { tag: "plain_text", content: btn.label },
          type: btn.type ?? "default",
          value: {
            session_key:   sessionKey,
            button_value:  btn.value,
            button_label:  btn.label,
          },
        })),
      });
    }

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title:    { tag: "plain_text", content: title },
        template,
      },
      elements,
    };

    const receiveId     = ctx.trigger.chatType === "p2p" ? ctx.trigger.senderId : ctx.trigger.chatId;
    const receiveIdType = ctx.trigger.chatType === "p2p" ? "open_id" : "chat_id";

    await sendMessage(receiveId, receiveIdType, "interactive", JSON.stringify(card));
  },
};
