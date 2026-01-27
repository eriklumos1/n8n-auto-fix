#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PORT=3456
NGROK_DOMAIN="unvacated-winifred-irenically.ngrok-free.dev"

cleanup() {
  echo ""
  echo "Shutting down..."
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$NGROK_PID" ]; then
    kill "$NGROK_PID" 2>/dev/null || true
  fi
  exit 0
}

trap cleanup SIGINT SIGTERM

echo "==================================="
echo "  n8n Auto-Fix System"
echo "==================================="
echo ""

# Start the Node.js server
echo "Starting auto-fix server on port $PORT..."
node "$SCRIPT_DIR/server.js" &
SERVER_PID=$!

# Give server a moment to start
sleep 1

# Check if server started
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "ERROR: Server failed to start"
  exit 1
fi

echo "Server started (PID: $SERVER_PID)"

# Start ngrok
echo "Starting ngrok tunnel..."
ngrok http "$PORT" --url "$NGROK_DOMAIN" &
NGROK_PID=$!

sleep 2

if ! kill -0 "$NGROK_PID" 2>/dev/null; then
  echo "ERROR: ngrok failed to start"
  kill "$SERVER_PID" 2>/dev/null || true
  exit 1
fi

echo ""
echo "==================================="
echo "  System Running"
echo "==================================="
echo "  Local:  http://localhost:$PORT"
echo "  Public: https://$NGROK_DOMAIN"
echo "  Health: http://localhost:$PORT/health"
echo ""
echo "  Press Ctrl+C to stop"
echo "==================================="
echo ""

# Wait for either process to exit
wait -n "$SERVER_PID" "$NGROK_PID" 2>/dev/null || wait
cleanup
