#!/bin/sh
set -eu
case "${UFM_ROLE:-api}" in
  api) jar=/app/ufm-api.jar ;;
  worker) jar=/app/ufm-worker.jar ;;
  recovery)
    : "${UFM_RECOVERY_BACKUP:?Provide backup UUID}"
    [ "${UFM_RECOVERY_CONFIRM:-}" = RESTORE ] || { echo 'Set UFM_RECOVERY_CONFIRM=RESTORE' >&2; exit 64; }
    exec java -Djava.io.tmpdir=/data/tmp -Dloader.main=com.ufm.backup.RecoveryCommand -cp /app/ufm-api.jar org.springframework.boot.loader.launch.PropertiesLauncher "$UFM_RECOVERY_BACKUP" RESTORE
    ;;
  *) echo 'UFM_ROLE must be api or worker' >&2; exit 64 ;;
esac
exec java -Djava.io.tmpdir=/data/tmp -jar "$jar"
