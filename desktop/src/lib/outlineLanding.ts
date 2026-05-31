import type { ChatMessage } from '../types/store';
import { type OutlineLandingTargetFile, OUTLINE_LANDING_TARGETS } from '../components/ChatMessageBubble';

export const OUTLINE_LANDING_TARGET_LABELS = new Map(
    OUTLINE_LANDING_TARGETS.map((target) => [target.fileName, target.label])
);

export function excerptOutlineAssistantMessage(message: ChatMessage, limit = 4200): string {
    const text = String(message.text || '').replace(/\r\n/g, '\n').trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit).trim()}\n\n【已截断：仅提交前 ${limit} 字作为落档依据】`;
}

export function buildOutlineLandingIntent(message: ChatMessage, targetFile: OutlineLandingTargetFile): string {
    const targetLabel = OUTLINE_LANDING_TARGET_LABELS.get(targetFile) || targetFile;
    const excerpt = excerptOutlineAssistantMessage(message);
    return `【大纲落档按钮请求】

这是作者在前端点击「落档」按钮触发的明确写入请求，不是继续发散讨论。
请进入大纲归档链路，把下方这条大纲助手回复中已经成熟、可沉淀、适合进入目标文件的内容，整理成可审阅的 draft/sandbox 草稿。

目标文件：${targetFile}
目标层级：${targetLabel}

必须遵守：
1. 只允许写入 ${targetFile}，不要写入 brainstorm.md、master_outline.md、arc_outline.md、chapter_outline.md 中未被指定的其他文件。
2. 禁止写入 chapter_draft.md、summary.md、world_model.md、status_card.md、style 文件、error_archive.md 或 domain_rules.md。
3. 写入前必须读取 ${targetFile} 的 markdown outline，取得 section_path 和 base_etag。
4. 必须使用 draft_replace_markdown_section 或 draft_append_markdown_section 生成可审阅草稿。
5. origin 必须是 explicit_user_write。
6. 如果这条回复不足以落档，请说明缺少什么，不要硬写空模板。
7. 完成后只汇报更新了哪个大纲文件、承载了什么生产决定，以及是否需要作者进入审阅工作台确认。

需要落档的大纲助手回复如下：

${excerpt}`;
}
