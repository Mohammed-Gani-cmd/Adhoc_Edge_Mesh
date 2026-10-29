#!/usr/bin/env bash
set -e
if [ -z "$1" ]; then echo "Usage: ./run_laptop3.sh COORDINATOR_IP"; exit 1; fi
.venv/bin/python -m edge_mesh --name Laptop-3 --port 5002 --token demo123 --peer "$1:5000"
