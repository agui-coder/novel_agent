import { compactList, compactBriefText } from './textCompact';
import type { RollingAuthorWritingBrief } from '../api/orchestration';

export function buildRollingBriefLines(brief?: RollingAuthorWritingBrief): string[] {
    if (!brief) return [];
    const cards = brief.chapter_cards || [];
    const firstCard = cards[0];
    const sourceNames = (brief.truth_sources || [])
        .filter((source) => source.exists)
        .map((source) => source.name)
        .slice(0, 5);
    const lines = [
        `写作依据：本轮 ${compactList(brief.batch?.selected_card_numbers)}，目标文件 ${brief.target_file}`,
        `进度游标：已归档 ${compactList(brief.progress_cursor?.accepted_chapter_numbers)}；待审 ${compactList(brief.progress_cursor?.pending_review_chapter_numbers)}`,
    ];
    if (firstCard) {
        lines.push(`首章卡：CH${firstCard.number} ${compactBriefText(firstCard.title, 34)}｜目标：${compactBriefText(firstCard.goal)}`);
        lines.push(`冲突/兑现：${compactBriefText(firstCard.conflict)} → ${compactBriefText(firstCard.payoff)}`);
    }
    if (cards.length > 1) {
        lines.push(`其余章节卡：${cards.slice(1).map((card) => `CH${card.number}`).join(', ')}`);
    }
    if (sourceNames.length > 0) {
        lines.push(`读取依据：${sourceNames.join(', ')}`);
    }
    if (brief.quality_and_style?.style_advisory_active) {
        lines.push('文风：作为模仿提示，不作为卡死调度闸门。');
    }
    lines.push('边界：工作台不写正文，只有 continuation Agent 可写 chapter_draft.md。');
    return lines;
}
