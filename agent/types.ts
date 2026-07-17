export type AgentResponse = {
  skill: string;
  args: unknown;
  reason: string;
  done: boolean;
  wait_reply?: boolean;
};

export type TaskAnchor = {
  type: "creative_discussion" | "event_query" | "data_update" | "unknown";
  subject: string;
  goal: string;
  description: string;
};

export type HistoryMessage = {
  messageId: string;
  senderId: string;
  senderName: string;
  senderType: "user" | "app";
  type: "text" | "card" | "other";
  text?: string;
  cardTitle?: string;
  timestamp: number; // unix ms
};

export type BotContext = {
  trigger: {
    messageId: string;
    chatId: string;
    chatType: "p2p" | "group";
    senderId: string;
    senderName: string;
    text: string;    // @bot mention stripped
    rawText: string;
    timestamp: number;
    mentionedBot?: boolean;
  };
  chat: {
    name: string;
    memberCount?: number;
  };
  history: HistoryMessage[];
  productionContext?: {
    productionId: string;
    productionName: string;
  };
  taskAnchor?: TaskAnchor;
};
