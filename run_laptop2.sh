#!/usr/bin/env bash
set -e
if [ -z "$1" ]; then echo "Usage: ./run_laptop2.sh COORDINATOR_IP"; exit 1; fi
.venv/bin/python -m edge_mesh --name Laptop-2 --port 5001 --token demo123 --peer "$1:5000"
