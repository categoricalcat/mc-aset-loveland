FROM alpine:3

# zstd for tar archives, restic for incremental shadow backups,
# pv + coreutils (GNU du --exclude) for progress reporting
RUN apk add --no-cache zstd restic pv coreutils tar

# OPERATION comes from compose env (or argv), so one image serves all three services
ENTRYPOINT ["/bin/sh", "/script/backup.sh"]
