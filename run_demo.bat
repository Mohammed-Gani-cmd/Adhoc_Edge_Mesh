@echo off
setlocal
if not exist .venv\Scripts\python.exe (
  echo Virtual environment not found.
  echo Run: python -m venv .venv
  echo Then: .venv\Scripts\pip.exe install -r requirements.txt
  exit /b 1
)
.venv\Scripts\python.exe -m edge_mesh --name Laptop-1 --port 5000 --token demo123
