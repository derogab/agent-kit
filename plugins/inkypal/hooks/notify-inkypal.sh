#!/usr/bin/env bash
# Notify InkyPal when a task finish.
# Reads the Stop-hook JSON from stdin, extracts a short summary from the
# last assistant message in the transcript, picks a face based on tone,
# and POSTs to InkyPal with bypass_ai=true so the raw text is shown.
#
# Required env: INKYPAL_HOST, INKYPAL_PORT
# No-ops silently if either is unset or InkyPal is unreachable.

set -u

INPUT="$(cat)"

if [ -z "${INKYPAL_HOST:-}" ] || [ -z "${INKYPAL_PORT:-}" ]; then
  exit 0
fi

TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)"

LAST_TEXT=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  LAST_TEXT="$(jq -rs '
    [ .[]
      | select(.message.role? == "assistant")
      | [ .message.content[]? | select(.type == "text") | .text ]
      | join(" ")
      | select(length > 0)
    ] | last // ""
  ' "$TRANSCRIPT" 2>/dev/null)"
fi

CONTENT="$(printf '%s' "$LAST_TEXT" | tr '\n\r\t' '   ' | sed -E 's/  +/ /g; s/^ +//; s/ +$//')"
[ -z "$CONTENT" ] && CONTENT="Task done"

MAX=80
if [ "${#CONTENT}" -gt "$MAX" ]; then
  CONTENT="$(printf '%s' "$CONTENT" | cut -c1-$((MAX - 1)))…"
fi

LOWER="$(printf '%s' "$CONTENT" | tr '[:upper:]' '[:lower:]')"
case "$LOWER" in
  *error*|*failed*|*failure*|*crash*|*exception*) FACE="debug" ;;
  *cannot*|*can\'t*|*unable*|*sorry*|*blocked*)   FACE="sad" ;;
  *warning*|*warn*|*caution*)                      FACE="alert" ;;
  *done*|*complete*|*completed*|*finished*|*ready*|*shipped*|*merged*) FACE="excited" ;;
  *thanks*|*thank\ you*|*welcome*|*cheers*)        FACE="love" ;;
  *not\ sure*|*unclear*|*confused*|*?\?*)          FACE="curious" ;;
  *)                                                FACE="happy" ;;
esac

BODY="$(jq -nc --arg c "$CONTENT" --arg f "$FACE" '{face: $f, content: $c, bypass_ai: true}')"

curl -sS -m 5 \
  -X POST "http://${INKYPAL_HOST}:${INKYPAL_PORT}/message" \
  -H 'Content-Type: application/json' \
  -d "$BODY" >/dev/null 2>&1 || true

exit 0
