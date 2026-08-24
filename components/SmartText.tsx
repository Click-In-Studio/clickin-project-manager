"use client";

// SmartText —— 已退役的手写正则渲染器，现在是统一渲染器的行内变体的薄转发层。
//
// 历史：它诞生在「文档」概念成型之前，自带一套 [#kind:id] token 解析、@提及
// 正则、以及调用方传进来的 InlinePlugin 表。结果是全站有两个渲染器、两套引用
// 形态、两种能力（它不认 markdown / callout / 分栏 / 图片，WikiMarkdown 不认
// @提及 hover 头像卡）。方言 v2 统一后两套形态合一，渲染器也随之合一：
//   · 解析 = react-markdown 那条唯一管线
//   · 行内宿主（表格单元格 / <dd> / 卡片副标题）由 inline 变体承接
//   · hover 头像卡已搬进 WikiMarkdown（合并取强者）
//
// 保留本文件只为不把十几处调用点的改动混进同一个 diff；调用点收干净后即可删除。
import WikiMarkdown, { type MentionMember } from "@/components/wiki/WikiMarkdown";

export type { MentionMember };

export default function SmartText({
  content,
  memberMention,
  contentMention,
  className,
  productionId: legacyProductionId,
  versionId: legacyVersionId,
}: {
  content: string;
  memberMention?: { members: MentionMember[] };
  contentMention?: { productionId: string; versionId?: string | null };
  className?: string;
  productionId?: string;
  versionId?: string | null;
}) {
  if (!content) return null;
  return (
    <WikiMarkdown
      content={content}
      productionId={contentMention?.productionId ?? legacyProductionId}
      versionId={contentMention?.versionId ?? legacyVersionId}
      members={memberMention?.members ?? []}
      inline
      className={className}
    />
  );
}
