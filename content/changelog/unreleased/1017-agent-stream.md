---
kind: fixed
title: AI 回复过程不再偶发重复显示
page: ai/assistant/chat
pr: 1017
order: 1
---

修复 AI 回复过程中偶发出现两份文字、工具调用和确认卡的问题，无需等本轮结束后刷新历史才恢复正常。切换会话后，旧连接不会再更新当前对话。
