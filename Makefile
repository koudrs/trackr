# KoudrsTracking Makefile
# Usage: make <target>

.PHONY: help install dev test lint run health clean

# Default target
help:
	@echo "KoudrsTracking API - Available commands:"
	@echo ""
	@echo "  make install     - Install production dependencies"
	@echo "  make dev         - Install development dependencies"
	@echo "  make test        - Run unit tests"
	@echo "  make test-live   - Run live carrier tests"
	@echo "  make lint        - Run linter (ruff)"
	@echo "  make run         - Start the API server"
	@echo "  make health      - Check API health"
	@echo "  make clean       - Remove cache and build files"
	@echo ""

# Install production dependencies
install:
	pip install -r requirements.txt
	scrapling install

# Install development dependencies
dev:
	pip install -r requirements-dev.txt
	scrapling install

# Run unit tests
test:
	pytest tests/ -v

# Run tests with coverage
test-cov:
	pytest tests/ -v --cov=api --cov-report=term-missing

# Run live carrier integration tests
test-live:
	python scripts/test_carriers_live.py

# Run linter
lint:
	ruff check api/ tests/
	ruff format --check api/ tests/

# Format code
format:
	ruff format api/ tests/
	ruff check --fix api/ tests/

# Start API server
run:
	uvicorn api.main:app --reload --host 0.0.0.0 --port 8000

# Start API server (production)
run-prod:
	uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers 4

# Check API health
health:
	python scripts/health_check.py -v

# Quick health check (for cron)
health-quick:
	python scripts/health_check.py

# Clean cache and build files
clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .ruff_cache -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true
	rm -rf build/ dist/ *.egg-info/ 2>/dev/null || true

# Type checking
typecheck:
	mypy api/
