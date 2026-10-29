@echo off
setlocal
if "%~1"=="" (
  echo Usage: run_laptop2.bat COORDINATOR_IP
  exit /b 1
)
.venv\Scripts\python.exe -m edge_mesh --name Laptop-2 --port 5001 --token demo123 --peer %~1:5000
