#!/usr/bin/env bash
# Notify InkyPal on lifecycle events.
# Reads the hook JSON from stdin, picks an event-appropriate face and
# message, and POSTs to InkyPal with bypass_ai=true so the raw text is shown.
#
# Usage: notify-inkypal.sh <event>
#   event: stop | subagent-stop | notification | session-start | session-end
#
# Required env: INKYPAL_HOST, INKYPAL_PORT
# Optional env: INKYPAL_API_KEY (sent as Authorization: Bearer <key>)
# No-ops silently if either required var is unset or InkyPal is unreachable.

set -u

EVENT="${1:-stop}"
INPUT="$(cat)"

if [ -z "${INKYPAL_HOST:-}" ] || [ -z "${INKYPAL_PORT:-}" ]; then
  exit 0
fi

TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)"

extract_last_assistant() {
  local t="$1"
  [ -z "$t" ] || [ ! -f "$t" ] && return
  jq -rs '
    [ .[]
      | select(.message.role? == "assistant")
      | [ .message.content[]? | select(.type == "text") | .text ]
      | join(" ")
      | select(length > 0)
    ] | last // ""
  ' "$t" 2>/dev/null
}

extract_last_user() {
  local t="$1"
  [ -z "$t" ] || [ ! -f "$t" ] && return
  jq -rs '
    [ .[]
      | select(.message.role? == "user")
      | (.message.content // "")
      | if type == "string" then .
        elif type == "array" then [ .[]? | select(.type == "text") | .text ] | join(" ")
        else "" end
      | select(length > 0)
      | select(startswith("<") | not)
    ] | last // ""
  ' "$t" 2>/dev/null
}

pick_face_by_keywords() {
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *error*|*failed*|*failure*|*crash*|*exception*) echo "debug" ;;
    *cannot*|*can\'t*|*unable*|*sorry*|*blocked*)   echo "sad" ;;
    *warning*|*warn*|*caution*)                      echo "alert" ;;
    *done*|*complete*|*completed*|*finished*|*ready*|*shipped*|*merged*) echo "excited" ;;
    *thanks*|*thank\ you*|*welcome*|*cheers*)        echo "love" ;;
    *not\ sure*|*unclear*|*confused*|*?\?*)          echo "curious" ;;
    *)                                                echo "happy" ;;
  esac
}

CONTENT=""
FACE=""

case "$EVENT" in
  stop)
    PROMPT_TEXT="$(extract_last_user "$TRANSCRIPT")"
    RESULT_TEXT="$(extract_last_assistant "$TRANSCRIPT")"
    if [ -n "$PROMPT_TEXT" ] && [ -n "$RESULT_TEXT" ]; then
      CONTENT="$PROMPT_TEXT -> $RESULT_TEXT"
    elif [ -n "$RESULT_TEXT" ]; then
      CONTENT="$RESULT_TEXT"
    elif [ -n "$PROMPT_TEXT" ]; then
      CONTENT="Done: $PROMPT_TEXT"
    else
      CONTENT="Task done"
    fi
    FACE="$(pick_face_by_keywords "${RESULT_TEXT:-$CONTENT}")"
    ;;
  subagent-stop)
    RESULT_TEXT="$(extract_last_assistant "$TRANSCRIPT")"
    CONTENT="${RESULT_TEXT:-Subagent done}"
    FACE="cool"
    ;;
  notification)
    MSG="$(printf '%s' "$INPUT" | jq -r '.message // empty' 2>/dev/null)"
    CONTENT="${MSG:-Agent needs your attention}"
    FACE="alert"
    ;;
  session-start)
    SOURCE="$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null)"
    case "$SOURCE" in
      resume)  CONTENT="Session resumed" ;;
      clear)   CONTENT="Session cleared" ;;
      compact) CONTENT="Session compacted" ;;
      *)       CONTENT="Session started" ;;
    esac
    FACE="happy"
    ;;
  session-end)
    REASON="$(printf '%s' "$INPUT" | jq -r '.reason // empty' 2>/dev/null)"
    if [ -n "$REASON" ]; then
      CONTENT="Session ended: $REASON"
    else
      CONTENT="Session ended"
    fi
    FACE="sleepy"
    ;;
  *)
    exit 0
    ;;
esac

CONTENT="$(printf '%s' "$CONTENT" | tr '\n\r\t' '   ' | sed -E 's/  +/ /g; s/^ +//; s/ +$//')"
[ -z "$CONTENT" ] && exit 0

MAX=80
if [ "${#CONTENT}" -gt "$MAX" ]; then
  CONTENT="$(printf '%s' "$CONTENT" | cut -c1-$((MAX - 1)))…"
fi

BODY="$(jq -nc --arg c "$CONTENT" --arg f "$FACE" '{face: $f, content: $c, bypass_ai: true}')"

AUTH_ARGS=()
if [ -n "${INKYPAL_API_KEY:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${INKYPAL_API_KEY}")
fi

curl -sS -m 5 \
  -X POST "http://${INKYPAL_HOST}:${INKYPAL_PORT}/message" \
  -H 'Content-Type: application/json' \
  "${AUTH_ARGS[@]}" \
  -d "$BODY" >/dev/null 2>&1 || true

exit 0
