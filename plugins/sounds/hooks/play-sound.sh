#!/bin/bash
# Sound effects
# Plays OS-native sounds for different events
# Inspired to https://www.claudedirectory.org/hooks/claudio

play_sound() {
  local sound_name="$1"

  # macOS
  if [[ "$OSTYPE" == "darwin"* ]]; then
    case "$sound_name" in
      "task_complete") afplay /System/Library/Sounds/Tink.aiff ;;
      "session_end") afplay /System/Library/Sounds/Frog.aiff ;;
      "error") afplay /System/Library/Sounds/Basso.aiff ;;
      "notification") afplay /System/Library/Sounds/Pop.aiff ;;
    esac
  fi

  # Linux (using paplay if available)
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v paplay &> /dev/null; then
      case "$sound_name" in
        "task_complete") paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null ;;
        "session_end") paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null ;;
        "error") paplay /usr/share/sounds/freedesktop/stereo/dialog-error.oga 2>/dev/null ;;
        "notification") paplay /usr/share/sounds/freedesktop/stereo/message.oga 2>/dev/null ;;
      esac
    fi
  fi
}

play_sound $1
