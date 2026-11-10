FROM alpine:3

# zstd for tar archives, restic for incremental shadow backups,
# pv + coreutils (GNU du --exclude) for progress reporting
RUN apk add --no-cache zstd restic pv coreutils tar

# Accept operation type as build argument
ARG OPERATION
ENV OPERATION=${OPERATION}

# Use sh -c to allow variable expansion in JSON format
ENTRYPOINT ["/bin/sh", "-c", "/script/backup.sh $OPERATION"]
