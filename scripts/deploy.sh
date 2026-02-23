#!/bin/bash
set -e

IMAGE="devharsue/chatwoot-hablia:testing"

echo "=== Building image ==="
docker build -t "$IMAGE" .

echo ""
echo "=== Pushing to Docker Hub ==="
docker push "$IMAGE"

echo ""
echo "=== Done! Image pushed: $IMAGE ==="
