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
  };
  chat: {
    name: string;
    memberCount?: number;
  };
  history: HistoryMessage[];
};
