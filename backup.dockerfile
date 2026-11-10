FROM alpine:3

# Install zstd for modern, fast compression
RUN apk add --no-cache zstd

# Accept operation type as build argument
ARG OPERATION
ENV OPERATION=${OPERATION}

# Use sh -c to allow variable expansion in JSON format
ENTRYPOINT ["/bin/sh", "-c", "/script/backup.sh $OPERATION"]
