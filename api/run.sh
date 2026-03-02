#!/bin/bash
# KoudrsTracking API runner
# Usage: ./run.sh         - Start server
#        ./run.sh clean   - Clean everything, reinstall, and start

# Go to project root (parent of api/)
cd "$(dirname "$0")/.."

# Find Python 3.10+ (required for scrapling)
PYTHON=""
for p in python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v $p &> /dev/null; then
        PYTHON=$p
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "ERROR: Python 3.10+ required. Install with: brew install python@3.12"
    exit 1
fi

echo "Using $PYTHON"

if [ "$1" = "clean" ]; then
    echo "Stopping any running uvicorn processes..."
    pkill -f "uvicorn api.main:app" 2>/dev/null || true

    echo "Cleaning Python cache..."
    find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null
    find . -type f -name "*.pyc" -delete 2>/dev/null
    find . -type f -name "*.pyo" -delete 2>/dev/null
    find . -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null
    rm -rf .pytest_cache .ruff_cache 2>/dev/null

    echo "Removing virtual environment..."
    rm -rf .venv

    echo ""
fi

# Create venv if it doesn't exist
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    $PYTHON -m venv .venv
fi

source .venv/bin/activate

# Install deps if needed
if ! python -c "import fastapi" 2>/dev/null; then
    echo "Installing dependencies..."
    pip install -r requirements.txt -q
fi

echo ""
echo "Starting KoudrsTracking API on http://localhost:8000"
echo "Docs: http://localhost:8000/docs"
echo ""
uvicorn api.main:app --reload --host 0.0.0.0 --port 8000
