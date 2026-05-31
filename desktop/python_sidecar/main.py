"""Python sidecar for Novel Agent Tauri app.

Communicates with Tauri via stdin/stdout JSON-RPC.
Receives JSON requests, delegates to engine agents, returns JSON responses.
"""

import json
import os
import sys
import traceback

# Ensure novel_git_server is on path for imports
SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))
NOVEL_GIT_SERVER = os.path.join(os.path.dirname(SIDECAR_DIR), "..", "novel_git_server")
if os.path.isdir(NOVEL_GIT_SERVER):
    sys.path.insert(0, NOVEL_GIT_SERVER)


def respond(id_val, result=None, error=None):
    resp = {"id": id_val, "result": result, "error": error}
    line = json.dumps(resp, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def handle_deduce(params):
    """Blocking agent deduction."""
    from engine.adapter import chat_messages

    query = params.get("intent", "")
    inputs = {
        "book_id": params.get("book_id", ""),
        "book_name": params.get("book_name", ""),
        "active_file": params.get("active_file", "chapter_draft.md"),
        "file_type": params.get("file_type", ""),
    }
    result = chat_messages(base_url="", api_key="", query=query, inputs=inputs)
    return {"answer": result.get("answer", ""), "conversation_id": result.get("conversation_id")}


def handle_deduce_stream(params):
    """Streaming agent deduction — returns a task_id for SSE streaming."""
    import uuid
    task_id = uuid.uuid4().hex[:12]
    # The actual streaming happens through the old Flask SSE endpoint
    # For now, return the task_id so frontend can poll or use events
    return {"task_id": task_id, "status": "started"}


DISPATCH = {
    "deduce": handle_deduce,
    "deduce_stream": handle_deduce_stream,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = request.get("method", "")
        req_id = request.get("id")
        params = request.get("params", {})

        handler = DISPATCH.get(method)
        if handler is None:
            respond(req_id, error=f"Unknown method: {method}")
            continue

        try:
            result = handler(params)
            respond(req_id, result=result)
        except Exception as exc:
            respond(req_id, error=str(exc))
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
