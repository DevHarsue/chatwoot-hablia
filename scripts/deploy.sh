#!/bin/bash
set -e

IMAGE="devharsue/chatwoot-hablia:testing"

echo "=== Building image ==="
docker build -f docker/Dockerfile -t "devharsue/chatwoot-hablia:testing" .

echo ""
echo "=== Pushing to Docker Hub ==="
docker push "$IMAGE"

echo ""
echo "=== Done! Image pushed: $IMAGE ==="
