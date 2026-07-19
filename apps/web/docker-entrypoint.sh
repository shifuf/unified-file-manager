#!/bin/sh
# Installed as /docker-entrypoint.d/40-ufm-runtime-config.sh
# The official nginx image runs scripts here before starting nginx,
# so ADMIN_LOGIN_PATH from env takes effect on every container start.
set -eu

DEFAULT_PATH="/console-login"
RAW="${ADMIN_LOGIN_PATH:-$DEFAULT_PATH}"
RAW=$(printf '%s' "$RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

case "$RAW" in
  '')
    PATH_VALUE="$DEFAULT_PATH"
    ;;
  /*)
    PATH_VALUE="$RAW"
    ;;
  *)
    PATH_VALUE="/$RAW"
    ;;
esac

PATH_VALUE=$(printf '%s' "$PATH_VALUE" | sed 's|/*$||; s|//*|/|g')
if [ -z "$PATH_VALUE" ] || [ "$PATH_VALUE" = "/" ]; then
  PATH_VALUE="$DEFAULT_PATH"
fi

if ! printf '%s' "$PATH_VALUE" | grep -Eq '^/[A-Za-z0-9][A-Za-z0-9/_-]*$'; then
  echo "WARN: ADMIN_LOGIN_PATH='$RAW' is invalid; falling back to $DEFAULT_PATH" >&2
  PATH_VALUE="$DEFAULT_PATH"
fi

# JSON-escape via printf %s + shell quoting of a single-quoted JS string is unsafe;
# emit a double-quoted JS string with only path-safe characters (already validated).
cat > /usr/share/nginx/html/runtime-config.js <<EOF
/* Generated at container start from ADMIN_LOGIN_PATH. */
window.__UFM_RUNTIME__ = {
  adminLoginPath: "${PATH_VALUE}",
};
EOF

echo "UFM admin login path: ${PATH_VALUE}"
