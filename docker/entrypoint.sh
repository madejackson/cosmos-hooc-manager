#!/bin/sh
# Mount the host Docker socket into the container if not already mounted.
# Cosmos mounts /var/run/docker.sock in the template; this is a fallback for
# manual runs.
if [ ! -S /var/run/docker.sock ] && [ -S /host/run/docker.sock ]; then
  ln -sf /host/run/docker.sock /var/run/docker.sock
fi
exec node server/index.js
