from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from typing import Any, Callable

from flask import Blueprint, jsonify, request

from pipelines.rolling_chapter import build_chapter_context_pack, build_rolling_plan
from utils.book_storage import get_book_paths


def _coerce_batch_size(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 3
    if parsed <= 0:
        return 3
    return min(parsed, 3)


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _file_state(book_dir: str, file_name: str) -> dict[str, Any]:
    path = os.path.abspath(os.path.join(book_dir, file_name))
    exists = os.path.exists(path)
    is_file = os.path.isfile(path)
    is_dir = os.path.isdir(path)
    return {
        "file_name": file_name,
        "exists": exists,
        "kind": "directory" if is_dir else "file" if is_file else "missing",
        "size": os.path.getsize(path) if is_file else 0,
        "entry_count": len(os.listdir(path)) if is_dir else 0,
    }


def _build_outline_card_states(plan: dict[str, Any]) -> list[dict[str, Any]]:
    written_numbers = set(plan.get("written_chapter_numbers") or [])
    pending_review_numbers = set(plan.get("pending_review_chapter_numbers") or [])
    selected_numbers = set(plan.get("selected_card_numbers") or [])
    blocked_numbers = set(plan.get("blocked_card_numbers") or [])
    pending_numbers = set(plan.get("pending_card_numbers") or [])
    states: list[dict[str, Any]] = []
    for card in plan.get("cards") or []:
        if not isinstance(card, dict):
            continue
        number = card.get("number")
        if number in selected_numbers:
            status = "selected"
        elif number in blocked_numbers:
            status = "blocked"
        elif number in pending_numbers:
            status = "pending"
        elif number in written_numbers:
            status = "written"
        elif number in pending_review_numbers:
            status = "pending_review"
        else:
            status = "ignored"
        states.append(
            {
                "number": number,
                "title": card.get("title") or "",
                "status": status,
                "executable": bool(card.get("executable")),
                "missing_fields": card.get("missing_fields") or [],
                "heading_line": card.get("heading_line") or 0,
                "end_line": card.get("end_line") or 0,
            }
        )
    return states


def _build_outline_diagnostics(plan: dict[str, Any], book_dir: str) -> dict[str, Any]:
    outline_state = _file_state(book_dir, "chapter_outline.md")
    outline_card_count = int(plan.get("outline_card_count") or 0)
    executable_card_count = int(plan.get("executable_card_count") or 0)
    detected_but_unparsed = bool(outline_state["exists"] and outline_state["size"] > 0 and outline_card_count == 0)
    return {
        "outline_card_count": outline_card_count,
        "executable_card_count": executable_card_count,
        "detected_but_unparsed": detected_but_unparsed,
        "message": (
            "chapter_outline.md 有内容，但没有识别到可滚动的章节卡；请检查标题或字段格式。"
            if detected_but_unparsed
            else ""
        ),
    }


def _build_workbench_state(plan: dict[str, Any], book_dir: str) -> dict[str, Any]:
    return {
        "status": "ready",
        "requiresPrompt": False,
        "executionKind": "direct_job",
        "default_batch_size": 3,
        "batch_size": plan.get("batch_size"),
        "next_action": plan.get("next_action"),
        "stop_reason": plan.get("stop_reason") or "",
        "written_chapter_numbers": plan.get("written_chapter_numbers") or [],
        "accepted_chapter_numbers": plan.get("accepted_chapter_numbers") or plan.get("written_chapter_numbers") or [],
        "pending_review_chapter_numbers": plan.get("pending_review_chapter_numbers") or [],
        "pending_card_numbers": plan.get("pending_card_numbers") or [],
        "selected_card_numbers": plan.get("selected_card_numbers") or [],
        "blocked_card_numbers": plan.get("blocked_card_numbers") or [],
        "outline_card_states": _build_outline_card_states(plan),
        "outline_diagnostics": _build_outline_diagnostics(plan, book_dir),
        "remaining_executable_after_selected": plan.get("remaining_executable_after_selected") or [],
        "full_batch_available": bool(plan.get("full_batch_available")),
        "replenishment_needed_after_selected_batch": bool(plan.get("replenishment_needed_after_selected_batch")),
        "review_gate_open": bool(plan.get("review_gate_open")),
        "quality_gate_locked": bool(plan.get("quality_gate_locked")),
        "quality_gate_unlocked": bool(plan.get("quality_gate_unlocked")),
        "source_files": {
            "chapter_outline": _file_state(book_dir, "chapter_outline.md"),
            "chapter_draft": _file_state(book_dir, "chapter_draft.md"),
            "chapters": _file_state(book_dir, "chapters"),
        },
        "no_prose_boundary": {
            "state_contains_generated_prose": False,
            "state_mutates_chapter_outline": False,
            "state_writes_chapter_draft": False,
            "continuation_agent_remains_only_chapter_draft_writer": True,
        },
    }


def _brief_text(value: Any, *, limit: int = 220) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _brief_chapter_cards(plan: dict[str, Any]) -> list[dict[str, Any]]:
    selected_numbers = set(plan.get("selected_card_numbers") or [])
    cards: list[dict[str, Any]] = []
    for card in plan.get("selected_cards") or []:
        if not isinstance(card, dict):
            continue
        number = card.get("number")
        if number not in selected_numbers:
            continue
        fields = card.get("fields") if isinstance(card.get("fields"), dict) else {}
        cards.append(
            {
                "number": number,
                "title": _brief_text(card.get("title"), limit=80),
                "goal": _brief_text(fields.get("chapter_goal")),
                "entry_scene": _brief_text(fields.get("entry_scene")),
                "conflict": _brief_text(fields.get("conflict_or_obstacle")),
                "payoff": _brief_text(fields.get("payoff")),
                "state_change": _brief_text(fields.get("state_change")),
                "hook": _brief_text(fields.get("ending_hook")),
                "constraint_refs": _brief_text(fields.get("constraint_refs")),
                "evidence_mode": _brief_text(fields.get("evidence_mode"), limit=120),
            }
        )
    return cards


def _card_brief(card: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(card, dict):
        return {}
    fields = card.get("fields") if isinstance(card.get("fields"), dict) else {}
    return {
        "number": card.get("number"),
        "title": _brief_text(card.get("title"), limit=80),
        "heading_line": card.get("heading_line") or 0,
        "end_line": card.get("end_line") or 0,
        "executable": bool(card.get("executable")),
        "missing_fields": list(card.get("missing_fields") or []),
        "fields": {
            key: _brief_text(value, limit=260)
            for key, value in fields.items()
        },
    }


def _neighbor_cards(plan: dict[str, Any], target_number: int | None, *, radius: int = 2) -> list[dict[str, Any]]:
    cards = [card for card in plan.get("cards") or [] if isinstance(card, dict)]
    if target_number is None:
        return [_card_brief(card) for card in cards[: radius * 2 + 1]]
    target_index = next(
        (index for index, card in enumerate(cards) if card.get("number") == target_number),
        -1,
    )
    if target_index < 0:
        return []
    start = max(0, target_index - radius)
    end = min(len(cards), target_index + radius + 1)
    return [_card_brief(card) for card in cards[start:end]]


def _blocked_cards(plan: dict[str, Any]) -> list[dict[str, Any]]:
    blocked_numbers = set(plan.get("blocked_card_numbers") or [])
    cards = [
        card for card in plan.get("cards") or []
        if isinstance(card, dict) and card.get("number") in blocked_numbers
    ]
    return [_card_brief(card) for card in cards]


def _last_accepted_cards(plan: dict[str, Any], *, limit: int = 3) -> list[dict[str, Any]]:
    accepted_numbers = set(plan.get("accepted_chapter_numbers") or plan.get("written_chapter_numbers") or [])
    cards = [
        card for card in plan.get("cards") or []
        if isinstance(card, dict) and card.get("number") in accepted_numbers
    ]
    cards = sorted(cards, key=lambda item: int(item.get("number") or 0))
    return [_card_brief(card) for card in cards[-limit:]]


def _build_outline_handoff_brief(*, plan: dict[str, Any], mode: str, generated_at: str) -> dict[str, Any]:
    blocked = _blocked_cards(plan)
    first_blocked_number = blocked[0].get("number") if blocked else None
    known_numbers = [
        number for number in (
            list(plan.get("pending_card_numbers") or [])
            + list(plan.get("selected_card_numbers") or [])
            + list(plan.get("accepted_chapter_numbers") or plan.get("written_chapter_numbers") or [])
            + list(plan.get("pending_review_chapter_numbers") or [])
            + [
                card.get("number") for card in plan.get("cards") or []
                if isinstance(card, dict)
            ]
        )
        if isinstance(number, int)
    ]
    return {
        "schema_version": 1,
        "brief_type": "rolling_outline_handoff_brief",
        "mode": mode,
        "generated_at": generated_at,
        "book_id": plan.get("book_id"),
        "target_file": "chapter_outline.md",
        "route_agent_key": "outline_agent",
        "progress_cursor": {
            "batch_size": plan.get("batch_size"),
            "next_action": plan.get("next_action"),
            "stop_reason": plan.get("stop_reason") or "",
            "accepted_chapter_numbers": plan.get("accepted_chapter_numbers") or [],
            "pending_review_chapter_numbers": plan.get("pending_review_chapter_numbers") or [],
            "pending_card_numbers": plan.get("pending_card_numbers") or [],
            "selected_card_numbers": plan.get("selected_card_numbers") or [],
            "blocked_card_numbers": plan.get("blocked_card_numbers") or [],
            "remaining_executable_after_selected": plan.get("remaining_executable_after_selected") or [],
        },
        "repair_scope": {
            "blocked_cards": blocked,
            "neighbor_cards": _neighbor_cards(plan, first_blocked_number),
            "repair_existing_card_first": mode == "repair",
            "missing_fields": sorted({field for card in blocked for field in card.get("missing_fields") or []}),
        },
        "replenish_scope": {
            "last_accepted_cards": _last_accepted_cards(plan),
            "last_known_outline_cards": [_card_brief(card) for card in (plan.get("cards") or [])[-3:] if isinstance(card, dict)],
            "desired_new_batch_size": plan.get("batch_size") or 3,
            "start_after_chapter": max(known_numbers or [0]),
        },
        "source_files_to_read": [
            "chapter_outline.md",
            "arc_outline.md",
            "master_outline.md",
            "brainstorm.md",
            "summary.md",
            "status_card.md",
            "world_model.md",
            "domain_rules.md",
            "style_constraints_for_continuation.md",
            "error_archive.md",
        ],
        "write_contract": {
            "where_to_write": "只允许通过大纲路由提交 chapter_outline.md 的可审阅草稿。",
            "repair_rule": "修复模式优先补齐或重写原编号章节卡，不要为了绕过错误而新造章节编号。",
            "replenish_rule": "补卡模式只在章节卡耗尽或不足时续写下一批章节卡。",
            "what_not_to_do": [
                "不要写 chapter_draft.md 或 chapters/*.md。",
                "不要生成小说正文。",
                "不要把 WORLD_MODEL_REQUIRED 当成已确认世界观事实。",
                "不要清空或物理删除已消耗章节卡。",
            ],
        },
        "no_prose_boundary": {
            "brief_contains_generated_prose": False,
            "brief_writes_files": False,
            "backend_mutates_chapter_outline": False,
            "outline_agent_owns_reviewable_outline_edits": True,
            "continuation_agent_remains_only_chapter_draft_writer": True,
        },
    }


def _build_outline_handoff_intent(*, brief: dict[str, Any]) -> str:
    mode = brief.get("mode")
    if mode == "repair":
        action_line = "请修复当前不可执行的逐章大纲卡，优先补齐原编号章节卡缺失字段。"
    else:
        action_line = "请在现有逐章大纲之后生成下一批可执行章节卡。"
    brief_json = json.dumps(brief, ensure_ascii=False, sort_keys=True)
    return (
        "【滚动三章工作台：大纲交接任务】\n"
        "本任务由前台按钮触发，不是闲聊。请按 outline Agent 的既有读写工具链执行。\n"
        f"{action_line}\n"
        "你必须读取 chapter_outline.md、arc_outline.md、master_outline.md、brainstorm.md、summary.md、"
        "status_card.md、world_model.md、domain_rules.md、style_constraints_for_continuation.md 和 error_archive.md。\n"
        "只允许提交 chapter_outline.md 的可审阅草稿；不要写 chapter_draft.md，不要写 chapters/*.md，不要生成正文。\n"
        "修复章节卡时，优先保留原章节编号和章节意图，只补齐缺失字段或规整格式；不要为了绕过错误新造编号。\n"
        "生成下一批章节卡时，延续现有编号、节奏、冲突、兑现、状态变化和钩子，不要清空旧卡。\n"
        "如果新增设定需要世界模型确认，请标记为 WORLD_MODEL_REQUIRED，不要当成已确认事实。\n"
        "完成后只返回简短状态，让前端刷新滚动队列。\n\n"
        "rolling_outline_handoff_brief JSON：\n"
        f"{brief_json}"
    )


def _truth_source_list(context_pack: dict[str, Any]) -> list[dict[str, Any]]:
    refs = context_pack.get("truth_source_refs") if isinstance(context_pack.get("truth_source_refs"), dict) else {}
    sources: list[dict[str, Any]] = []
    for name, ref in refs.items():
        if isinstance(ref, dict):
            sources.append(
                {
                    "name": name,
                    "path": ref.get("path") or name,
                    "role": ref.get("role") or "",
                    "exists": bool(ref.get("exists", True)),
                    "contains_prose": False,
                }
            )
        elif isinstance(ref, list):
            sources.append(
                {
                    "name": name,
                    "path": "",
                    "role": "evidence_list",
                    "exists": bool(ref),
                    "contains_prose": False,
                }
            )
    return sources


def _build_author_writing_brief(
    *,
    plan: dict[str, Any],
    context_pack: dict[str, Any],
    generated_at: str,
) -> dict[str, Any]:
    selected_numbers = [
        number for number in plan.get("selected_card_numbers") or []
        if isinstance(number, int)
    ]
    quality_gate = context_pack.get("quality_gate") if isinstance(context_pack.get("quality_gate"), dict) else {}
    style_advisory = context_pack.get("style_advisory") if isinstance(context_pack.get("style_advisory"), dict) else {}
    active_repair = (
        context_pack.get("active_repair_goals")
        if isinstance(context_pack.get("active_repair_goals"), dict)
        else {}
    )
    quality_summary = quality_gate.get("summary") if isinstance(quality_gate.get("summary"), dict) else {}
    style_summary = style_advisory.get("summary") if isinstance(style_advisory.get("summary"), dict) else {}

    return {
        "schema_version": 1,
        "brief_type": "rolling_author_writing_brief",
        "generated_at": generated_at,
        "book_id": plan.get("book_id"),
        "target_file": "chapter_draft.md",
        "route_agent_key": "continuation_agent",
        "batch": {
            "batch_size": plan.get("batch_size"),
            "selected_card_numbers": selected_numbers,
            "full_batch_available": bool(plan.get("full_batch_available")),
            "remaining_executable_after_selected": plan.get("remaining_executable_after_selected") or [],
        },
        "progress_cursor": {
            "accepted_chapter_numbers": plan.get("accepted_chapter_numbers") or [],
            "pending_review_chapter_numbers": plan.get("pending_review_chapter_numbers") or [],
            "pending_card_numbers": plan.get("pending_card_numbers") or [],
            "next_action": plan.get("next_action"),
            "stop_reason": plan.get("stop_reason") or "",
        },
        "chapter_cards": _brief_chapter_cards(plan),
        "writing_contract": {
            "what_to_write": "只执行本轮 selected_card_numbers 对应的逐章大纲卡。",
            "where_to_write": "只允许 continuation Agent 写入 chapter_draft.md。",
            "what_not_to_do": [
                "不要改写 chapter_outline.md、summary.md、world_model.md、status_card.md、domain_rules.md、style 文件或 error_archive.md。",
                "不要自行补造未列入 selected_card_numbers 的新章节卡。",
                "不要把 WORLD_MODEL_REQUIRED 提案当成已确认世界观事实。",
            ],
        },
        "truth_sources": _truth_source_list(context_pack),
        "quality_and_style": {
            "quality_gate_locked": bool(quality_gate.get("locked")),
            "quality_gate_blocks_next_action": bool(quality_gate.get("blocks_next_action")),
            "quality_gate_summary": quality_summary,
            "style_advisory_active": bool(style_advisory.get("active")),
            "style_is_reference_only": bool(style_advisory.get("reference_only", True)),
            "style_summary": style_summary,
            "repair_goals": {
                "protocol": active_repair.get("protocol"),
                "proxy_repair_goals": active_repair.get("proxy_repair_goals") or [],
                "protected_metrics": active_repair.get("protected_metrics") or [],
                "stop_conditions": active_repair.get("stop_conditions") or {},
            },
        },
        "no_prose_boundary": {
            "brief_contains_generated_prose": False,
            "brief_reads_chapter_draft_text": False,
            "brief_writes_files": False,
            "continuation_agent_remains_only_chapter_draft_writer": True,
        },
    }


def _build_continuation_intent(*, plan: dict[str, Any], context_pack: dict[str, Any]) -> str:
    selected_numbers = [
        number for number in plan.get("selected_card_numbers") or []
        if isinstance(number, int)
    ]
    context_json = json.dumps(context_pack, ensure_ascii=False, sort_keys=True)
    selected_label = "、".join(str(number) for number in selected_numbers) or "无"
    batch_size = plan.get("batch_size") or 3
    return (
        "【滚动续写工作台任务】\n"
        "本次任务由前台按钮触发，不是聊天闲聊；请按项目 continuation Agent 的既有工具链执行。\n"
        "你必须自己读取 chapter_draft.md、chapter_outline.md、summary.md、status_card.md、world_model.md、"
        "domain_rules.md、error_archive.md、style_guide.md 与 style_constraints_for_continuation.md。\n"
        "只允许把正文写入 chapter_draft.md；不要修改 chapter_outline.md、summary.md、status_card.md、"
        "world_model.md、domain_rules.md、error_archive.md、style_guide.md 或 style_constraints_for_continuation.md。\n"
        f"本轮默认批量上限为 {batch_size} 章；本次只写 selected_card_numbers 中列出的章节：{selected_label}。\n"
        "如果 selected_card_numbers 少于三章，只写列出的章节；不要自行补造新的章节卡。\n"
        "写作时以逐章大纲、摘要事实、世界模型、状态卡、领域规则和错误档案为最高边界。\n"
        "文风只按“作者文风偏好 > 续写文风参考卡 > 最新原文样本”的顺序作为软参考，"
        "只调整语言质感、段落节奏、对白/动作/环境/解释比例和信息释放；"
        "不得改变章卡目标、剧情事实、人物动机、世界状态、胜负结果或因果链，也不要因文风提示卡死调度。\n"
        "写完后保持草稿进入审查工作台；最终回答只给简短状态，不要把整章正文粘贴到回答里。\n\n"
        "chapter_context_pack JSON：\n"
        f"{context_json}"
    )


def create_blueprint(
    *,
    storage_root: str,
    require_book_id: Callable[[dict | None], tuple[str | None, tuple | None]],
    json_error: Callable[[str, str, int], tuple],
) -> Blueprint:
    bp = Blueprint("rolling", __name__)

    @bp.get("/api/rolling/state")
    def rolling_state():
        book_id, book_err = require_book_id()
        if book_err:
            return book_err
        assert book_id is not None

        paths = get_book_paths(book_id, storage_root)
        book_dir = paths["book_dir"]
        if not os.path.isdir(book_dir):
            return json_error("BOOK_NOT_FOUND", "book not found", 404)

        batch_size = _coerce_batch_size(request.args.get("batch_size"))
        review_gate_open = request.args.get("review_gate") != "closed"

        try:
            plan = build_rolling_plan(
                book_id=book_id,
                book_dir=book_dir,
                batch_size=batch_size,
                review_gate_open=review_gate_open,
            )
        except ValueError as exc:
            return json_error("INVALID_PAYLOAD", str(exc), 400)

        return (
            jsonify(
                {
                    "status": "success",
                    "book_id": book_id,
                    "generated_at": _iso_now(),
                    "workbench_state": _build_workbench_state(plan, book_dir),
                    "plan": plan,
                }
            ),
            200,
        )

    @bp.post("/api/rolling/continuation_payload")
    def rolling_continuation_payload():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            payload = {}
        book_id, book_err = require_book_id(payload)
        if book_err:
            return book_err
        assert book_id is not None

        paths = get_book_paths(book_id, storage_root)
        book_dir = paths["book_dir"]
        if not os.path.isdir(book_dir):
            return json_error("BOOK_NOT_FOUND", "book not found", 404)

        batch_size = _coerce_batch_size(payload.get("batch_size"))
        review_gate_open = payload.get("review_gate") != "closed"
        try:
            plan = build_rolling_plan(
                book_id=book_id,
                book_dir=book_dir,
                batch_size=batch_size,
                review_gate_open=review_gate_open,
            )
        except ValueError as exc:
            return json_error("INVALID_PAYLOAD", str(exc), 400)

        if plan.get("next_action") != "continue_existing_cards":
            return (
                jsonify(
                    {
                        "status": "error",
                        "code": "ROLLING_NOT_READY",
                        "message": f"rolling workbench is not ready to continue: {plan.get('next_action')}",
                        "book_id": book_id,
                        "next_action": plan.get("next_action"),
                        "stop_reason": plan.get("stop_reason") or "",
                        "workbench_state": _build_workbench_state(plan, book_dir),
                        "plan": plan,
                    }
                ),
                409,
            )

        generated_at = _iso_now()
        context_pack = build_chapter_context_pack(
            plan=plan,
            book_dir=book_dir,
            generated_at=generated_at,
            pack_id=f"rolling-continuation-{generated_at}",
        )
        author_writing_brief = _build_author_writing_brief(
            plan=plan,
            context_pack=context_pack,
            generated_at=generated_at,
        )
        chapter_number = context_pack.get("chapter_number")
        return (
            jsonify(
                {
                    "status": "success",
                    "book_id": book_id,
                    "generated_at": generated_at,
                    "chapter_number": chapter_number if isinstance(chapter_number, int) else 0,
                    "target_file": "chapter_draft.md",
                    "route_agent_key": "continuation_agent",
                    "file_type": "chapter",
                    "write_scope": "active_file_strict",
                    "dify_user": "loregit-ui-rolling-continuation",
                    "intent": _build_continuation_intent(plan=plan, context_pack=context_pack),
                    "workbench_state": _build_workbench_state(plan, book_dir),
                    "chapter_context_pack": context_pack,
                    "author_writing_brief": author_writing_brief,
                    "no_prose_boundary": {
                        "payload_contains_generated_prose": False,
                        "payload_writes_chapter_draft": False,
                        "continuation_agent_remains_only_chapter_draft_writer": True,
                    },
                    "plan": plan,
                }
            ),
            200,
        )

    @bp.post("/api/rolling/outline_handoff_payload")
    def rolling_outline_handoff_payload():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            payload = {}
        book_id, book_err = require_book_id(payload)
        if book_err:
            return book_err
        assert book_id is not None

        paths = get_book_paths(book_id, storage_root)
        book_dir = paths["book_dir"]
        if not os.path.isdir(book_dir):
            return json_error("BOOK_NOT_FOUND", "book not found", 404)

        batch_size = _coerce_batch_size(payload.get("batch_size"))
        review_gate_open = payload.get("review_gate") != "closed"
        try:
            plan = build_rolling_plan(
                book_id=book_id,
                book_dir=book_dir,
                batch_size=batch_size,
                review_gate_open=review_gate_open,
            )
        except ValueError as exc:
            return json_error("INVALID_PAYLOAD", str(exc), 400)

        next_action = plan.get("next_action")
        if next_action not in {"repair_outline_cards", "replenish_outline"}:
            return (
                jsonify(
                    {
                        "status": "error",
                        "code": "ROLLING_OUTLINE_HANDOFF_NOT_NEEDED",
                        "message": f"rolling workbench does not need outline handoff: {next_action}",
                        "book_id": book_id,
                        "next_action": next_action,
                        "stop_reason": plan.get("stop_reason") or "",
                        "workbench_state": _build_workbench_state(plan, book_dir),
                        "plan": plan,
                    }
                ),
                409,
            )

        mode = "repair" if next_action == "repair_outline_cards" else "replenish"
        generated_at = _iso_now()
        brief = _build_outline_handoff_brief(plan=plan, mode=mode, generated_at=generated_at)
        return (
            jsonify(
                {
                    "status": "success",
                    "book_id": book_id,
                    "generated_at": generated_at,
                    "mode": mode,
                    "target_file": "chapter_outline.md",
                    "route_agent_key": "outline_agent",
                    "file_type": "outline",
                    "write_scope": "active_file_strict",
                    "dify_user": f"loregit-ui-rolling-outline-{mode}",
                    "intent": _build_outline_handoff_intent(brief=brief),
                    "workbench_state": _build_workbench_state(plan, book_dir),
                    "outline_handoff_brief": brief,
                    "no_prose_boundary": {
                        "payload_contains_generated_prose": False,
                        "payload_mutates_chapter_outline": False,
                        "payload_writes_chapter_draft": False,
                        "outline_agent_owns_reviewable_outline_edits": True,
                        "continuation_agent_remains_only_chapter_draft_writer": True,
                    },
                    "plan": plan,
                }
            ),
            200,
        )

    return bp
